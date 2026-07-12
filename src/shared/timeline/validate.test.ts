import { describe, expect, it } from 'vitest'
import { clip, connected, F, gap, seq } from './testing'
import { validateSequence } from './validate'

describe('validateSequence', () => {
  it('accepts a legal sequence', () => {
    expect(validateSequence(seq([clip('a', 10), gap('g', 5), clip('b', 8)]))).toEqual([])
  })

  it('accepts legal connected clips', () => {
    expect(validateSequence(seq([clip('a', 20)], [connected('c', 'a', 2, 5)]))).toEqual([])
  })

  it('rejects a clip shorter than one frame', () => {
    const bad = { ...clip('a', 1), durationFlicks: F - 1 }
    const errors = validateSequence(seq([bad]))
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('invalid-clip')
    expect(errors[0].message).toContain('a')
  })

  it('rejects duplicate spine ids', () => {
    const errors = validateSequence(seq([clip('a', 10), clip('a', 5)]))
    expect(errors.some((e) => e.code === 'duplicate-id')).toBe(true)
  })

  it('rejects a media window that overruns the source', () => {
    const bad = { ...clip('a', 10), mediaInFlicks: 595 * F } // 595 + 10 > 600-frame source
    const errors = validateSequence(seq([bad]))
    expect(errors.some((e) => e.code === 'out-of-range')).toBe(true)
  })

  it('rejects a connected clip whose parent is missing', () => {
    const errors = validateSequence(seq([clip('a', 20)], [connected('c', 'ghost', 0, 5)]))
    expect(errors.some((e) => e.code === 'unknown-id')).toBe(true)
  })

  it('rejects same-lane overlapping connected clips', () => {
    const errors = validateSequence(
      seq([clip('a', 40)], [connected('c1', 'a', 0, 10), connected('c2', 'a', 5, 10)])
    )
    expect(errors.some((e) => e.code === 'invariant')).toBe(true)
  })

  it('allows a looped connected clip to exceed its source duration', () => {
    const bed = { ...connected('c', 'a', 0, 30), loop: true, durationFlicks: 1200 * F }
    expect(validateSequence(seq([clip('a', 500)], [bed]))).toEqual([])
  })

  it('collects multiple errors instead of stopping at the first', () => {
    const short = { ...clip('a', 1), durationFlicks: F - 1 }
    const errors = validateSequence(seq([short, clip('a', 5)], [connected('c', 'nope', 0, 5)]))
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})
