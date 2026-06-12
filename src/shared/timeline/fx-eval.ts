import type { AnimatableParam, ClipFx, Keyframe } from './model'
import { DEFAULT_FX } from './ops'

/**
 * Pure per-frame fx evaluation (keyframe animation). evaluateFxAt is the
 * single evaluation function shared by preview and export — the playback
 * engine calls it with each clip's media time, and the inspector calls it to
 * show the value under the playhead. Keyframes are anchored in MEDIA time, so
 * blade/trim/ripple need no fixups; values hold (clamp) outside the range.
 */

export const ANIMATABLE_PARAMS: readonly AnimatableParam[] = [
  'posX',
  'posY',
  'scale',
  'rotation',
  'opacity',
  'exposure',
  'contrast',
  'saturation',
  'temperature'
]

/**
 * Track value at a media time. Values clamp outside the first/last keyframe;
 * within a segment the LEFT keyframe's ease applies (easeInOut = smoothstep).
 */
export function evaluateTrack(track: Keyframe[], mediaFlicks: number): number {
  const first = track[0]
  if (mediaFlicks <= first.atMediaFlicks) return first.value
  const last = track[track.length - 1]
  if (mediaFlicks >= last.atMediaFlicks) return last.value
  let i = 1
  while (track[i].atMediaFlicks < mediaFlicks) i++
  const a = track[i - 1]
  const b = track[i]
  const t = (mediaFlicks - a.atMediaFlicks) / (b.atMediaFlicks - a.atMediaFlicks)
  const eased = a.ease === 'easeInOut' ? t * t * (3 - 2 * t) : t
  return a.value + (b.value - a.value) * eased
}

/**
 * Resolve a clip's fx at a media time: static scalars pass through, keyframed
 * params interpolate. Returns a plain ClipFx with no kf field, ready for the
 * compositor (un-keyframed fx passes through untouched, identity included).
 */
export function evaluateFxAt(fx: ClipFx | undefined, mediaFlicks: number): ClipFx {
  if (fx === undefined) return DEFAULT_FX
  if (fx.kf === undefined) return fx
  const resolved: ClipFx = { ...fx }
  delete resolved.kf
  for (const param of ANIMATABLE_PARAMS) {
    const track = fx.kf[param]
    if (track === undefined || track.length === 0) continue
    resolved[param] = evaluateTrack(track, mediaFlicks)
  }
  return resolved
}

/** New sorted track with the keyframe inserted, replacing any at the same time. */
export function upsertKeyframe(track: Keyframe[] | undefined, keyframe: Keyframe): Keyframe[] {
  const kept = (track ?? []).filter((k) => k.atMediaFlicks !== keyframe.atMediaFlicks)
  return [...kept, keyframe].sort((a, b) => a.atMediaFlicks - b.atMediaFlicks)
}

/** Nearest keyframe time strictly before (-1) / after (+1) a media time, or null. */
export function adjacentKeyframeTime(
  track: Keyframe[],
  mediaFlicks: number,
  direction: -1 | 1
): number | null {
  if (direction === 1) {
    for (const keyframe of track) {
      if (keyframe.atMediaFlicks > mediaFlicks) return keyframe.atMediaFlicks
    }
    return null
  }
  let previous: number | null = null
  for (const keyframe of track) {
    if (keyframe.atMediaFlicks < mediaFlicks) previous = keyframe.atMediaFlicks
  }
  return previous
}

/**
 * Shift every keyframe track from one media window to another (Paste
 * Attributes onto a clip with a different mediaIn): the animation keeps its
 * shape relative to the clip's visible start instead of freezing on the
 * clamped first/last value of a foreign media range.
 */
export function rebaseKeyframes(
  fx: ClipFx,
  fromMediaInFlicks: number,
  toMediaInFlicks: number
): ClipFx {
  if (fx.kf === undefined || fromMediaInFlicks === toMediaInFlicks) return fx
  const delta = toMediaInFlicks - fromMediaInFlicks
  const kf: NonNullable<ClipFx['kf']> = {}
  for (const param of ANIMATABLE_PARAMS) {
    const track = fx.kf[param]
    if (track === undefined || track.length === 0) continue
    kf[param] = track.map((keyframe) => ({
      ...keyframe,
      atMediaFlicks: keyframe.atMediaFlicks + delta
    }))
  }
  return { ...fx, kf }
}

/** Sorted, de-duplicated union of keyframe times across tracks (timeline markers). */
export function keyframeMarkerTimes(fx: ClipFx | undefined): number[] {
  const kf = fx?.kf
  if (kf === undefined) return []
  const times = new Set<number>()
  for (const track of Object.values(kf)) {
    for (const keyframe of track ?? []) times.add(keyframe.atMediaFlicks)
  }
  return [...times].sort((a, b) => a - b)
}
