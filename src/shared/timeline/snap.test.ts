import { describe, expect, it } from 'vitest'
import { collectSnapPoints, snapTime } from './snap'
import { F, clip, connected, gap, seq } from './testing'

describe('collectSnapPoints', () => {
  it('collects every spine boundary including 0 and the sequence end', () => {
    const s = seq([clip('a', 10), gap('g', 5), clip('b', 20)])
    const points = collectSnapPoints(s, null)
    const times = points.filter((p) => p.kind === 'clip-edge').map((p) => p.timeFlicks)
    expect(times).toEqual([0, 10 * F, 15 * F, 35 * F])
  })

  it('includes connected clip edges', () => {
    const s = seq([clip('a', 20)], [connected('cc', 'a', 5, 3)])
    const times = collectSnapPoints(s, null)
      .filter((p) => p.kind === 'connected-edge')
      .map((p) => p.timeFlicks)
    expect(times).toEqual([5 * F, 8 * F])
  })

  it('includes the playhead when given', () => {
    const s = seq([clip('a', 10)])
    const points = collectSnapPoints(s, 7 * F)
    expect(points.some((p) => p.kind === 'playhead' && p.timeFlicks === 7 * F)).toBe(true)
  })

  it('deduplicates coincident boundaries', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const points = collectSnapPoints(s, 10 * F)
    const at10 = points.filter((p) => p.timeFlicks === 10 * F)
    expect(at10).toHaveLength(1)
  })
})

describe('snapTime', () => {
  const s = seq([clip('a', 10), clip('b', 10)])
  const points = collectSnapPoints(s, null)

  it('snaps to the nearest point within tolerance', () => {
    const result = snapTime(10 * F + 100, points, F)
    expect(result.timeFlicks).toBe(10 * F)
    expect(result.snapped?.timeFlicks).toBe(10 * F)
  })

  it('returns the input unchanged outside tolerance', () => {
    const result = snapTime(5 * F, points, F)
    expect(result.timeFlicks).toBe(5 * F)
    expect(result.snapped).toBeNull()
  })

  it('prefers the closest point when several are in tolerance', () => {
    const result = snapTime(9 * F, points, 20 * F)
    expect(result.timeFlicks).toBe(10 * F) // 10F is closer than 0 or 20F
  })

  it('an exact hit snaps with zero delta', () => {
    const result = snapTime(20 * F, points, F)
    expect(result.timeFlicks).toBe(20 * F)
    expect(result.snapped).not.toBeNull()
  })
})
