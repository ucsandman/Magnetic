import { describe, expect, it } from 'vitest'
import {
  adjacentKeyframeTime,
  evaluateFxAt,
  evaluateTrack,
  keyframeMarkerTimes,
  upsertKeyframe
,
  rebaseKeyframes
} from './fx-eval'
import { DEFAULT_FX } from './ops'
import type { ClipFx, Keyframe } from './model'
import { F, deepFreeze } from './testing'

const kf = (atFrames: number, value: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({
  atMediaFlicks: atFrames * F,
  value,
  ease
})

const fxWith = (tracks: ClipFx['kf']): ClipFx =>
  deepFreeze({ ...DEFAULT_FX, scale: 50, kf: tracks })

describe('evaluateFxAt', () => {
  it('undefined fx evaluates to the defaults', () => {
    expect(evaluateFxAt(undefined, 0)).toEqual(DEFAULT_FX)
  })

  it('un-keyframed fx passes through untouched (same object)', () => {
    const fx = deepFreeze({ ...DEFAULT_FX, scale: 50 })
    expect(evaluateFxAt(fx, 7 * F)).toBe(fx)
  })

  it('an empty track leaves the static scalar in place', () => {
    const fx = fxWith({ scale: [] })
    expect(evaluateFxAt(fx, 5 * F).scale).toBe(50)
  })

  it('a single keyframe is constant before, at, and after its time', () => {
    const fx = fxWith({ scale: [kf(10, 80)] })
    expect(evaluateFxAt(fx, 0).scale).toBe(80)
    expect(evaluateFxAt(fx, 10 * F).scale).toBe(80)
    expect(evaluateFxAt(fx, 99 * F).scale).toBe(80)
  })

  it('interpolates linearly between two keyframes', () => {
    const fx = fxWith({ scale: [kf(0, 100), kf(10, 40)] })
    expect(evaluateFxAt(fx, 5 * F).scale).toBe(70)
    expect(evaluateFxAt(fx, 2.5 * F).scale).toBe(85)
  })

  it('easeInOut applies smoothstep on the segment', () => {
    const fx = fxWith({ scale: [kf(0, 0, 'easeInOut'), kf(10, 100)] })
    expect(evaluateFxAt(fx, 5 * F).scale).toBe(50) // smoothstep(0.5) = 0.5
    expect(evaluateFxAt(fx, 2.5 * F).scale).toBeCloseTo(15.625) // smoothstep(0.25)
    expect(evaluateFxAt(fx, 7.5 * F).scale).toBeCloseTo(84.375) // smoothstep(0.75)
  })

  it('clamps to the first/last keyframe value outside the range', () => {
    const fx = fxWith({ scale: [kf(4, 100), kf(8, 40)] })
    expect(evaluateFxAt(fx, 0).scale).toBe(100)
    expect(evaluateFxAt(fx, 20 * F).scale).toBe(40)
  })

  it('returns exact values at keyframe times', () => {
    const fx = fxWith({ scale: [kf(0, 100), kf(4, 70), kf(10, 40)] })
    expect(evaluateFxAt(fx, 4 * F).scale).toBe(70)
    expect(evaluateFxAt(fx, 10 * F).scale).toBe(40)
  })

  it('animates each keyframed param independently, statics untouched', () => {
    const fx = deepFreeze({
      ...DEFAULT_FX,
      posX: 200,
      kf: { scale: [kf(0, 100), kf(10, 0)], opacity: [kf(0, 0), kf(10, 100)] }
    })
    const at = evaluateFxAt(fx, 5 * F)
    expect(at.scale).toBe(50)
    expect(at.opacity).toBe(50)
    expect(at.posX).toBe(200)
  })

  it('resolves to a plain ClipFx with no kf field', () => {
    const fx = fxWith({ scale: [kf(0, 100), kf(10, 40)] })
    expect(evaluateFxAt(fx, 5 * F).kf).toBeUndefined()
  })
})

describe('evaluateTrack', () => {
  it('walks multi-segment tracks with per-segment easing', () => {
    const track = [kf(0, 0, 'easeInOut'), kf(10, 100, 'linear'), kf(20, 0)]
    expect(evaluateTrack(track, 2.5 * F)).toBeCloseTo(15.625) // eased first segment
    expect(evaluateTrack(track, 15 * F)).toBe(50) // linear second segment
  })
})

describe('upsertKeyframe', () => {
  it('inserts in time order', () => {
    const track = upsertKeyframe([kf(0, 100), kf(10, 40)], kf(5, 70))
    expect(track.map((k) => k.atMediaFlicks / F)).toEqual([0, 5, 10])
  })

  it('replaces an existing keyframe at the same time', () => {
    const track = upsertKeyframe([kf(0, 100), kf(10, 40)], kf(10, 75))
    expect(track).toHaveLength(2)
    expect(track[1].value).toBe(75)
  })

  it('starts a track from undefined', () => {
    expect(upsertKeyframe(undefined, kf(3, 12))).toEqual([kf(3, 12)])
  })

  it('never mutates the input track', () => {
    const track = deepFreeze([kf(0, 100)])
    expect(upsertKeyframe(track, kf(5, 50))).toHaveLength(2)
    expect(track).toHaveLength(1)
  })
})

describe('adjacentKeyframeTime', () => {
  const track = [kf(2, 1), kf(6, 2), kf(9, 3)]

  it('finds the nearest keyframe strictly before/after', () => {
    expect(adjacentKeyframeTime(track, 7 * F, -1)).toBe(6 * F)
    expect(adjacentKeyframeTime(track, 7 * F, 1)).toBe(9 * F)
  })

  it('skips a keyframe exactly at the time', () => {
    expect(adjacentKeyframeTime(track, 6 * F, -1)).toBe(2 * F)
    expect(adjacentKeyframeTime(track, 6 * F, 1)).toBe(9 * F)
  })

  it('returns null past the ends', () => {
    expect(adjacentKeyframeTime(track, 2 * F, -1)).toBeNull()
    expect(adjacentKeyframeTime(track, 9 * F, 1)).toBeNull()
  })
})

describe('keyframeMarkerTimes', () => {
  it('unions, de-duplicates, and sorts times across tracks', () => {
    const fx = fxWith({
      scale: [kf(8, 40), kf(0, 100)],
      opacity: [kf(0, 100), kf(4, 0)]
    })
    expect(keyframeMarkerTimes(fx)).toEqual([0, 4 * F, 8 * F])
  })

  it('is empty for undefined or un-keyframed fx', () => {
    expect(keyframeMarkerTimes(undefined)).toEqual([])
    expect(keyframeMarkerTimes(deepFreeze({ ...DEFAULT_FX }))).toEqual([])
  })
})

describe('rebaseKeyframes', () => {
  it('shifts every track into the target media window', () => {
    const fx: ClipFx = {
      ...DEFAULT_FX,
      kf: {
        scale: [
          { atMediaFlicks: 10 * F, value: 100, ease: 'linear' },
          { atMediaFlicks: 20 * F, value: 40, ease: 'linear' }
        ]
      }
    }
    const rebased = rebaseKeyframes(fx, 10 * F, 40 * F)
    expect(rebased.kf?.scale?.map((k) => k.atMediaFlicks)).toEqual([40 * F, 50 * F])
    expect(rebased.kf?.scale?.map((k) => k.value)).toEqual([100, 40])
  })

  it('returns the same reference when nothing needs shifting', () => {
    const noKf: ClipFx = { ...DEFAULT_FX }
    expect(rebaseKeyframes(noKf, 0, 5 * F)).toBe(noKf)
    const fx: ClipFx = {
      ...DEFAULT_FX,
      kf: { opacity: [{ atMediaFlicks: 0, value: 100, ease: 'linear' }] }
    }
    expect(rebaseKeyframes(fx, 3 * F, 3 * F)).toBe(fx)
  })
})
