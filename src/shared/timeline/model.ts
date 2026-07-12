import type { Rational } from '../timecode'

/**
 * Magnetic timeline kernel data model. Pure data + derived position helpers —
 * zero DOM, zero Electron, zero IO.
 *
 * THE key design decision: spine items store only durations; timeline
 * positions are DERIVED by summation. Gaps are explicit GapClip items, so the
 * spine is contiguous and overlap-free by construction.
 */

/**
 * Audio role — FCP-style metadata grouping, not track assignment. Roles drive
 * mixer-level mute/solo and auto-ducking targets. Every audible clip has an
 * EFFECTIVE role (explicit tag, or derived: looped bed → music, else
 * dialogue); gaps and titles have none.
 */
export type ClipRole = 'dialogue' | 'music' | 'sfx'

/** The nine video/color scalars that can carry keyframe animation. */
export type AnimatableParam =
  | 'posX'
  | 'posY'
  | 'scale'
  | 'rotation'
  | 'opacity'
  | 'exposure'
  | 'contrast'
  | 'saturation'
  | 'temperature'

/**
 * One animation point. Anchored in MEDIA time (same basis as mediaInFlicks),
 * so blade/trim/ripple/rearrange need no keyframe fixups — each half of a cut
 * evaluates only its own media window.
 */
export interface Keyframe {
  atMediaFlicks: number
  value: number
  ease: 'linear' | 'easeInOut'
}

/** Per-clip effect parameters (phases 7–8): transform, color board, audio. */
export interface ClipFx {
  posX: number
  posY: number
  /** Percent, 100 = native. */
  scale: number
  /** Degrees. */
  rotation: number
  /** Percent, 100 = opaque. */
  opacity: number
  /** Color board: −1..+1 stops. */
  exposure: number
  /** 0..2, 1 = neutral. */
  contrast: number
  /** 0..2, 1 = neutral, 0 = grayscale. */
  saturation: number
  /** −1 cool .. +1 warm. */
  temperature: number
  /** Audio fades at the clip edges. */
  fadeInFlicks: number
  fadeOutFlicks: number
  /** −96..+12 dB, 0 = unity. */
  volumeDb: number
  /** −1 left .. +1 right. */
  pan: number
  /** Optional keyframe tracks per animatable param, sorted by atMediaFlicks. */
  kf?: Partial<Record<AnimatableParam, Keyframe[]>>
}

export interface Clip {
  kind: 'clip'
  id: string
  assetId: string
  mediaInFlicks: number
  durationFlicks: number
  /** Full duration of the source media — trims/slips clamp against this. */
  sourceDurationFlicks: number
  fx?: ClipFx
  /** True after Detach Audio: the clip renders video only (audio lives in a lane −1 connected clip). */
  audioDisabled?: boolean
  /** Explicit audio role tag; absent = derived by effectiveRole(). */
  role?: ClipRole
}

export interface GapClip {
  kind: 'gap'
  id: string
  durationFlicks: number
}

export type SpineItem = Clip | GapClip

export interface ConnectedClip {
  id: string
  assetId: string
  parentClipId: string
  /** Offset of this clip's start from its parent's derived start. */
  offsetFlicks: number
  /** Positive lanes stack above the spine (video), negative below (audio). */
  lane: number
  mediaInFlicks: number
  durationFlicks: number
  sourceDurationFlicks: number
  fx?: ClipFx
  titleData?: TitleData
  /** Mute this clip's audio (e.g. a paste-connected copy of a detached-audio spine clip). */
  audioDisabled?: boolean
  /**
   * Music-bed loop (loop-to-fill): the media tiles to fill durationFlicks —
   * it plays [mediaIn, sourceDuration), then wraps to the FULL source
   * [0, sourceDuration) repeatedly. While set, durationFlicks may exceed
   * sourceDurationFlicks − mediaInFlicks (trimConnected's tail clamp is
   * lifted); clearing the flag clamps the duration back into the source.
   */
  loop?: boolean
  /** Explicit audio role tag; absent = derived by effectiveRole(). */
  role?: ClipRole
}

export type TransitionKind = 'dissolve' | 'wipeL' | 'wipeR' | 'fadeBlack'

/**
 * A centered transition at a spine cut. Attached to the LEFT clip's id (not a
 * raw edit-point index) so ripple edits elsewhere cannot silently re-target it.
 */
export interface Transition {
  id: string
  afterClipId: string
  durationFlicks: number
  kind: TransitionKind
}

/** Text overlay payload carried by a connected clip (phase 8 titles). */
export interface TitleData {
  text: string
  font: string
  sizePx: number
  color: string
  /** Center position in 1920×1080 sequence space. */
  x: number
  y: number
  preset: 'basic' | 'lowerThird' | 'bumper'
}

/**
 * Sequence-level burned-in caption settings (phase: captions). Captions are
 * NEVER clips — cues derive live from the transcript projection, so every
 * edit re-derives them for free.
 */
export interface CaptionSettings {
  enabled: boolean
  preset: 'pop-in' | 'karaoke' | 'block'
  font: string
  sizePx: number
  color: string
  highlightColor: string
  position: 'bottom' | 'middle' | 'top'
}

export type MarkerColor = 'blue' | 'green' | 'orange' | 'red'

/**
 * A timeline marker, anchored in MEDIA time on an asset — the same basis as
 * keyframes, so blade/trim/ripple/move need no marker fixups. A marker shows
 * wherever a clip window contains its media moment and is pruned (undoably)
 * once no clip shows it.
 */
export interface Marker {
  id: string
  assetId: string
  atMediaFlicks: number
  text: string
  color: MarkerColor
}

export interface Sequence {
  id: string
  fps: Rational
  spine: SpineItem[]
  connected: ConnectedClip[]
  transitions?: Transition[]
  captions?: CaptionSettings
  /** Roles silenced in the mix (mute/solo UI); sorted, deduped. */
  mutedRoles?: ClipRole[]
  markers?: Marker[]
}

/**
 * The audio role a timeline item actually carries: explicit tag wins, looped
 * connected clips are music beds, everything else audible is dialogue. Gaps
 * and titles return null — there is nothing to hear.
 */
export function effectiveRole(item: SpineItem | ConnectedClip): ClipRole | null {
  if ('kind' in item && item.kind === 'gap') return null
  if ('titleData' in item && item.titleData !== undefined) return null
  if (item.role !== undefined) return item.role
  if ('loop' in item && item.loop === true) return 'music'
  return 'dialogue'
}

/** Media windows a marker could land in: every spine clip + connected media clip (titles/loops excluded). */
function markerWindows(
  seq: Sequence
): { assetId: string; seqStartFlicks: number; mediaInFlicks: number; durationFlicks: number }[] {
  const windows: {
    assetId: string
    seqStartFlicks: number
    mediaInFlicks: number
    durationFlicks: number
  }[] = []
  let position = 0
  for (const item of seq.spine) {
    if (item.kind === 'clip') {
      windows.push({
        assetId: item.assetId,
        seqStartFlicks: position,
        mediaInFlicks: item.mediaInFlicks,
        durationFlicks: item.durationFlicks
      })
    }
    position += item.durationFlicks
  }
  for (const cc of seq.connected) {
    // titles carry no media; looped beds wrap media time, breaking the linear map
    if (cc.titleData !== undefined || cc.loop === true) continue
    const start = connectedStartOf(seq, cc.id)
    if (start === null) continue
    windows.push({
      assetId: cc.assetId,
      seqStartFlicks: start,
      mediaInFlicks: cc.mediaInFlicks,
      durationFlicks: cc.durationFlicks
    })
  }
  return windows
}

/** True if some clip window currently shows this media moment. */
export function markerIsVisible(seq: Sequence, marker: Marker): boolean {
  return markerWindows(seq).some(
    (window) =>
      window.assetId === marker.assetId &&
      marker.atMediaFlicks >= window.mediaInFlicks &&
      marker.atMediaFlicks < window.mediaInFlicks + window.durationFlicks
  )
}

export interface VisibleMarker {
  marker: Marker
  seqFlicks: number
}

/**
 * Every marker projected into sequence time — one entry per window showing
 * its media moment (normally one), sorted by time.
 */
export function visibleMarkers(seq: Sequence): VisibleMarker[] {
  const markers = seq.markers
  if (markers === undefined || markers.length === 0) return []
  const windows = markerWindows(seq)
  const visible: VisibleMarker[] = []
  for (const marker of markers) {
    for (const window of windows) {
      if (window.assetId !== marker.assetId) continue
      if (
        marker.atMediaFlicks < window.mediaInFlicks ||
        marker.atMediaFlicks >= window.mediaInFlicks + window.durationFlicks
      ) {
        continue
      }
      visible.push({
        marker,
        seqFlicks: window.seqStartFlicks + (marker.atMediaFlicks - window.mediaInFlicks)
      })
    }
  }
  return visible.sort((a, b) => a.seqFlicks - b.seqFlicks)
}

export function emptySequence(id: string, fps: Rational): Sequence {
  return { id, fps, spine: [], connected: [] }
}

export function sequenceDuration(seq: Sequence): number {
  let total = 0
  for (const item of seq.spine) total += item.durationFlicks
  return total
}

/** Sorted spine edit points: 0, every item boundary, and the sequence end. */
export function spineEditPoints(seq: Sequence): number[] {
  const points = [0]
  let position = 0
  for (const item of seq.spine) {
    position += item.durationFlicks
    points.push(position)
  }
  return points
}

/** Derived start of a spine item; null if the id is not in the spine. */
export function spineStartOf(seq: Sequence, itemId: string): number | null {
  let position = 0
  for (const item of seq.spine) {
    if (item.id === itemId) return position
    position += item.durationFlicks
  }
  return null
}

/** Spine item whose half-open range [start, start+duration) contains the time. */
export function clipAtTime(seq: Sequence, timeFlicks: number): SpineItem | null {
  if (timeFlicks < 0) return null
  let position = 0
  for (const item of seq.spine) {
    if (timeFlicks < position + item.durationFlicks) return item
    position += item.durationFlicks
  }
  return null
}

/** Derived absolute start of a connected clip; null if unknown/orphaned. */
export function connectedStartOf(seq: Sequence, connectedId: string): number | null {
  const connected = seq.connected.find((candidate) => candidate.id === connectedId)
  if (connected === undefined) return null
  const parentStart = spineStartOf(seq, connected.parentClipId)
  if (parentStart === null) return null
  return parentStart + connected.offsetFlicks
}

export function spineIndexOf(seq: Sequence, itemId: string): number {
  return seq.spine.findIndex((item) => item.id === itemId)
}
