import { flicksToSeconds } from '../../shared/timecode'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import type { Sequence } from '../../shared/timeline/model'

/**
 * Web Audio mixdown: one BufferSource per clip with audio, scheduled at clip
 * offsets against the AudioContext clock (the playback clock master). The
 * whole graph is rebuilt on play/seek and torn down on pause — no double
 * audio, silent when stopped (analyser RMS proves it in E2E).
 */

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
    const fromSec = flicksToSeconds(fromFlicks)
    const startOf = spineStartIndex(sequence.spine)
    const jobs: { assetId: string; clipStartSec: number; mediaInSec: number; durSec: number }[] = []
    let position = 0
    for (const item of sequence.spine) {
      if (item.kind === 'clip') {
        jobs.push({
          assetId: item.assetId,
          clipStartSec: flicksToSeconds(position),
          mediaInSec: flicksToSeconds(item.mediaInFlicks),
          durSec: flicksToSeconds(item.durationFlicks)
        })
      }
      position += item.durationFlicks
    }
    for (const cc of sequence.connected) {
      const parentStart = startOf.get(cc.parentClipId)
      if (parentStart === undefined) continue
      jobs.push({
        assetId: cc.assetId,
        clipStartSec: flicksToSeconds(parentStart + cc.offsetFlicks),
        mediaInSec: flicksToSeconds(cc.mediaInFlicks),
        durSec: flicksToSeconds(cc.durationFlicks)
      })
    }
    const buffers = await Promise.all(jobs.map((job) => this.bufferFor(job.assetId)))
    for (let i = 0; i < jobs.length; i++) {
      const buffer = buffers[i]
      if (buffer === null) continue
      const job = jobs[i]
      const intoClip = Math.max(0, fromSec - job.clipStartSec)
      const remaining = job.durSec - intoClip
      if (remaining <= 0) continue
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      const gain = this.ctx.createGain()
      source.connect(gain)
      gain.connect(this.master)
      source.start(
        startCtxTime + Math.max(0, job.clipStartSec - fromSec),
        job.mediaInSec + intoClip,
        remaining
      )
      this.active.push(source)
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
