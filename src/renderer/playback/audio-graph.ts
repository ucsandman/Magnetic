import { flicksToSeconds } from '../../shared/timecode'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import type { ClipFx, Sequence } from '../../shared/timeline/model'
import { DEFAULT_FX } from '../../shared/timeline/ops'
import { gainAutomationFor } from './automation'
import { openPcm, type PcmSource } from './pcm-source'

/**
 * Web Audio mixdown: one BufferSource per clip with audio, scheduled at clip
 * offsets against the AudioContext clock (the playback clock master). The
 * whole graph is rebuilt on play/seek and torn down on pause — no double
 * audio, silent when stopped (analyser RMS proves it in E2E).
 *
 * Short clips decode their whole PCM extraction once (decodeAudioData);
 * clips longer than LONG_CLIP_THRESHOLD_SEC instead stream just-in-time
 * ~WINDOW_SEC AudioBuffers Range-fetched from the wav cache (pcm-source.ts),
 * double-buffered ahead of the context clock — a 6-hour asset never holds
 * more than a few windows of samples in memory.
 */

/** Clips scheduled longer than this stream windows instead of one decoded buffer. */
export const LONG_CLIP_THRESHOLD_SEC = 120
/** Streamed window length, seconds. */
export const WINDOW_SEC = 10
/** Keep windows scheduled this far ahead of the context clock (~2.5 windows). */
const WINDOW_LOOKAHEAD_SEC = 25
/** Re-check the lookahead horizon at a quarter-window cadence. */
const WINDOW_POLL_MS = 2_500

export interface AudioJob {
  assetId: string
  clipStartSec: number
  mediaInSec: number
  durSec: number
  fx: ClipFx
  /**
   * Whole-CLIP gain-envelope span when this job is one loop iteration of a
   * larger clip: fades/volume span the looped clip as a whole (fade-out at the
   * very end), never each iteration. Absent = the job is the whole clip.
   */
  env?: { clipStartSec: number; durSec: number }
}

/** Sub-sample slack for the loop-tiling loop (never emit a zero-length job). */
const LOOP_EPS_SEC = 1e-9

/**
 * Split a looped clip into one AudioJob per loop iteration, all sharing one
 * whole-clip envelope span. Loop semantics (v1, deliberate): the clip plays
 * its source from mediaIn to the source END, then wraps to the FULL source
 * [0, sourceDuration) repeatedly until the clip duration is filled. (FCP loops
 * the trimmed range; wrapping over the full source is the simplest defensible
 * v1 — the bed starts where the user trimmed it and tiles whole source lengths
 * after that.) Job count is bounded: ceil(durSec / sourceDurSec) + 1.
 *
 * Because every consumer (live graph, offline render, chunked smart-render
 * mix) schedules plain AudioJobs, they all inherit looping from this one seam.
 */
function pushLoopIterations(jobs: AudioJob[], job: AudioJob, sourceDurSec: number): void {
  if (sourceDurSec <= 0) return
  const env = { clipStartSec: job.clipStartSec, durSec: job.durSec }
  // head trims on a looped clip can push mediaIn past the source — it wraps
  let mediaInSec = job.mediaInSec % sourceDurSec
  let atSec = 0
  while (atSec < job.durSec - LOOP_EPS_SEC) {
    const iterDurSec = Math.min(sourceDurSec - mediaInSec, job.durSec - atSec)
    jobs.push({
      ...job,
      clipStartSec: job.clipStartSec + atSec,
      mediaInSec,
      durSec: iterDurSec,
      env
    })
    atSec += iterDurSec
    mediaInSec = 0
  }
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
    const job: AudioJob = {
      assetId: cc.assetId,
      clipStartSec: flicksToSeconds(parentStart + cc.offsetFlicks),
      mediaInSec: flicksToSeconds(cc.mediaInFlicks),
      durSec: flicksToSeconds(cc.durationFlicks),
      fx: { ...DEFAULT_FX, ...(cc.fx ?? {}) }
    }
    if (cc.loop === true) {
      pushLoopIterations(jobs, job, flicksToSeconds(cc.sourceDurationFlicks))
    } else {
      jobs.push(job)
    }
  }
  return jobs
}

/**
 * One job's gain (clip-relative fade envelope) + pan chain into `destination`.
 * Shared by the single-buffer path and by every window of a streamed clip, so
 * fades/volume/pan behave identically however the samples arrive. Loop
 * iterations pass their whole-clip span via job.env, so the envelope covers
 * the full looped clip while the source plays only this iteration's slice.
 */
export function connectJobChain(
  ctx: BaseAudioContext,
  destination: AudioNode,
  job: AudioJob,
  fromSec: number,
  startCtxTime: number
): GainNode {
  const gain = ctx.createGain()
  const panner = ctx.createStereoPanner()
  panner.pan.value = Math.max(-1, Math.min(1, job.fx.pan))
  gain.connect(panner)
  panner.connect(destination)
  // fade envelope is relative to the CLIP; past anchors clamp to "now"
  const env = job.env ?? job
  const points = gainAutomationFor({
    startCtxTime: startCtxTime + (env.clipStartSec - fromSec),
    durationSec: env.durSec,
    fadeInSec: flicksToSeconds(job.fx.fadeInFlicks),
    fadeOutSec: flicksToSeconds(job.fx.fadeOutFlicks),
    volumeDb: job.fx.volumeDb
  })
  gain.gain.setValueAtTime(points[0].value, Math.max(0, points[0].atCtxTime))
  for (const point of points.slice(1)) {
    gain.gain.linearRampToValueAtTime(point.value, Math.max(0, point.atCtxTime))
  }
  return gain
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
  source.connect(connectJobChain(ctx, destination, job, fromSec, startCtxTime))
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
  private pcmSources = new Map<string, Promise<PcmSource | null>>()
  private active: AudioBufferSourceNode[] = []
  private timers: number[] = []
  /** Bumped on stop(): in-flight window fetches/timers from older builds no-op. */
  private generation = 0
  private windowErrorLogged = new Set<string>()

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

  /** Open (once per asset) the random-access PCM source for streamed clips. */
  private pcmFor(assetId: string): Promise<PcmSource | null> {
    let pending = this.pcmSources.get(assetId)
    if (pending === undefined) {
      pending = (async () => {
        const url = await window.api.ensurePcm(assetId)
        if (url === null) return null
        return openPcm(url)
      })()
      pending.catch(() => this.pcmSources.delete(assetId))
      this.pcmSources.set(assetId, pending)
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
    this.windowErrorLogged.clear()
    const fromSec = flicksToSeconds(fromFlicks)
    const jobs = collectAudioJobs(sequence)
    await Promise.all(
      jobs.map(async (job) => {
        if (job.durSec > LONG_CLIP_THRESHOLD_SEC) {
          const pcm = await this.pcmFor(job.assetId)
          if (pcm !== null) await this.scheduleWindowedJob(pcm, job, fromSec, startCtxTime)
          return
        }
        const buffer = await this.bufferFor(job.assetId)
        if (buffer === null) return
        const source = scheduleAudioJob(this.ctx, this.master, buffer, job, fromSec, startCtxTime)
        if (source !== null) this.active.push(source)
      })
    )
  }

  /**
   * Streamed path for long clips: window k of the remaining span plays the
   * media range [mediaIn + intoClip + k·W, …) at ctx time base + k·W — the
   * exact same start-time math as scheduleAudioJob's (start, offset, duration)
   * triple, just sliced. All windows feed one shared gain/pan chain so the
   * clip-relative fade envelope is untouched. Resolves once the windows inside
   * the initial lookahead are scheduled; a timer keeps the horizon filled.
   */
  private async scheduleWindowedJob(
    pcm: PcmSource,
    job: AudioJob,
    fromSec: number,
    startCtxTime: number
  ): Promise<void> {
    const intoClip = Math.max(0, fromSec - job.clipStartSec)
    const remaining = job.durSec - intoClip
    if (remaining <= 0) return
    const gain = connectJobChain(this.ctx, this.master, job, fromSec, startCtxTime)
    const baseCtxTime = startCtxTime + Math.max(0, job.clipStartSec - fromSec)
    const mediaBaseSec = job.mediaInSec + intoClip
    const windowCount = Math.ceil(remaining / WINDOW_SEC)
    const generation = this.generation
    let nextWindow = 0

    const startWindow = async (index: number): Promise<void> => {
      const offsetSec = index * WINDOW_SEC
      const durSec = Math.min(WINDOW_SEC, remaining - offsetSec)
      try {
        const buffer = await pcm.windowBuffer(this.ctx, mediaBaseSec + offsetSec, durSec)
        if (generation !== this.generation || buffer === null) return
        const source = this.ctx.createBufferSource()
        source.buffer = buffer
        source.connect(gain)
        const startAt = baseCtxTime + offsetSec
        const late = this.ctx.currentTime - startAt
        if (late <= 0) source.start(startAt)
        else if (late < durSec) source.start(this.ctx.currentTime, late)
        else return // window already entirely in the past
        this.active.push(source)
      } catch (error) {
        // one window lost = WINDOW_SEC of silence, not a crashed graph; say so
        // once per asset (a dead server would otherwise log every 10 s)
        if (generation === this.generation && !this.windowErrorLogged.has(job.assetId)) {
          this.windowErrorLogged.add(job.assetId)
          console.error(`audio window fetch failed for asset ${job.assetId}:`, error)
        }
      }
    }

    const startDueWindows = (): Promise<void>[] => {
      const started: Promise<void>[] = []
      while (
        nextWindow < windowCount &&
        baseCtxTime + nextWindow * WINDOW_SEC < this.ctx.currentTime + WINDOW_LOOKAHEAD_SEC
      ) {
        started.push(startWindow(nextWindow))
        nextWindow += 1
      }
      return started
    }

    const pump = (): void => {
      if (generation !== this.generation) return
      void Promise.all(startDueWindows())
      if (nextWindow < windowCount) {
        this.timers.push(window.setTimeout(pump, WINDOW_POLL_MS))
      }
    }

    await Promise.all(startDueWindows())
    if (generation === this.generation && nextWindow < windowCount) {
      this.timers.push(window.setTimeout(pump, WINDOW_POLL_MS))
    }
  }

  stop(): void {
    this.generation += 1
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
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
