import { FLICKS_PER_SECOND, flicksPerFrame } from '../../shared/timecode'
import { sequenceDuration, type Sequence } from '../../shared/timeline/model'
import type { LibrarySnapshot } from '../../shared/types'
import { collectAudioJobs, scheduleAudioJob } from './audio-graph'
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
  const buffers = await Promise.all(
    jobs.map(async (job) => {
      const url = await window.api.ensurePcm(job.assetId)
      if (url === null) return null
      const data = await (await fetch(url)).arrayBuffer()
      return ctx.decodeAudioData(data)
    })
  )
  for (let i = 0; i < jobs.length; i++) {
    const buffer = buffers[i]
    if (buffer !== null) scheduleAudioJob(ctx, ctx.destination, buffer, jobs[i], 0, 0)
  }
  const rendered = await ctx.startRendering()
  return encodeWav(rendered)
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
