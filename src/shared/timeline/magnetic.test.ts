import { describe, expect, it } from 'vitest'
import { itemAtTime, reattachByTime, resolveLaneCollisions, spineStartIndex } from './magnetic'
import { F, clip, connected, gap, seq } from './testing'

describe('itemAtTime', () => {
  it('returns null for negative times', () => {
    expect(itemAtTime([clip('a', 10)], -1)).toBeNull()
  })

  it('returns the item and its derived start, boundaries belonging to the later item', () => {
    const spine = [clip('a', 10), gap('g', 5)]
    expect(itemAtTime(spine, 10 * F - 1)).toEqual({ item: spine[0], startFlicks: 0 })
    expect(itemAtTime(spine, 10 * F)).toEqual({ item: spine[1], startFlicks: 10 * F })
  })

  it('returns null at or beyond the sequence end', () => {
    expect(itemAtTime([clip('a', 10)], 10 * F)).toBeNull()
  })
})

describe('spineStartIndex', () => {
  it('maps every id to its prefix-sum start', () => {
    const index = spineStartIndex([clip('a', 10), gap('g', 5), clip('b', 20)])
    expect(index.get('a')).toBe(0)
    expect(index.get('g')).toBe(10 * F)
    expect(index.get('b')).toBe(15 * F)
  })
})

describe('resolveLaneCollisions', () => {
  it('cascades bumps when three clips pile onto one lane', () => {
    const spine = [clip('a', 30)]
    const ccs = [
      connected('c1', 'a', 0, 10, 1),
      connected('c2', 'a', 5, 10, 1),
      connected('c3', 'a', 8, 10, 1)
    ]
    const resolved = resolveLaneCollisions(spine, ccs)
    expect(resolved.map((cc) => cc.lane)).toEqual([1, 2, 3])
  })

  it('returns the same array reference when nothing collides', () => {
    const spine = [clip('a', 30)]
    const ccs = [connected('c1', 'a', 0, 5, 1), connected('c2', 'a', 10, 5, 1)]
    expect(resolveLaneCollisions(spine, ccs)).toBe(ccs)
  })

  it('leaves clips with missing parents alone', () => {
    const spine = [clip('a', 30)]
    const ccs = [connected('c1', 'orphan-parent', 0, 5, 1)]
    expect(resolveLaneCollisions(spine, ccs)).toBe(ccs)
  })
})

describe('reattachByTime', () => {
  it('drops clips that were already orphaned in the old sequence', () => {
    const old = seq([clip('a', 10)], [connected('cc', 'long-gone', 2, 3)])
    expect(reattachByTime(old, [clip('a', 10)], old.connected)).toEqual([])
  })
})
