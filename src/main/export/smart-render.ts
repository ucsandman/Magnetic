import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { ipcMain, type WebContents } from 'electron'
import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
  createWriteStream,
  type WriteStream
} from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { IPC } from '../../shared/channels'
import { getStore } from '../app-state'
import { ffmpegPath } from '../binaries'

/**
 * Smart-render export (video passthrough): the renderer streams the mixed
 * audio as Int16 PCM chunks which are appended to a temp wav next to the
 * destination, then ONE ffmpeg run stream-copies the H.264 bitstream
 * (-c:v copy — no decode, no re-encode) and encodes only the audio. A 6-hour
 * VOD export runs at roughly disk speed instead of re-encoding 648k frames.
 *
 * Wav size strategy: the header is written with placeholder sizes and the
 * RIFF/data size fields are patched when the stream closes. Past 4 GB the
 * fields saturate at 0xFFFFFFFF (no RF64): ffmpeg is the only reader, reads
 * the file once immediately, and its wav demuxer ignores a bogus/overflowing
 * declared size and reads to EOF — the same distrust pcm-source.ts applies to
 * ffmpeg's own >4 GB wavs.
 *
 * Trim accuracy: -ss is placed BEFORE -i, which for stream copy snaps to the
 * previous keyframe — the output can start up to one GOP early (≤ a few
 * seconds of head slack). Accepted for v1 per the long-form pipeline spec;
 * frame-exact passthrough needs segment-level smart render (out of scope).
 */

const WAV_HEADER_BYTES = 44
const UINT32_MAX = 0xffffffff

const startSchema = z.object({
  destination: z.string().min(1),
  assetId: z.string().min(1),
  inSec: z.number().nonnegative(),
  durSec: z.number().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().min(1).max(2)
})

interface SmartSession {
  destination: string
  partPath: string
  mixPath: string
  sourcePath: string
  inSec: number
  durSec: number
  mix: WriteStream
  dataBytes: number
  ffmpeg: ChildProcessWithoutNullStreams | null
}

let session: SmartSession | null = null

function wavHeader(sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(0, 4) // RIFF size — patched at finalize
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(0, 40) // data size — patched at finalize
  return header
}

/** Patch the RIFF/data size fields in place (saturating at uint32 max). */
function patchWavSizes(mixPath: string, dataBytes: number): void {
  const riff = Buffer.alloc(4)
  riff.writeUInt32LE(Math.min(UINT32_MAX, 36 + dataBytes), 0)
  const data = Buffer.alloc(4)
  data.writeUInt32LE(Math.min(UINT32_MAX, dataBytes), 0)
  const fd = openSync(mixPath, 'r+')
  try {
    writeSync(fd, riff, 0, 4, 4)
    writeSync(fd, data, 0, 4, 40)
  } finally {
    closeSync(fd)
  }
}

function cleanupSmartSession(removePartial: boolean): void {
  if (session === null) return
  const active = session
  session = null
  active.mix.destroy()
  try {
    rmSync(active.mixPath, { force: true })
  } catch {
    // temp wav cleanup is best-effort
  }
  if (removePartial && existsSync(active.partPath)) {
    try {
      rmSync(active.partPath, { force: true })
    } catch {
      // partial may be locked briefly after kill; best-effort
    }
  }
}

export function registerSmartExportIpc(): void {
  ipcMain.handle(IPC.smartExportStart, async (_event, payload: unknown) => {
    const parsed = startSchema.safeParse(payload)
    if (!parsed.success) throw new Error(`Invalid smart export request: ${parsed.error.message}`)
    if (session !== null) throw new Error('an export is already running')
    const args = parsed.data
    const lib = getStore()
    const asset = lib.assets[args.assetId]
    if (asset === undefined) throw new Error(`unknown asset: ${args.assetId}`)
    const sourcePath = join(lib.root, asset.libraryRelPath)
    if (!existsSync(sourcePath)) throw new Error(`media file missing: ${asset.fileName}`)
    const mixPath = `${args.destination}.mix.wav`
    const mix = createWriteStream(mixPath)
    await new Promise<void>((resolve, reject) => {
      mix.write(wavHeader(args.sampleRate, args.channels), (error) =>
        error ? reject(error) : resolve()
      )
    })
    session = {
      destination: args.destination,
      partPath: `${args.destination}.part`,
      mixPath,
      sourcePath,
      inSec: args.inSec,
      durSec: args.durSec,
      mix,
      dataBytes: 0,
      ffmpeg: null
    }
  })

  ipcMain.handle(IPC.smartExportAudioChunk, async (_event, payload: unknown) => {
    const active = session
    if (active === null) throw new Error('no smart export in progress')
    const data = payload as { pcm: ArrayBuffer }
    if (!(data?.pcm instanceof ArrayBuffer)) throw new Error('invalid pcm payload')
    await new Promise<void>((resolve, reject) => {
      active.mix.write(Buffer.from(data.pcm), (error) => (error ? reject(error) : resolve()))
    })
    active.dataBytes += data.pcm.byteLength
  })

  ipcMain.handle(IPC.smartExportMux, async (event) => {
    const active = session
    if (active === null) throw new Error('no smart export in progress')
    await new Promise<void>((resolve) => active.mix.end(resolve))
    patchWavSizes(active.mixPath, active.dataBytes)
    const { code, detail } = await runFfmpegMux(active, event.sender)
    if (session !== active) throw new Error('export cancelled')
    if (code !== 0) {
      cleanupSmartSession(true)
      throw new Error(`ffmpeg failed with exit code ${code}${detail === '' ? '' : ` (${detail})`}`)
    }
    try {
      renameSync(active.partPath, active.destination)
    } catch (error) {
      cleanupSmartSession(true)
      throw new Error(`could not write destination: ${String(error)}`)
    }
    cleanupSmartSession(false)
  })

  ipcMain.handle(IPC.smartExportCancel, async () => {
    const active = session
    if (active === null) return
    if (active.ffmpeg !== null && active.ffmpeg.exitCode === null) {
      active.ffmpeg.kill('SIGKILL')
      await new Promise<void>((resolve) => active.ffmpeg?.once('close', () => resolve()))
    }
    cleanupSmartSession(true)
  })
}

/**
 * One ffmpeg run: input-seek the source (-ss before -i → keyframe snap),
 * stream-copy its video, encode the mix wav as AAC, faststart-mux to
 * `<dest>.part`. -progress on stdout reports out_time for the progress UI.
 */
function runFfmpegMux(
  active: SmartSession,
  sender: WebContents
): Promise<{ code: number | null; detail: string }> {
  const args = [
    '-y',
    '-ss',
    active.inSec.toFixed(6),
    '-t',
    active.durSec.toFixed(6),
    '-i',
    active.sourcePath,
    '-i',
    active.mixPath,
    '-map',
    '0:v',
    '-c:v',
    'copy',
    '-map',
    '1:a',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-f',
    'mp4',
    active.partPath
  ]
  const ffmpeg = spawn(ffmpegPath(), args, { windowsHide: true })
  active.ffmpeg = ffmpeg
  let stderr = ''
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
  })
  ffmpeg.stdout.on('data', (chunk: Buffer) => {
    // -progress key=value blocks; out_time_us is microseconds (as is the
    // misnamed legacy out_time_ms)
    const match = /out_time_us=(\d+)/.exec(chunk.toString())
    if (match !== null && !sender.isDestroyed()) {
      sender.send(IPC.smartExportProgress, { outTimeSec: Number(match[1]) / 1e6 })
    }
  })
  return new Promise((resolve) => {
    ffmpeg.on('close', (code) => {
      resolve({ code, detail: stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') })
    })
  })
}
