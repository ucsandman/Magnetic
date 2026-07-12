import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { SequenceWord } from './projection'
import { findQuote } from './quote'

const SEC = FLICKS_PER_SECOND

function word(text: string, atSec: number, clipId = 'a'): SequenceWord {
  return {
    text,
    seqStartFlicks: atSec * SEC,
    seqEndFlicks: (atSec + 0.4) * SEC,
    p: 0.9,
    clipId,
    clipBoundary: false,
    isFiller: false
  }
}

const WORDS = [
  word('So', 0),
  word('today', 0.5),
  word("we're", 1),
  word('going', 1.5),
  word('to', 2),
  word('talk', 2.5),
  word('about', 3),
  word('editing.', 3.5),
  word('Really,', 4),
  word('we', 4.5),
  word('are', 5),
  word('going', 5.5),
  word('to.', 6)
]

describe('findQuote', () => {
  it('finds a quote ignoring case and punctuation', () => {
    const matches = findQuote(WORDS, 'Talk About Editing')
    expect(matches).toHaveLength(1)
    expect(matches[0].fromIndex).toBe(5)
    expect(matches[0].toIndex).toBe(7)
    expect(matches[0].fromFlicks).toBe(2.5 * SEC)
    expect(matches[0].toFlicks).toBe(3.9 * SEC)
  })

  it('returns every occurrence of an ambiguous quote', () => {
    const matches = findQuote(WORDS, 'going to')
    expect(matches).toHaveLength(2)
    expect(matches[0].fromIndex).toBe(3)
    expect(matches[1].fromIndex).toBe(11)
  })

  it('returns empty for text that never occurs', () => {
    expect(findQuote(WORDS, 'purple monkey dishwasher')).toEqual([])
    expect(findQuote(WORDS, '')).toEqual([])
  })
})
