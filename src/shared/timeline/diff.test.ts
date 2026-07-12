import { describe, expect, it } from 'vitest'
import { diffDeletions, proposedTimeAt, touchedClipIds } from './diff'
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

describe('proposedTimeAt', () => {
  const deletions = [
    { fromFlicks: 20 * F, toFlicks: 40 * F },
    { fromFlicks: 60 * F, toFlicks: 70 * F }
  ]

  it('passes through times before any deletion', () => {
    expect(proposedTimeAt(deletions, 10 * F)).toBe(10 * F)
  })

  it('shifts times after a deletion left by its length', () => {
    expect(proposedTimeAt(deletions, 50 * F)).toBe(30 * F)
    expect(proposedTimeAt(deletions, 80 * F)).toBe(50 * F)
  })

  it('clamps times inside a deletion to its start', () => {
    expect(proposedTimeAt(deletions, 30 * F)).toBe(20 * F)
    expect(proposedTimeAt(deletions, 65 * F)).toBe(40 * F)
  })

  it('is identity with no deletions', () => {
    expect(proposedTimeAt([], 123)).toBe(123)
  })
})

describe('touchedClipIds', () => {
  it('reports trimmed clips and blade-derived clips, not untouched ones', () => {
    const base = seq([clip('a', 100), clip('b', 50), clip('c', 80)])
    const proposed = rippleDeleteRange(base, { fromFlicks: 20 * F, toFlicks: 120 * F }).next
    // a is trimmed to [0,20), b's head is cut leaving a derived tail, c is untouched
    const touched = touchedClipIds(base, proposed)
    expect(touched.has('a')).toBe(true)
    expect([...touched].some((id) => id.startsWith('b:'))).toBe(true)
    expect(touched.has('c')).toBe(false)
  })

  it('reports nothing for identical sequences or pure moves', () => {
    const base = seq([clip('a', 100), clip('b', 50)])
    expect(touchedClipIds(base, base).size).toBe(0)
    const moved = move(base, { clipId: 'b', toIndex: 0 }).next
    expect(touchedClipIds(base, moved).size).toBe(0)
  })
})
