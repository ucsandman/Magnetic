import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { clip, seq } from '../../shared/timeline/testing'
import type { AudioEnvelope, Transcript } from '../../shared/types'
import { cutPointsFor, planRoughCut, silenceOptionsFor } from './roughcut'

const SEC = FLICKS_PER_SECOND
const WINDOW_MS = 50
const WINDOWS_PER_SEC = 1000 / WINDOW_MS

/** 10 s envelope: speech at -20 dB except [silentFromSec, silentToSec) at -80 dB. */
function envelope(silentFromSec: number, silentToSec: number): AudioEnvelope {
  const rmsDb = new Array(10 * WINDOWS_PER_SEC).fill(-20)
  for (let i = silentFromSec * WINDOWS_PER_SEC; i < silentToSec * WINDOWS_PER_SEC; i++) {
    rmsDb[i] = -80
  }
  return { windowMs: WINDOW_MS, rmsDb }
}

function transcriptWith(words: { text: string; fromSec: number; toSec: number }[]): Transcript {
  return {
    words: words.map((w) => ({
      text: w.text,
      startFlicks: w.fromSec * SEC,
      endFlicks: w.toSec * SEC,
      p: 0.95
    }))
  }
}

// One 10 s spine clip (300 frames @ 30 fps); testing.ts assigns assetId 'asset-a'.
const sequence = seq([clip('a', 300)])

describe('planRoughCut', () => {
  it('merges silence and filler ranges into one ascending reason-tagged plan', () => {
    const envelopes = new Map([['asset-a', envelope(2, 4)]])
    const transcripts = new Map([
      [
        'asset-a',
        transcriptWith([
          { text: 'hello', fromSec: 0.5, toSec: 1.0 },
          { text: 'um', fromSec: 6.0, toSec: 6.2 },
          { text: 'world', fromSec: 7.0, toSec: 7.5 }
        ])
      ]
    ])
    const plan = planRoughCut(sequence, transcripts, envelopes)
    expect(plan).toHaveLength(2)
    // default pad insets the detected 2s..4s dead air by 100 ms per side
    expect(plan[0].reason).toBe('silence')
    expect(plan[0].fromFlicks).toBe(2 * SEC + SEC / 10)
    expect(plan[0].toFlicks).toBe(4 * SEC - SEC / 10)
    expect(plan[1].reason).toBe('filler')
    expect(plan[1].fromFlicks).toBe(6.0 * SEC)
    expect(plan[1].toFlicks).toBe(6.2 * SEC)
  })

  it('omits fillers when includeFillers is false', () => {
    const envelopes = new Map([['asset-a', envelope(2, 4)]])
    const transcripts = new Map([
      ['asset-a', transcriptWith([{ text: 'um', fromSec: 6.0, toSec: 6.2 }])]
    ])
    const plan = planRoughCut(sequence, transcripts, envelopes, { includeFillers: false })
    expect(plan).toHaveLength(1)
    expect(plan[0].reason).toBe('silence')
  })

  it('merges an overlapping filler into the silence range (silence dominates)', () => {
    const envelopes = new Map([['asset-a', envelope(2, 4)]])
    const transcripts = new Map([
      ['asset-a', transcriptWith([{ text: 'um', fromSec: 3.5, toSec: 3.7 }])]
    ])
    const plan = planRoughCut(sequence, transcripts, envelopes)
    expect(plan).toHaveLength(1)
    expect(plan[0].reason).toBe('silence')
    expect(plan[0].fromFlicks).toBe(2 * SEC + SEC / 10)
    expect(plan[0].toFlicks).toBe(4 * SEC - SEC / 10)
  })

  it('returns an empty plan when there is nothing to analyze', () => {
    expect(planRoughCut(sequence, new Map(), new Map())).toEqual([])
  })
})

describe('cutPointsFor', () => {
  it('maps applied ranges to result-sequence positions with removed durations', () => {
    const points = cutPointsFor([
      { fromFlicks: 2 * SEC, toFlicks: 4 * SEC, reason: 'silence' },
      { fromFlicks: 6 * SEC, toFlicks: 6.5 * SEC, reason: 'filler' }
    ])
    expect(points).toEqual([
      { flicks: 2 * SEC, reason: 'silence', removedFlicks: 2 * SEC },
      // 6 s in the base sequence lands at 4 s once the 2 s cut before it is gone
      { flicks: 4 * SEC, reason: 'filler', removedFlicks: 0.5 * SEC }
    ])
  })

  it('returns no points for an empty plan', () => {
    expect(cutPointsFor([])).toEqual([])
  })
})

describe('silenceOptionsFor', () => {
  it('is monotonic: higher aggressiveness lowers the bar for a cut', () => {
    const gentle = silenceOptionsFor(0)
    const fierce = silenceOptionsFor(1)
    expect(fierce.thresholdDb).toBeGreaterThan(gentle.thresholdDb)
    expect(fierce.minDurationFlicks).toBeLessThan(gentle.minDurationFlicks)
    expect(gentle.padFlicks).toBe(fierce.padFlicks)
  })
})
