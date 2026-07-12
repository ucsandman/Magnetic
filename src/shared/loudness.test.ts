import { describe, expect, it } from 'vitest'
import { normalizeGainDb, parseIntegratedLufs } from './loudness'

const EBUR128_TAIL = `
[Parsed_ebur128_0 @ 0000023f] Summary:

  Integrated loudness:
    I:         -23.4 LUFS
    Threshold: -33.9 LUFS

  Loudness range:
    LRA:         4.7 LU
    Threshold: -43.6 LUFS
    LRA low:   -26.6 LUFS
    LRA high:  -21.9 LUFS
`

describe('parseIntegratedLufs', () => {
  it('extracts the integrated loudness from the ebur128 summary', () => {
    expect(parseIntegratedLufs(EBUR128_TAIL)).toBe(-23.4)
  })

  it('returns null for silence or missing summaries', () => {
    expect(parseIntegratedLufs('I: -inf LUFS')).toBeNull()
    expect(parseIntegratedLufs('no summary here')).toBeNull()
  })
})

describe('normalizeGainDb', () => {
  it('returns the gain that brings the measured loudness to the target', () => {
    expect(normalizeGainDb(-23.4, -14)).toBeCloseTo(9.4)
  })

  it('clamps into the volumeDb range the mixer supports', () => {
    expect(normalizeGainDb(-80, -14)).toBe(12)
    expect(normalizeGainDb(20, -14)).toBe(-34)
    expect(normalizeGainDb(200, -14)).toBe(-96)
  })
})
