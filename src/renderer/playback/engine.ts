import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import {
  sequenceDuration,
  type CaptionSettings,
  type ClipFx,
  type Sequence,
  type TitleData
} from '../../shared/timeline/model'
import { evaluateFxAt } from '../../shared/timeline/fx-eval'
import {
  transitionAt,
  transitionsOf,
  editPointIndexOfCut,
  type ActiveTransition
} from '../../shared/timeline/transitions'
import type { AssetView, LibrarySnapshot } from '../../shared/types'
import { activeCueAt, buildCues, type CaptionCue } from '../captions/cues'
import { renderCaption } from '../captions/render'
import { ensureTranscripts, transcriptCacheVersion } from '../transcript/cache'
import { projectTranscript } from '../transcript/projection'
import { renderTitle } from '../titles/render'
import { AudioGraphController } from './audio-graph'
import { Compositor, SEQUENCE_H, SEQUENCE_W, type CompositedLayer } from './compositor/compositor'
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
  /** null for titles (no media asset). */
  asset: AssetView | null
  /** Sequence-space interval, seconds. */
  startSec: number
  endSec: number
  mediaInSec: number
  fx: ClipFx | undefined
  /** 0 = spine; >0 connected video lanes, painted ascending. */
  layer: number
  titleData?: TitleData
  /** Transition half-widths extending this item's visible window. */
  inHalfSec: number
  outHalfSec: number
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

/** Sequential frame source for export: lookahead-1, presentation-due frames. */
class OfflinePump {
  private generator: AsyncGenerator<VideoFrame> | null = null
  private current: VideoFrame | null = null
  private lookahead: VideoFrame | null = null
  private done = false
  private lastUploadedPts = -1

  constructor(private item: PlayItem) {}

  async open(startMediaSec: number): Promise<void> {
    if (this.item.asset === null) return
    const handle = await sessionFor(this.item.asset)
    this.generator = handle.decodeRange(
      Math.max(0, startMediaSec) * FLICKS_PER_SECOND,
      Number.MAX_SAFE_INTEGER
    )
  }

  /** Clone of the frame due at mediaMicros — only when it CHANGED (texture reuse). */
  async frameFor(mediaMicros: number): Promise<VideoFrame | null> {
    if (this.generator === null) return null
    while (!this.done) {
      if (this.lookahead === null) {
        const result = await this.generator.next()
        if (result.done === true) {
          this.done = true
          break
        }
        this.lookahead = result.value
      }
      if (this.lookahead !== null && this.lookahead.timestamp <= mediaMicros) {
        this.current?.close()
        this.current = this.lookahead
        this.lookahead = null
      } else {
        break
      }
    }
    if (this.current !== null && this.current.timestamp !== this.lastUploadedPts) {
      this.lastUploadedPts = this.current.timestamp
      return this.current.clone()
    }
    return null
  }

  dispose(): void {
    this.current?.close()
    this.lookahead?.close()
    this.current = null
    this.lookahead = null
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
    this.captionCache = null // fresh compositor has no '__captions__' texture yet
  }

  detach(): void {
    this.pause()
    this.compositor?.dispose()
    this.compositor = null
  }

  get isPlaying(): boolean {
    return this.playing
  }

  private exporting = false

  get isExporting(): boolean {
    return this.exporting
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

  /** Visible video/title items (spine layer 0, connected lanes ascending). */
  private buildItems(sequence: Sequence, snapshot: LibrarySnapshot): PlayItem[] {
    const items: PlayItem[] = []
    // transition half-widths per spine clip: at the cut before it (in) and after it (out)
    const halves = new Map<string, { inHalf: number; outHalf: number }>()
    for (const transition of transitionsOf(sequence)) {
      const index = editPointIndexOfCut(sequence, transition.afterClipId)
      if (index === -1) continue
      const half = transition.durationFlicks / 2 / FLICKS_PER_SECOND
      const left = sequence.spine[index]
      const right = sequence.spine[index + 1]
      halves.set(left.id, { ...(halves.get(left.id) ?? { inHalf: 0, outHalf: 0 }), outHalf: half })
      halves.set(right.id, { ...(halves.get(right.id) ?? { inHalf: 0, outHalf: 0 }), inHalf: half })
    }
    let position = 0
    for (const item of sequence.spine) {
      if (item.kind === 'clip') {
        const asset = snapshot.assets[item.assetId]
        if (asset?.video !== undefined) {
          const half = halves.get(item.id) ?? { inHalf: 0, outHalf: 0 }
          items.push({
            clipId: item.id,
            asset,
            startSec: position / FLICKS_PER_SECOND,
            endSec: (position + item.durationFlicks) / FLICKS_PER_SECOND,
            mediaInSec: item.mediaInFlicks / FLICKS_PER_SECOND,
            fx: item.fx,
            layer: 0,
            inHalfSec: half.inHalf,
            outHalfSec: half.outHalf
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
      const isTitle = cc.titleData !== undefined
      const asset = snapshot.assets[cc.assetId]
      if (!isTitle && asset?.video === undefined) continue
      const start = parentStart + cc.offsetFlicks
      items.push({
        clipId: cc.id,
        asset: isTitle ? null : asset,
        startSec: start / FLICKS_PER_SECOND,
        endSec: (start + cc.durationFlicks) / FLICKS_PER_SECOND,
        mediaInSec: cc.mediaInFlicks / FLICKS_PER_SECOND,
        fx: cc.fx,
        layer: cc.lane,
        titleData: cc.titleData,
        inHalfSec: 0,
        outHalfSec: 0
      })
    }
    items.sort((a, b) => a.layer - b.layer)
    return items
  }

  private titleCache = new Map<
    string,
    { hash: string; canvas: HTMLCanvasElement; uploadedHash: string | null }
  >()

  /** Title layer with cached canvas texture; bumper presets bake a 0.5 s fade. */
  private titleLayer(item: PlayItem, tSec: number): CompositedLayer {
    const titleData = item.titleData!
    const hash = JSON.stringify(titleData)
    let entry = this.titleCache.get(item.clipId)
    if (entry === undefined || entry.hash !== hash) {
      entry = { hash, canvas: renderTitle(titleData), uploadedHash: null }
      this.titleCache.set(item.clipId, entry)
    }
    const baseFx = evaluateFxAt(
      item.fx,
      (item.mediaInSec + (tSec - item.startSec)) * FLICKS_PER_SECOND
    )
    let fade = 1
    if (titleData.preset === 'bumper') {
      fade = Math.max(0, Math.min(1, (tSec - item.startSec) / 0.5, (item.endSec - tSec) / 0.5))
    }
    const layer: CompositedLayer = {
      slot: item.clipId,
      frame: null,
      fx: { ...baseFx, opacity: baseFx.opacity * fade },
      image: entry.uploadedHash === hash ? undefined : entry.canvas
    }
    entry.uploadedHash = hash
    return layer
  }

  private sequence: Sequence | null = null

  /** Active caption state for the current play/still/export pass (null = off). */
  private captionState: { cues: CaptionCue[]; settings: CaptionSettings } | null = null
  /** Cues memoized per (sequence reference, transcript cache version). */
  private cueMemo: { sequence: Sequence; version: number; cues: CaptionCue[] } | null = null
  private captionCache: { key: string; canvas: HTMLCanvasElement; uploaded: boolean } | null = null

  /**
   * Derive the cue list from the transcript projection when captions are
   * enabled. Awaits the shared transcript cache (local file fetches); assets
   * whose transcription has not finished yet simply contribute no cues.
   */
  private async prepareCaptions(sequence: Sequence, snapshot: LibrarySnapshot): Promise<void> {
    const settings = sequence.captions
    if (settings === undefined || !settings.enabled) {
      this.captionState = null
      return
    }
    const transcripts = await ensureTranscripts(sequence, snapshot)
    const version = transcriptCacheVersion()
    if (
      this.cueMemo === null ||
      this.cueMemo.sequence !== sequence ||
      this.cueMemo.version !== version
    ) {
      this.cueMemo = {
        sequence,
        version,
        cues: buildCues(projectTranscript(sequence, transcripts))
      }
    }
    this.captionState = { cues: this.cueMemo.cues, settings }
  }

  /** Caption layer for the cue active at tSec, painted last (above titles). */
  private captionLayer(tSec: number): CompositedLayer | null {
    if (this.captionState === null) return null
    const { cues, settings } = this.captionState
    const active = activeCueAt(cues, tSec * FLICKS_PER_SECOND)
    if (active === null) return null
    const cue = cues[active.cueIndex]
    // block ignores the active word — avoid re-rasterizing 3×/sec for nothing
    const wordKey = settings.preset === 'block' ? 0 : active.wordIndex
    const key = `${cue.startFlicks}|${cue.text}|${wordKey}|${JSON.stringify(settings)}`
    if (this.captionCache === null || this.captionCache.key !== key) {
      this.captionCache = {
        key,
        canvas: renderCaption(cue, settings, active.wordIndex),
        uploaded: false
      }
    }
    const layer: CompositedLayer = {
      slot: '__captions__',
      frame: null,
      fx: undefined,
      image: this.captionCache.uploaded ? undefined : this.captionCache.canvas
    }
    this.captionCache.uploaded = true
    return layer
  }

  async play(sequence: Sequence, snapshot: LibrarySnapshot, fromFlicks: number): Promise<void> {
    if (this.exporting) return
    this.pause()
    this.stillToken += 1
    const audio = this.ensureAudio()
    if (audio.ctx.state === 'suspended') await audio.ctx.resume()
    await this.prepareCaptions(sequence, snapshot)
    this.sequence = sequence
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

    // start/stop pumps: pre-roll ahead of each clip's (possibly extended) window
    for (const item of this.items) {
      if (item.titleData !== undefined || item.asset === null) continue
      const visibleFrom = item.startSec - item.inHalfSec
      const visibleTo = item.endSec + item.outHalfSec
      const active = effectiveT >= visibleFrom - PRE_ROLL_SEC && effectiveT < visibleTo
      const pump = this.pumps.get(item.clipId)
      if (active && pump === undefined) {
        const startMediaSec = Math.max(
          0,
          item.mediaInSec + (Math.max(effectiveT, visibleFrom) - item.startSec)
        )
        const newPump = new ClipPump(item, sessionFor(item.asset))
        newPump.start(startMediaSec)
        this.pumps.set(item.clipId, newPump)
      } else if (!active && pump !== undefined) {
        pump.dispose()
        this.pumps.delete(item.clipId)
      }
    }

    // present due frames for visible items (windows extended by transitions)
    const activeTransition =
      this.sequence === null ? null : transitionAt(this.sequence, effectiveT * FLICKS_PER_SECOND)
    const visibleItems = this.items.filter(
      (item) =>
        effectiveT >= item.startSec - item.inHalfSec && effectiveT < item.endSec + item.outHalfSec
    )
    const dueBySlot = new Map<string, VideoFrame | null>()
    let spinePresentedSeqSec: number | null = null
    for (const item of visibleItems) {
      if (item.titleData !== undefined) continue
      const pump = this.pumps.get(item.clipId)
      if (pump === undefined) continue
      const mediaMicros = (item.mediaInSec + (effectiveT - item.startSec)) * 1_000_000
      dueBySlot.set(item.clipId, pump.takeDueFrame(mediaMicros))
      const isDriftAnchor =
        item.layer === 0 && (activeTransition === null || item.clipId === activeTransition.aClipId)
      if (isDriftAnchor && pump.presentedPtsMicros >= 0) {
        spinePresentedSeqSec = item.startSec + pump.presentedPtsMicros / 1_000_000 - item.mediaInSec
      }
    }
    this.compositor.draw(this.assembleLayers(visibleItems, dueBySlot, activeTransition, effectiveT))

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

  /** One shared layer assembly for tick, renderStill and exportReplay. */
  private assembleLayers(
    visibleItems: PlayItem[],
    frames: Map<string, VideoFrame | null>,
    activeTransition: ActiveTransition | null,
    tSec: number
  ): CompositedLayer[] {
    const layers: CompositedLayer[] = []
    for (const item of visibleItems) {
      if (item.titleData !== undefined) {
        layers.push(this.titleLayer(item, tSec))
        continue
      }
      if (!frames.has(item.clipId)) continue
      // keyframed params evaluate at this frame's MEDIA time (fx-eval.ts)
      const fx = evaluateFxAt(
        item.fx,
        (item.mediaInSec + (tSec - item.startSec)) * FLICKS_PER_SECOND
      )
      if (activeTransition !== null && item.layer === 0) {
        if (item.clipId === activeTransition.bClipId) continue // folded into the blend
        if (item.clipId === activeTransition.aClipId) {
          layers.push({
            slot: item.clipId,
            frame: frames.get(item.clipId)!,
            fx,
            blend: {
              slotB: activeTransition.bClipId,
              frameB: frames.get(activeTransition.bClipId) ?? null,
              progress: activeTransition.progress,
              kind: activeTransition.kind
            }
          })
          continue
        }
      }
      layers.push({ slot: item.clipId, frame: frames.get(item.clipId)!, fx })
    }
    // captions paint last — above the spine, connected lanes, and titles
    const caption = this.captionLayer(tSec)
    if (caption !== null) layers.push(caption)
    return layers
  }

  /**
   * Deterministic export replay: render frame i at its centered time through
   * the SAME items/transition/title/color pipeline as preview, then hand the
   * top-down RGBA pixels to the (awaited, backpressuring) callback.
   * Returns false if cancelled.
   */
  async exportReplay(
    sequence: Sequence,
    snapshot: LibrarySnapshot,
    frameCount: number,
    frameFlicks: number,
    onFrame: (rgba: Uint8ClampedArray, frameIndex: number) => Promise<void>,
    isCancelled: () => boolean
  ): Promise<boolean> {
    if (this.compositor === null) throw new Error('compositor is not attached')
    this.pause()
    this.stillToken += 1
    this.exporting = true
    this.sequence = sequence
    await this.prepareCaptions(sequence, snapshot)
    const items = this.buildItems(sequence, snapshot)
    const pumps = new Map<string, OfflinePump>()
    try {
      for (let i = 0; i < frameCount; i++) {
        if (isCancelled()) return false
        const tSec = ((i + 0.5) * frameFlicks) / FLICKS_PER_SECOND
        const visible = items.filter(
          (item) => tSec >= item.startSec - item.inHalfSec && tSec < item.endSec + item.outHalfSec
        )
        for (const item of visible) {
          if (item.titleData !== undefined || item.asset === null) continue
          if (!pumps.has(item.clipId)) {
            const pump = new OfflinePump(item)
            await pump.open(
              item.mediaInSec + (Math.max(tSec, item.startSec - item.inHalfSec) - item.startSec)
            )
            pumps.set(item.clipId, pump)
          }
        }
        for (const [clipId, pump] of pumps) {
          if (!visible.some((item) => item.clipId === clipId)) {
            pump.dispose()
            pumps.delete(clipId)
          }
        }
        const frames = new Map<string, VideoFrame | null>()
        for (const item of visible) {
          if (item.titleData !== undefined) continue
          const pump = pumps.get(item.clipId)
          if (pump === undefined) continue
          const mediaMicros = (item.mediaInSec + (tSec - item.startSec)) * 1_000_000
          frames.set(item.clipId, await pump.frameFor(mediaMicros))
        }
        const activeTransition = transitionAt(sequence, tSec * FLICKS_PER_SECOND)
        this.compositor.draw(this.assembleLayers(visible, frames, activeTransition, tSec))
        const pixels = this.compositor.readPixels(0, 0, SEQUENCE_W, SEQUENCE_H)
        await onFrame(pixels, i)
      }
      return true
    } finally {
      this.exporting = false
      for (const pump of pumps.values()) pump.dispose()
    }
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
    // never fight an active export for the compositor (a mid-export library
    // snapshot broadcast, e.g. proxy creation, retriggers still effects)
    if (this.playing || this.exporting || this.compositor === null) return
    const token = ++this.stillToken
    const tSec = timeFlicks / FLICKS_PER_SECOND
    await this.prepareCaptions(sequence, snapshot)
    if (token !== this.stillToken) return // superseded while awaiting transcripts
    const items = this.buildItems(sequence, snapshot).filter(
      (item) => tSec >= item.startSec - item.inHalfSec && tSec < item.endSec + item.outHalfSec
    )
    const activeTransition = transitionAt(sequence, timeFlicks)
    const frames = new Map<string, VideoFrame | null>()
    for (const item of items) {
      if (item.titleData !== undefined || item.asset === null) continue
      try {
        const handle = await sessionFor(item.asset)
        if (token !== this.stillToken) return // superseded by a newer seek/play
        const mediaFlicks = Math.max(
          0,
          (item.mediaInSec + (tSec - item.startSec)) * FLICKS_PER_SECOND
        )
        const generator = handle.decodeRange(mediaFlicks, 1)
        const first = await generator.next()
        await generator.return(undefined)
        if (token !== this.stillToken) {
          if (first.done !== true) (first.value as VideoFrame).close()
          return
        }
        frames.set(item.clipId, first.done === true ? null : first.value)
      } catch {
        frames.set(item.clipId, null) // decode failure: keep last texture
      }
    }
    const layers = this.assembleLayers(items, frames, activeTransition, tSec)
    if (token === this.stillToken && this.compositor !== null) {
      this.compositor.draw(layers)
    } else {
      for (const layer of layers) {
        layer.frame?.close()
        layer.blend?.frameB?.close()
      }
    }
  }
}

export const playbackEngine = new PlaybackEngine()
