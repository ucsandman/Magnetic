import { describe, expect, it } from 'vitest'
import { sequenceDuration, type Clip } from './model'
import { connectedStartOf } from './model'
import { rippleDeleteRange } from './ops'
import { F, clip, connected, gap, seq } from './testing'

describe('rippleDeleteRange', () => {
  it('removes a mid-clip range: clip splits and the middle vanishes', () => {
    const s = seq([clip('a', 10)])
    const { next, error } = rippleDeleteRange(s, { fromFlicks: 3 * F, toFlicks: 7 * F })
    expect(error).toBeUndefined()
    expect(sequenceDuration(next)).toBe(6 * F)
    const [head, tail] = next.spine as Clip[]
    expect(head.durationFlicks).toBe(3 * F)
    expect(tail.durationFlicks).toBe(3 * F)
    expect(tail.mediaInFlicks).toBe(7 * F) // media skips the removed middle
  })

  it('removes a range spanning a cut across two clips', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const { next } = rippleDeleteRange(s, { fromFlicks: 8 * F, toFlicks: 13 * F })
    expect(sequenceDuration(next)).toBe(15 * F)
    const [head, tail] = next.spine as Clip[]
    expect(head.id).toBe('a')
    expect(head.durationFlicks).toBe(8 * F)
    expect(tail.durationFlicks).toBe(7 * F)
    expect(tail.mediaInFlicks).toBe(3 * F)
  })

  it('removes whole clips and gaps fully inside the range', () => {
    const s = seq([clip('a', 5), gap('g', 5), clip('b', 5)])
    const { next } = rippleDeleteRange(s, { fromFlicks: 4 * F, toFlicks: 12 * F })
    expect(sequenceDuration(next)).toBe(7 * F)
    expect(next.spine.map((item) => item.durationFlicks)).toEqual([4 * F, 3 * F])
  })

  it('clamps to the sequence, normalizes reversed ranges, no-ops empty ones', () => {
    const s = seq([clip('a', 10)])
    expect(
      sequenceDuration(rippleDeleteRange(s, { fromFlicks: 8 * F, toFlicks: 99 * F }).next)
    ).toBe(8 * F)
    expect(rippleDeleteRange(s, { fromFlicks: 5 * F, toFlicks: 5 * F }).next).toBe(s)
    // reversed bounds normalize and still delete [3,7)
    expect(
      sequenceDuration(rippleDeleteRange(s, { fromFlicks: 7 * F, toFlicks: 3 * F }).next)
    ).toBe(6 * F)
  })

  it('keeps connected clips attached across the ripple', () => {
    const s = seq([clip('a', 10), clip('b', 10)], [connected('cc', 'b', 2, 3)])
    const { next } = rippleDeleteRange(s, { fromFlicks: 2 * F, toFlicks: 6 * F })
    // b moved left by 4 frames; cc rides along
    expect(connectedStartOf(next, 'cc')).toBe(8 * F)
  })

  it('returns a restore inverse (single undo step)', () => {
    const s = seq([clip('a', 10)])
    const result = rippleDeleteRange(s, { fromFlicks: 2 * F, toFlicks: 4 * F })
    expect(result.inverse).toEqual({ type: 'restore', sequence: s })
  })
})
