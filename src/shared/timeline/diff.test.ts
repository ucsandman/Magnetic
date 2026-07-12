import { describe, expect, it } from 'vitest'
import { diffDeletions } from './diff'
import { blade, move, rippleDelete, rippleDeleteRange, trimRipple } from './ops'
import { clip, F, seq } from './testing'

describe('diffDeletions', () => {
  it('marks a removed clip as its full base-time range', () => {
    const base = seq([clip('a', 100), clip('b', 50), clip('c', 80)])
    const proposed = rippleDelete(base, { ids: ['b'] }).next
    expect(diffDeletions(base, proposed)).toEqual([{ fromFlicks: 100 * F, toFlicks: 150 * F }])
  })

  it('marks a range delete across clips as the deleted base ranges', () => {
    const base = seq([clip('a', 100)])
    const proposed = rippleDeleteRange(base, { fromFlicks: 20 * F, toFlicks: 60 * F }).next
    expect(diffDeletions(base, proposed)).toEqual([{ fromFlicks: 20 * F, toFlicks: 60 * F }])
  })

  it('marks a head trim as a range at the clip start', () => {
    const base = seq([clip('a', 100), clip('b', 50)])
    const proposed = trimRipple(base, { clipId: 'b', edge: 'head', deltaFlicks: 10 * F }).next
    expect(diffDeletions(base, proposed)).toEqual([{ fromFlicks: 100 * F, toFlicks: 110 * F }])
  })

  it('marks a tail trim as a range at the clip end', () => {
    const base = seq([clip('a', 100)])
    const proposed = trimRipple(base, { clipId: 'a', edge: 'tail', deltaFlicks: -30 * F }).next
    expect(diffDeletions(base, proposed)).toEqual([{ fromFlicks: 70 * F, toFlicks: 100 * F }])
  })

  it('reports nothing for a pure rearrangement', () => {
    const base = seq([clip('a', 100), clip('b', 50)])
    const proposed = move(base, { clipId: 'b', toIndex: 0 }).next
    expect(diffDeletions(base, proposed)).toEqual([])
  })

  it('reports nothing when a clip is only bladed (both halves survive)', () => {
    const base = seq([clip('a', 100)])
    const proposed = blade(base, { clipId: 'a', timeFlicks: 40 * F }).next
    expect(diffDeletions(base, proposed)).toEqual([])
  })

  it('merges adjacent deletions from consecutive removed clips', () => {
    const base = seq([clip('a', 100), clip('b', 50), clip('c', 50), clip('d', 80)])
    const proposed = rippleDelete(base, { ids: ['b', 'c'] }).next
    expect(diffDeletions(base, proposed)).toEqual([{ fromFlicks: 100 * F, toFlicks: 200 * F }])
  })

  it('returns empty for identical sequences', () => {
    const base = seq([clip('a', 100)])
    expect(diffDeletions(base, base)).toEqual([])
  })
})
