import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import { sequenceDuration, type ClipFx, type Sequence } from '../../shared/timeline/model'
import type { AssetView, LibrarySnapshot } from '../../shared/types'
import { AudioGraphController } from './audio-graph'
import { Compositor, type CompositedLayer } from './compositor/compositor'
import type { DecoderHandle } from './decoder/sample-decoder'
import { sessionFor } from './sessions'

/**
 * Sequence playback engine. Clock master is AudioContext.currentTime; each
 * rAF the presenter computes the sequence time, pulls the due frame from
 * every active clip pump and composites back-to-front (spine, then connected
 * lanes ascending). Pumps pre-roll 0.5 s before their clip's cut.
 */

const PRE_ROLL_SEC = 0.5

interface PlayItem {
  clipId: string
  asset: AssetView
  /** Sequence-space interval, seconds. */
  startSec: number
  endSec: number
  mediaInSec: number
  fx: ClipFx | undefined
  /** 0 = spine; >0 connected video lanes, painted ascending. */
  layer: number
}

interface DriftSample {
  atSec: number
  driftMs: number
}

export interface DriftReport {
  samples: DriftSample[]
  maxAbsMs: number
}

/** Pull-based frame source for one clip; owns its decode generator. */
class ClipPump {
  private generator: AsyncGenerator<VideoFrame> | null = null
  private lookahead: VideoFrame | null = null
  private pulling = false
  private done = false
  /** Frame currently presented (already uploaded; kept for PTS bookkeeping). */
  presentedPtsMicros = -1

  constructor(
    readonly item: PlayItem,
    private session: Promise<DecoderHandle>
  ) {}

  /** Begin decoding from `mediaFromSec` (pre-roll). */
  start(mediaFromSec: number): void {
    if (this.generator !== null) return
    void this.session.then((handle) => {
      if (this.done) return
      this.generator = handle.decodeRange(mediaFromSec * FLICKS_PER_SECOND, Number.MAX_SAFE_INTEGER)
      this.refill()
    })
  }

  private refill(): void {
    if (this.pulling || this.done || this.generator === null || this.lookahead !== null) return
    this.pulling = true
    void this.generator.next().then(
      (result) => {
        this.pulling = false
        if (result.done === true || this.done) {
          if (result.done !== true) (result.value as VideoFrame).close()
          return
        }
        this.lookahead = result.value
        if (this.done) {
          this.lookahead.close()
          this.lookahead = null
        }
      },
      () => {
        this.pulling = false
        this.done = true
      }
    )
  }

  /** The frame due at mediaMicros, if a newer one than last presented is ready. */
  takeDueFrame(mediaMicros: number): VideoFrame | null {
    let due: VideoFrame | null = null
    while (this.lookahead !== null && this.lookahead.timestamp <= mediaMicros) {
      if (due !== null) due.close()
      due = this.lookahead
      this.lookahead = null
      this.refill()
    }
    if (due !== null) this.presentedPtsMicros = due.timestamp
    return due
  }

  dispose(): void {
    this.done = true
    if (this.lookahead !== null) {
      this.lookahead.close()
      this.lookahead = null
    }
    void this.generator?.return(undefined)
    this.generator = null
  }
}

export class PlaybackEngine {
  private compositor: Compositor | null = null
  private audio: AudioGraphController | null = null
  private raf: number | null = null
  private pumps = new Map<string, ClipPump>()
  private items: PlayItem[] = []
  private playing = false
  private startCtxTime = 0
  private fromSec = 0
  private endSec = 0
  private drift: DriftSample[] = []
  private nextDriftSampleAt = 0
  private stillToken = 0
  onTime: ((flicks: number) => void) | null = null
  onPlayState: ((playing: boolean) => void) | null = null

  attach(canvas: HTMLCanvasElement): void {
    this.compositor?.dispose()
    this.compositor = new Compositor(canvas)
  }

  detach(): void {
    this.pause()
    this.compositor?.dispose()
    this.compositor = null
  }

  get isPlaying(): boolean {
    return this.playing
  }

  private ensureAudio(): AudioGraphController {
    if (this.audio === null) this.audio = new AudioGraphController()
    return this.audio
  }

  /** Output RMS — silence proof while paused. */
  audioRms(): number {
    return this.audio?.rms() ?? 0
  }

  driftReport(): DriftReport {
    const maxAbsMs = this.drift.reduce((max, sample) => Math.max(max, Math.abs(sample.driftMs)), 0)
    return { samples: [...this.drift], maxAbsMs }
  }

  readPixels(x: number, y: number, w: number, h: number): number[] {
    if (this.compositor === null) return []
    return [...this.compositor.readPixels(x, y, w, h)]
  }

  /** Visible video items (spine layer 0, connected lanes ascending). */
  private buildItems(sequence: Sequence, snapshot: LibrarySnapshot): PlayItem[] {
    const items: PlayItem[] = []
    let position = 0
    for (const item of sequence.spine) {
      if (item.kind === 'clip') {
        const asset = snapshot.assets[item.assetId]
        if (asset?.video !== undefined) {
          items.push({
            clipId: item.id,
            asset,
            startSec: position / FLICKS_PER_SECOND,
            endSec: (position + item.durationFlicks) / FLICKS_PER_SECOND,
            mediaInSec: item.mediaInFlicks / FLICKS_PER_SECOND,
            fx: item.fx,
            layer: 0
          })
        }
      }
      position += item.durationFlicks
    }
    const startOf = spineStartIndex(sequence.spine)
    for (const cc of sequence.connected) {
      if (cc.lane <= 0) continue
      const parentStart = startOf.get(cc.parentClipId)
      if (parentStart === undefined) continue
      const asset = snapshot.assets[cc.assetId]
      if (asset?.video === undefined) continue
      const start = parentStart + cc.offsetFlicks
      items.push({
        clipId: cc.id,
        asset,
        startSec: start / FLICKS_PER_SECOND,
        endSec: (start + cc.durationFlicks) / FLICKS_PER_SECOND,
        mediaInSec: cc.mediaInFlicks / FLICKS_PER_SECOND,
        fx: cc.fx,
        layer: cc.lane
      })
    }
    items.sort((a, b) => a.layer - b.layer)
    return items
  }

  async play(sequence: Sequence, snapshot: LibrarySnapshot, fromFlicks: number): Promise<void> {
    this.pause()
    this.stillToken += 1
    const audio = this.ensureAudio()
    if (audio.ctx.state === 'suspended') await audio.ctx.resume()
    this.items = this.buildItems(sequence, snapshot)
    this.fromSec = fromFlicks / FLICKS_PER_SECOND
    this.endSec = sequenceDuration(sequence) / FLICKS_PER_SECOND
    if (this.fromSec >= this.endSec) return
    this.drift = []
    this.nextDriftSampleAt = 1
    this.startCtxTime = audio.ctx.currentTime + 0.1 // small scheduling headroom
    await audio.build(sequence, fromFlicks, this.startCtxTime)
    this.playing = true
    this.onPlayState?.(true)
    this.tick()
  }

  private tick = (): void => {
    if (!this.playing || this.audio === null) return
    if (this.compositor === null) {
      // canvas not mounted yet (viewer switching modes) — keep the clock alive
      this.raf = requestAnimationFrame(this.tick)
      return
    }
    const tSec = this.fromSec + (this.audio.ctx.currentTime - this.startCtxTime)
    if (tSec >= this.endSec) {
      this.onTime?.(Math.round(this.endSec * FLICKS_PER_SECOND))
      this.pause()
      return
    }
    const effectiveT = Math.max(tSec, this.fromSec)

    // start/stop pumps: pre-roll ahead of each clip's cut, evict behind
    for (const item of this.items) {
      const active = effectiveT >= item.startSec - PRE_ROLL_SEC && effectiveT < item.endSec
      const pump = this.pumps.get(item.clipId)
      if (active && pump === undefined) {
        const startMediaSec = item.mediaInSec + Math.max(0, effectiveT - item.startSec)
        const newPump = new ClipPump(item, sessionFor(item.asset))
        newPump.start(startMediaSec)
        this.pumps.set(item.clipId, newPump)
      } else if (!active && pump !== undefined) {
        pump.dispose()
        this.pumps.delete(item.clipId)
      }
    }

    // present due frames for visible items
    const layers: CompositedLayer[] = []
    let spinePresentedSeqSec: number | null = null
    for (const item of this.items) {
      if (effectiveT < item.startSec || effectiveT >= item.endSec) continue
      const pump = this.pumps.get(item.clipId)
      if (pump === undefined) continue
      const mediaMicros = (item.mediaInSec + (effectiveT - item.startSec)) * 1_000_000
      const frame = pump.takeDueFrame(mediaMicros)
      layers.push({ slot: item.clipId, frame, fx: item.fx })
      if (item.layer === 0 && pump.presentedPtsMicros >= 0) {
        spinePresentedSeqSec = item.startSec + pump.presentedPtsMicros / 1_000_000 - item.mediaInSec
      }
    }
    this.compositor.draw(layers)

    // drift sample once per second: clock vs presented spine-frame PTS
    if (tSec - this.fromSec >= this.nextDriftSampleAt && spinePresentedSeqSec !== null) {
      this.drift.push({
        atSec: Math.round((tSec - this.fromSec) * 10) / 10,
        driftMs: Math.round((tSec - spinePresentedSeqSec) * 1000 * 100) / 100
      })
      this.nextDriftSampleAt += 1
    }

    this.onTime?.(Math.round(tSec * FLICKS_PER_SECOND))
    this.raf = requestAnimationFrame(this.tick)
  }

  pause(): void {
    const wasPlaying = this.playing
    this.playing = false
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf)
      this.raf = null
    }
    this.audio?.stop()
    for (const pump of this.pumps.values()) pump.dispose()
    this.pumps.clear()
    if (wasPlaying) this.onPlayState?.(false)
  }

  /** Paused single-frame render at an arbitrary time (scrub/seek path). */
  async renderStill(
    sequence: Sequence,
    snapshot: LibrarySnapshot,
    timeFlicks: number
  ): Promise<void> {
    if (this.playing || this.compositor === null) return
    const token = ++this.stillToken
    const tSec = timeFlicks / FLICKS_PER_SECOND
    const items = this.buildItems(sequence, snapshot).filter(
      (item) => tSec >= item.startSec && tSec < item.endSec
    )
    const layers: CompositedLayer[] = []
    for (const item of items) {
      try {
        const handle = await sessionFor(item.asset)
        if (token !== this.stillToken) return // superseded by a newer seek/play
        const mediaFlicks = (item.mediaInSec + (tSec - item.startSec)) * FLICKS_PER_SECOND
        const generator = handle.decodeRange(mediaFlicks, 1)
        const first = await generator.next()
        await generator.return(undefined)
        if (token !== this.stillToken) {
          if (first.done !== true) (first.value as VideoFrame).close()
          return
        }
        layers.push({
          slot: item.clipId,
          frame: first.done === true ? null : first.value,
          fx: item.fx
        })
      } catch {
        layers.push({ slot: item.clipId, frame: null, fx: item.fx }) // decode failure: keep last texture
      }
    }
    if (token === this.stillToken && this.compositor !== null) {
      this.compositor.draw(layers)
    } else {
      for (const layer of layers) layer.frame?.close()
    }
  }
}

export const playbackEngine = new PlaybackEngine()
