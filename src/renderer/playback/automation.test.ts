import { describe, expect, it } from 'vitest'
import { clipGainPoints, gainAutomationFor } from './automation'

describe('gainAutomationFor', () => {
  it('a fade-in yields a rising envelope from 0 to the clip gain', () => {
    const points = gainAutomationFor({
      startCtxTime: 10,
      durationSec: 5,
      fadeInSec: 1,
      fadeOutSec: 0,
      volumeDb: 0
    })
    expect(points[0]).toEqual({ atCtxTime: 10, value: 0 })
    expect(points[1]).toEqual({ atCtxTime: 11, value: 1 })
    // strictly rising over the fade
    expect(points[1].value).toBeGreaterThan(points[0].value)
  })

  it('a fade-out ramps back to silence at the clip end', () => {
    const points = gainAutomationFor({
      startCtxTime: 0,
      durationSec: 4,
      fadeInSec: 0,
      fadeOutSec: 2,
      volumeDb: 0
    })
    const last = points[points.length - 1]
    expect(points.some((p) => p.atCtxTime === 2 && p.value === 1)).toBe(true)
    expect(last).toEqual({ atCtxTime: 4, value: 0 })
  })

  it('volumeDb scales the plateau gain', () => {
    const points = gainAutomationFor({
      startCtxTime: 0,
      durationSec: 2,
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
      volumeDb: -6
    })
    const plateau = points.find((p) => p.atCtxTime === 0.5)!
    expect(plateau.value).toBeCloseTo(Math.pow(10, -6 / 20), 5)
  })

  it('no fades yields a constant gain', () => {
    const points = gainAutomationFor({
      startCtxTime: 3,
      durationSec: 2,
      fadeInSec: 0,
      fadeOutSec: 0,
      volumeDb: 0
    })
    expect(points).toEqual([{ atCtxTime: 3, value: 1 }])
  })

  it('overlapping fades clamp at the midpoint', () => {
    const points = gainAutomationFor({
      startCtxTime: 0,
      durationSec: 2,
      fadeInSec: 5,
      fadeOutSec: 5,
      volumeDb: 0
    })
    // fades clamp to half the clip each — envelope rises then falls, no overlap
    const times = points.map((p) => p.atCtxTime)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(points[0].value).toBe(0)
    expect(points[points.length - 1].value).toBe(0)
  })
})

describe('clipGainPoints', () => {
  it('returns the input unchanged when no point precedes atTime', () => {
    const points = [
      { atCtxTime: 0, value: 0 },
      { atCtxTime: 1, value: 1 }
    ]
    expect(clipGainPoints(points, 0)).toBe(points)
    expect(clipGainPoints(points, -5)).toBe(points)
  })

  it('interpolates mid-ramp: a chunk boundary inside a fade resumes at the exact value', () => {
    // fade-in 0→1 over [-2, 3]; at t=0 the ramp is 40% done
    const clipped = clipGainPoints(
      [
        { atCtxTime: -2, value: 0 },
        { atCtxTime: 3, value: 1 }
      ],
      0
    )
    expect(clipped[0].atCtxTime).toBe(0)
    expect(clipped[0].value).toBeCloseTo(0.4, 10)
    expect(clipped.slice(1)).toEqual([{ atCtxTime: 3, value: 1 }])
  })

  it('holds the last value when every point is in the past', () => {
    const clipped = clipGainPoints(
      [
        { atCtxTime: -5, value: 0 },
        { atCtxTime: -2, value: 0.7 }
      ],
      0
    )
    expect(clipped).toEqual([{ atCtxTime: 0, value: 0.7 }])
  })

  it('drops completed ramps but keeps future ones (fade-in done, fade-out ahead)', () => {
    const clipped = clipGainPoints(
      [
        { atCtxTime: -10, value: 0 },
        { atCtxTime: -9, value: 1 },
        { atCtxTime: 40, value: 1 },
        { atCtxTime: 42, value: 0 }
      ],
      0
    )
    expect(clipped).toEqual([
      { atCtxTime: 0, value: 1 },
      { atCtxTime: 40, value: 1 },
      { atCtxTime: 42, value: 0 }
    ])
  })
})
