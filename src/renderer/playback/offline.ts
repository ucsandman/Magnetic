import { FLICKS_PER_SECOND, flicksPerFrame, flicksToSeconds } from '../../shared/timecode'
import { sequenceDuration, type Sequence } from '../../shared/timeline/model'
import type { LibrarySnapshot } from '../../shared/types'
import {
  collectAudioJobs,
  connectJobChain,
  LONG_CLIP_THRESHOLD_SEC,
  scheduleAudioJob,
  WINDOW_SEC,
  type AudioJob
} from './audio-graph'
import { clipGainPoints, gainAutomationFor } from './automation'
import { decodeAssetsOnce } from './mix-decode'
import { openPcm, type PcmSource } from './pcm-source'
import { playbackEngine } from './engine'

/**
 * Deterministic export replay: the same scheduler/compositor as live preview,
 * driven by a virtual clock one frame at a time (WYSIWYG by construction).
 */

export interface ExportPlan {
  frameCount: number
  fps: { num: number; den: number }
  durationSec: number
}

export function planExport(sequence: Sequence): ExportPlan {
  const totalFlicks = sequenceDuration(sequence)
  const frameFlicks = flicksPerFrame(sequence.fps)
  return {
    frameCount: Math.max(1, Math.ceil(totalFlicks / frameFlicks)),
    fps: sequence.fps,
    durationSec: totalFlicks / FLICKS_PER_SECOND
  }
}

/** Render the full sequence mix into 16-bit stereo WAV bytes at 48 kHz. */
export async function renderMixdownWav(sequence: Sequence): Promise<ArrayBuffer> {
  const durationSec = Math.max(0.05, sequenceDuration(sequence) / FLICKS_PER_SECOND)
  const sampleRate = 48_000
  const ctx = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate)
  const jobs = collectAudioJobs(sequence)
  const shortJobs = jobs.filter((job) => job.durSec <= LONG_CLIP_THRESHOLD_SEC)
  const longJobs = jobs.filter((job) => job.durSec > LONG_CLIP_THRESHOLD_SEC)
  // Decode each DISTINCT asset once (not once per clip): N clips of one cold
  // recording would otherwise race N concurrent ensurePcm writes onto the same
  // pcm cache wav and hand decodeAudioData a torn read (see mix-decode.ts).
  const decoded = await decodeAssetsOnce(
    shortJobs.map((job) => job.assetId),
    async (assetId) => {
      const url = await window.api.ensurePcm(assetId)
      if (url === null) return null
      const data = await (await fetch(url)).arrayBuffer()
      return ctx.decodeAudioData(data)
    }
  )
  for (const job of shortJobs) {
    const buffer = decoded.get(job.assetId)
    if (buffer !== null && buffer !== undefined) {
      scheduleAudioJob(ctx, ctx.destination, buffer, job, 0, 0)
    }
  }
  const firstWindowError = await scheduleWindowedJobsOffline(ctx, longJobs)
  const rendered = await ctx.startRendering()
  const error = firstWindowError()
  if (error !== null) throw error
  return encodeWav(rendered)
}

const RENDER_QUANTUM_FRAMES = 128

/**
 * Windowed scheduling for long clips (the live graph's threshold/window —
 * see audio-graph.ts): each ~WINDOW_SEC window Range-fetches its PCM inside
 * an OfflineAudioContext suspend() one window ahead of its start time, so a
 * multi-hour export holds windows, not whole multi-GB wavs. Short content
 * never reaches this path — its output stays byte-identical.
 *
 * Failures must not leave the context suspended (the export would hang), so
 * each batch always resumes; the first error is surfaced via the returned
 * accessor after startRendering resolves, and logged once per asset.
 */
async function scheduleWindowedJobsOffline(
  ctx: OfflineAudioContext,
  jobs: AudioJob[]
): Promise<() => Error | null> {
  let firstError: Error | null = null
  const logged = new Set<string>()
  const record = (assetId: string, error: unknown): void => {
    if (!logged.has(assetId)) {
      logged.add(assetId)
      console.error(`export audio window fetch failed for asset ${assetId}:`, error)
    }
    if (firstError === null) {
      firstError = error instanceof Error ? error : new Error(String(error))
    }
  }
  interface WindowTask {
    atSec: number
    run: () => Promise<void>
  }
  const tasks: WindowTask[] = []
  for (const job of jobs) {
    const url = await window.api.ensurePcm(job.assetId)
    if (url === null) continue
    const pcm = await openPcm(url)
    const gain = connectJobChain(ctx, ctx.destination, job, 0, 0)
    const windowCount = Math.ceil(job.durSec / WINDOW_SEC)
    for (let index = 0; index < windowCount; index++) {
      const offsetSec = index * WINDOW_SEC
      const durSec = Math.min(WINDOW_SEC, job.durSec - offsetSec)
      const atSec = job.clipStartSec + offsetSec
      tasks.push({
        atSec,
        run: async () => {
          try {
            const buffer = await pcm.windowBuffer(ctx, job.mediaInSec + offsetSec, durSec)
            if (buffer === null) return
            const source = ctx.createBufferSource()
            source.buffer = buffer
            source.connect(gain)
            source.start(atSec)
          } catch (error) {
            record(job.assetId, error)
          }
        }
      })
    }
  }
  // batch fetches at the suspend point one window before they are due; windows
  // due immediately (or whose suspend would land at/after the end) load now.
  // suspend() times are quantized to the render quantum so equal-time batches
  // share one suspend (a second suspend at the same frame rejects).
  const batches = new Map<number, WindowTask[]>()
  const upfront: WindowTask[] = []
  for (const task of tasks) {
    const frame =
      Math.floor(((task.atSec - WINDOW_SEC) * ctx.sampleRate) / RENDER_QUANTUM_FRAMES) *
      RENDER_QUANTUM_FRAMES
    if (frame <= 0 || frame >= ctx.length) {
      upfront.push(task)
      continue
    }
    const batch = batches.get(frame)
    if (batch === undefined) batches.set(frame, [task])
    else batch.push(task)
  }
  await Promise.all(upfront.map((task) => task.run()))
  for (const [frame, batch] of batches) {
    ctx.suspend(frame / ctx.sampleRate).then(
      async () => {
        await Promise.all(batch.map((task) => task.run()))
        void ctx.resume()
      },
      (error: unknown) => {
        // suspend itself refused (clock already past it) — the batch is lost;
        // surface it rather than render a silent gap
        record(`(suspend at frame ${frame})`, error)
      }
    )
  }
  return () => firstError
}

/** Chunk length of the smart-render mixdown (one OfflineAudioContext each). */
export const MIX_CHUNK_SEC = 60
export const MIX_SAMPLE_RATE = 48_000
export const MIX_CHANNELS = 2

export interface MixProgress {
  renderedSec: number
  totalSec: number
}

/**
 * Smart-render audio path: render the full sequence mix in sequential
 * ~MIX_CHUNK_SEC OfflineAudioContext chunks and stream each chunk's
 * interleaved Int16 stereo PCM (headerless) to `onChunk`. One six-hour
 * OfflineAudioContext would materialize ~8 GB of Float32 — chunking IS the
 * point: peak memory stays at one chunk plus one source window.
 *
 * Jobs reuse collectAudioJobs; short clips decode their whole PCM once (the
 * single-buffer path's semantics), long clips Range-fetch only the slice that
 * intersects the chunk (pcm-source.ts). Fade envelopes straddling a chunk
 * boundary are clipped, not clamped (clipGainPoints), so seams are exact.
 * Any fetch/decode failure rejects — an export must not ship silent audio.
 * Returns false when `isCancelled` flipped between chunks.
 */
export async function renderMixdownChunks(
  sequence: Sequence,
  onChunk: (pcm: ArrayBuffer) => Promise<void>,
  onProgress: (progress: MixProgress) => void,
  isCancelled: () => boolean
): Promise<boolean> {
  const totalSec = Math.max(0.05, sequenceDuration(sequence) / FLICKS_PER_SECOND)
  const totalFrames = Math.ceil(totalSec * MIX_SAMPLE_RATE)
  const chunkFrames = MIX_CHUNK_SEC * MIX_SAMPLE_RATE
  const jobs = collectAudioJobs(sequence)

  // Open every asset's source once, up front: whole decoded buffers for short
  // clips, random-access PCM windows for long ones. decodeAudioData needs a
  // context; a scratch OfflineAudioContext at the mix rate serves all chunks
  // (AudioBuffers are not bound to the context that created them).
  const scratch = new OfflineAudioContext(MIX_CHANNELS, 8, MIX_SAMPLE_RATE)
  const decoded = new Map<string, AudioBuffer | null>()
  const streamed = new Map<string, PcmSource | null>()
  for (const job of jobs) {
    if (job.durSec > LONG_CLIP_THRESHOLD_SEC) {
      if (!streamed.has(job.assetId)) {
        const url = await window.api.ensurePcm(job.assetId)
        streamed.set(job.assetId, url === null ? null : await openPcm(url))
      }
    } else if (!decoded.has(job.assetId)) {
      const url = await window.api.ensurePcm(job.assetId)
      if (url === null) {
        decoded.set(job.assetId, null)
      } else {
        const data = await (await fetch(url)).arrayBuffer()
        decoded.set(job.assetId, await scratch.decodeAudioData(data))
      }
    }
  }

  let framesDone = 0
  while (framesDone < totalFrames) {
    if (isCancelled()) return false
    const frames = Math.min(chunkFrames, totalFrames - framesDone)
    const chunkStartSec = framesDone / MIX_SAMPLE_RATE
    const chunkDurSec = frames / MIX_SAMPLE_RATE
    const ctx = new OfflineAudioContext(MIX_CHANNELS, frames, MIX_SAMPLE_RATE)
    await Promise.all(
      jobs.map((job) =>
        scheduleJobIntoChunk(ctx, job, chunkStartSec, chunkDurSec, decoded, streamed)
      )
    )
    const rendered = await ctx.startRendering()
    await onChunk(interleaveInt16(rendered))
    framesDone += frames
    onProgress({ renderedSec: framesDone / MIX_SAMPLE_RATE, totalSec })
  }
  return true
}

/**
 * Schedule the part of one job that intersects [chunkStartSec, +chunkDurSec)
 * into a chunk context. Same (start, offset, duration) math as
 * scheduleAudioJob with fromSec = chunkStartSec — only the gain envelope
 * differs: clipped at the boundary instead of clamped (see clipGainPoints).
 */
async function scheduleJobIntoChunk(
  ctx: OfflineAudioContext,
  job: AudioJob,
  chunkStartSec: number,
  chunkDurSec: number,
  decoded: Map<string, AudioBuffer | null>,
  streamed: Map<string, PcmSource | null>
): Promise<void> {
  const fromSec = Math.max(job.clipStartSec, chunkStartSec)
  const toSec = Math.min(job.clipStartSec + job.durSec, chunkStartSec + chunkDurSec)
  if (toSec - fromSec <= 1e-9) return
  const mediaFromSec = job.mediaInSec + (fromSec - job.clipStartSec)
  const source = ctx.createBufferSource()
  if (job.durSec > LONG_CLIP_THRESHOLD_SEC) {
    const pcm = streamed.get(job.assetId)
    if (pcm === undefined || pcm === null) return
    const buffer = await pcm.windowBuffer(ctx, mediaFromSec, toSec - fromSec)
    if (buffer === null) return
    source.buffer = buffer
    source.connect(connectChunkJobChain(ctx, job, chunkStartSec))
    source.start(fromSec - chunkStartSec)
  } else {
    const buffer = decoded.get(job.assetId)
    if (buffer === undefined || buffer === null) return
    source.buffer = buffer
    source.connect(connectChunkJobChain(ctx, job, chunkStartSec))
    source.start(fromSec - chunkStartSec, mediaFromSec, toSec - fromSec)
  }
}

/**
 * connectJobChain's gain/pan wiring with the clip-relative envelope expressed
 * in CHUNK time and clipped at 0 — a boundary mid-fade resumes at the exact
 * value the previous chunk rendered last. Loop iterations use their
 * whole-clip span (job.env), exactly like the live graph.
 */
function connectChunkJobChain(
  ctx: OfflineAudioContext,
  job: AudioJob,
  chunkStartSec: number
): GainNode {
  const gain = ctx.createGain()
  const panner = ctx.createStereoPanner()
  panner.pan.value = Math.max(-1, Math.min(1, job.fx.pan))
  gain.connect(panner)
  panner.connect(ctx.destination)
  const env = job.env ?? job
  const points = clipGainPoints(
    gainAutomationFor({
      startCtxTime: env.clipStartSec - chunkStartSec,
      durationSec: env.durSec,
      fadeInSec: flicksToSeconds(job.fx.fadeInFlicks),
      fadeOutSec: flicksToSeconds(job.fx.fadeOutFlicks),
      volumeDb: job.fx.volumeDb,
      ducks: job.fx.duck?.ranges.map((range) => ({
        fromSec: flicksToSeconds(range.fromClipFlicks),
        toSec: flicksToSeconds(range.toClipFlicks)
      })),
      duckDb: job.fx.duck?.amountDb
    }),
    0
  )
  gain.gain.setValueAtTime(points[0].value, points[0].atCtxTime)
  for (const point of points.slice(1)) {
    gain.gain.linearRampToValueAtTime(point.value, point.atCtxTime)
  }
  return gain
}

/** Interleave an AudioBuffer into headerless little-endian Int16 PCM. */
export function interleaveInt16(buffer: AudioBuffer): ArrayBuffer {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const out = new ArrayBuffer(frames * channels * 2)
  const view = new DataView(out)
  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let offset = 0
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][frame]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return out
}

/** Interleave an AudioBuffer into a 16-bit PCM RIFF/WAVE container. */
function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const dataBytes = frames * channels * 2
  const out = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(out)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][frame]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return out
}

export class ExportCancelledError extends Error {
  constructor() {
    super('export cancelled')
    this.name = 'ExportCancelledError'
  }
}

/**
 * Replay every frame through the live compositor and hand the RGBA pixels to
 * `onFrame`. The awaited callback is the backpressure: the next frame is not
 * rendered until the encoder pulled this one.
 */
export function replayFrames(
  sequence: Sequence,
  snapshot: LibrarySnapshot,
  onFrame: (rgba: Uint8ClampedArray, frameIndex: number) => Promise<void>,
  isCancelled: () => boolean
): Promise<boolean> {
  const plan = planExport(sequence)
  const frameFlicks = flicksPerFrame(sequence.fps)
  return playbackEngine.exportReplay(
    sequence,
    snapshot,
    plan.frameCount,
    frameFlicks,
    onFrame,
    isCancelled
  )
}
