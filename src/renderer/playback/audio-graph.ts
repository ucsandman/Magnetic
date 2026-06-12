import { flicksToSeconds } from '../../shared/timecode'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import type { ClipFx, Sequence } from '../../shared/timeline/model'
import { DEFAULT_FX } from '../../shared/timeline/ops'
import { gainAutomationFor } from './automation'

/**
 * Web Audio mixdown: one BufferSource per clip with audio, scheduled at clip
 * offsets against the AudioContext clock (the playback clock master). The
 * whole graph is rebuilt on play/seek and torn down on pause — no double
 * audio, silent when stopped (analyser RMS proves it in E2E).
 */

export interface AudioJob {
  assetId: string
  clipStartSec: number
  mediaInSec: number
  durSec: number
  fx: ClipFx
}

/** Every audible clip in the sequence (titles and audio-detached spine clips are silent). */
export function collectAudioJobs(sequence: Sequence): AudioJob[] {
  const startOf = spineStartIndex(sequence.spine)
  const jobs: AudioJob[] = []
  let position = 0
  for (const item of sequence.spine) {
    if (item.kind === 'clip' && item.audioDisabled !== true) {
      jobs.push({
        assetId: item.assetId,
        clipStartSec: flicksToSeconds(position),
        mediaInSec: flicksToSeconds(item.mediaInFlicks),
        durSec: flicksToSeconds(item.durationFlicks),
        fx: { ...DEFAULT_FX, ...(item.fx ?? {}) }
      })
    }
    position += item.durationFlicks
  }
  for (const cc of sequence.connected) {
    if (cc.titleData !== undefined || cc.audioDisabled === true) continue
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) continue
    jobs.push({
      assetId: cc.assetId,
      clipStartSec: flicksToSeconds(parentStart + cc.offsetFlicks),
      mediaInSec: flicksToSeconds(cc.mediaInFlicks),
      durSec: flicksToSeconds(cc.durationFlicks),
      fx: { ...DEFAULT_FX, ...(cc.fx ?? {}) }
    })
  }
  return jobs
}

/**
 * Schedule one clip's audio into any BaseAudioContext (live or offline) —
 * the context-injection seam that keeps preview and export on one code path.
 */
export function scheduleAudioJob(
  ctx: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  job: AudioJob,
  fromSec: number,
  startCtxTime: number
): AudioBufferSourceNode | null {
  const intoClip = Math.max(0, fromSec - job.clipStartSec)
  const remaining = job.durSec - intoClip
  if (remaining <= 0) return null
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  const panner = ctx.createStereoPanner()
  panner.pan.value = Math.max(-1, Math.min(1, job.fx.pan))
  source.connect(gain)
  gain.connect(panner)
  panner.connect(destination)
  // fade envelope is relative to the CLIP; past anchors clamp to "now"
  const points = gainAutomationFor({
    startCtxTime: startCtxTime + (job.clipStartSec - fromSec),
    durationSec: job.durSec,
    fadeInSec: flicksToSeconds(job.fx.fadeInFlicks),
    fadeOutSec: flicksToSeconds(job.fx.fadeOutFlicks),
    volumeDb: job.fx.volumeDb
  })
  gain.gain.setValueAtTime(points[0].value, Math.max(0, points[0].atCtxTime))
  for (const point of points.slice(1)) {
    gain.gain.linearRampToValueAtTime(point.value, Math.max(0, point.atCtxTime))
  }
  source.start(
    startCtxTime + Math.max(0, job.clipStartSec - fromSec),
    job.mediaInSec + intoClip,
    remaining
  )
  return source
}

export class AudioGraphController {
  readonly ctx: AudioContext
  readonly analyser: AnalyserNode
  private master: GainNode
  private buffers = new Map<string, Promise<AudioBuffer | null>>()
  private active: AudioBufferSourceNode[] = []

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.master.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
  }

  /** Decode (once per asset) the 48 kHz PCM extraction into an AudioBuffer. */
  private bufferFor(assetId: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(assetId)
    if (pending === undefined) {
      pending = (async () => {
        const url = await window.api.ensurePcm(assetId)
        if (url === null) return null
        const data = await (await fetch(url)).arrayBuffer()
        return this.ctx.decodeAudioData(data)
      })()
      pending.catch(() => this.buffers.delete(assetId))
      this.buffers.set(assetId, pending)
    }
    return pending
  }

  /** Current output level 0..1 (silence proof for the paused-state E2E). */
  rms(): number {
    const samples = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) sum += sample * sample
    return Math.sqrt(sum / samples.length)
  }

  /** Schedule every audible clip from `fromFlicks`, anchored at `startCtxTime`. */
  async build(sequence: Sequence, fromFlicks: number, startCtxTime: number): Promise<void> {
    this.stop()
    const jobs = collectAudioJobs(sequence)
    const buffers = await Promise.all(jobs.map((job) => this.bufferFor(job.assetId)))
    for (let i = 0; i < jobs.length; i++) {
      const buffer = buffers[i]
      if (buffer === null) continue
      const source = scheduleAudioJob(
        this.ctx,
        this.master,
        buffer,
        jobs[i],
        flicksToSeconds(fromFlicks),
        startCtxTime
      )
      if (source !== null) this.active.push(source)
    }
  }

  stop(): void {
    for (const source of this.active) {
      try {
        source.stop()
      } catch {
        // already stopped or never started — fine
      }
      source.disconnect()
    }
    this.active = []
  }
}
