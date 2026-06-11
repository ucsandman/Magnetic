import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { dialog, ipcMain } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { IPC } from '../../shared/channels'
import { ffmpegPath } from '../binaries'

/**
 * Export encoder: rawvideo RGBA frames piped from the renderer into ffmpeg's
 * stdin, muxed with the offline WAV mixdown. Writes to `<dest>.part` and
 * atomically renames on success; cancel kills ffmpeg and removes the partial.
 */

interface ExportSession {
  ffmpeg: ChildProcessWithoutNullStreams
  destination: string
  partPath: string
  tempDir: string
  stderr: string
  exited: Promise<number | null>
}

let session: ExportSession | null = null

const startSchema = z.object({
  destination: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
  /** Optional output scale (e.g. 720p preset). */
  scaleTo: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .nullable(),
  wav: z.instanceof(ArrayBuffer)
})

function cleanupSession(removePartial: boolean): void {
  if (session === null) return
  const { tempDir, partPath } = session
  session = null
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // temp dir cleanup is best-effort
  }
  if (removePartial && existsSync(partPath)) {
    try {
      rmSync(partPath, { force: true })
    } catch {
      // partial may be locked briefly after kill; best-effort
    }
  }
}

export function registerExportIpc(): void {
  ipcMain.handle(IPC.exportPickDestination, async () => {
    const picked = await dialog.showSaveDialog({
      title: 'Export Movie',
      defaultPath: 'export.mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    return picked.canceled ? null : picked.filePath
  })

  ipcMain.handle(IPC.exportStart, async (_event, payload: unknown) => {
    const parsed = startSchema.safeParse(payload)
    if (!parsed.success) throw new Error(`Invalid export request: ${parsed.error.message}`)
    if (session !== null) throw new Error('an export is already running')
    const args = parsed.data
    const tempDir = mkdtempSync(join(tmpdir(), 'magnetic-export-'))
    const wavPath = join(tempDir, 'mix.wav')
    writeFileSync(wavPath, Buffer.from(args.wav))
    const partPath = `${args.destination}.part`
    const fps = `${args.fps.num}/${args.fps.den}`
    const ffArgs = [
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${args.width}x${args.height}`,
      '-r',
      fps,
      '-i',
      'pipe:0',
      '-i',
      wavPath,
      '-map',
      '0:v',
      '-map',
      '1:a',
      ...(args.scaleTo === null
        ? []
        : ['-vf', `scale=${args.scaleTo.width}:${args.scaleTo.height}`]),
      '-c:v',
      'libx264',
      '-preset',
      process.env.MAGNETIC_TEST === '1' ? 'veryfast' : 'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      partPath
    ]
    const ffmpeg = spawn(ffmpegPath(), ffArgs, { windowsHide: true })
    let stderr = ''
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
    })
    ffmpeg.stdin.on('error', () => {
      // EPIPE after ffmpeg dies — surfaced via the next write's rejection
    })
    const exited = new Promise<number | null>((resolve) => {
      ffmpeg.on('close', (code) => resolve(code))
    })
    session = { ffmpeg, destination: args.destination, partPath, tempDir, stderr: '', exited }
    const active = session
    void exited.then(() => {
      active.stderr = stderr
    })
  })

  ipcMain.handle(IPC.exportFrame, async (_event, payload: unknown) => {
    const active = session
    if (active === null) throw new Error('no export in progress')
    const data = payload as { frame: ArrayBuffer }
    if (!(data?.frame instanceof ArrayBuffer)) throw new Error('invalid frame payload')
    if (active.ffmpeg.exitCode !== null) {
      const detail = active.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
      cleanupSession(true)
      throw new Error(`ffmpeg exited early (${detail || 'unknown encoder error'})`)
    }
    await new Promise<void>((resolve, reject) => {
      active.ffmpeg.stdin.write(Buffer.from(data.frame), (error) =>
        error ? reject(error) : resolve()
      )
    })
  })

  ipcMain.handle(IPC.exportFinish, async () => {
    const active = session
    if (active === null) throw new Error('no export in progress')
    active.ffmpeg.stdin.end()
    const code = await active.exited
    if (code !== 0) {
      const detail = active.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
      cleanupSession(true)
      throw new Error(`ffmpeg failed with exit code ${code} (${detail})`)
    }
    try {
      renameSync(active.partPath, active.destination)
    } catch (error) {
      cleanupSession(true)
      throw new Error(`could not write destination: ${String(error)}`)
    }
    cleanupSession(false)
  })

  ipcMain.handle(IPC.exportCancel, async () => {
    const active = session
    if (active === null) return
    active.ffmpeg.kill('SIGKILL')
    await active.exited
    cleanupSession(true)
  })
}
