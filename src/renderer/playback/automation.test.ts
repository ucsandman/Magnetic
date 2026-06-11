import { describe, expect, it } from 'vitest'
import { gainAutomationFor } from './automation'

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
