import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { SequenceWord } from '../transcript/projection'
import { activeCueAt, buildCues, LINE_CHAR_BUDGET, MAX_WORD_GAP_FLICKS } from './cues'

const S = FLICKS_PER_SECOND

function word(
  text: string,
  startSec: number,
  endSec: number,
  options: { clipId?: string; clipBoundary?: boolean } = {}
): SequenceWord {
  return {
    text,
    seqStartFlicks: startSec * S,
    seqEndFlicks: endSec * S,
    p: 0.95,
    clipId: options.clipId ?? 'clip-a',
    clipBoundary: options.clipBoundary ?? false,
    isFiller: false
  }
}

describe('buildCues', () => {
  it('returns no cues for an empty transcript', () => {
    expect(buildCues([])).toEqual([])
  })

  it('groups contiguous words into one cue with joined text and word bounds', () => {
    const cues = buildCues([word('the', 0, 0.2), word('quick', 0.25, 0.5), word('fox', 0.55, 0.9)])
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('the quick fox')
    expect(cues[0].startFlicks).toBe(0)
    expect(cues[0].endFlicks).toBe(0.9 * S)
    expect(cues[0].words).toHaveLength(3)
    // karaoke timing data is preserved per word
    expect(cues[0].words[1]).toEqual({
      text: 'quick',
      startFlicks: 0.25 * S,
      endFlicks: 0.5 * S
    })
  })

  it('breaks on a word gap larger than 0.6 s (the gap itself has no cue)', () => {
    const cues = buildCues([word('hello', 0, 0.4), word('there', 1.2, 1.6)])
    expect(cues).toHaveLength(2)
    expect(cues[0].endFlicks).toBe(0.4 * S)
    expect(cues[1].startFlicks).toBe(1.2 * S)
  })

  it('does NOT break on a gap of exactly the threshold', () => {
    const cues = buildCues([
      word('a', 0, 0.4),
      word('b', 0.4 + MAX_WORD_GAP_FLICKS / S, 0.4 + MAX_WORD_GAP_FLICKS / S + 0.2)
    ])
    expect(cues).toHaveLength(1)
  })

  it('breaks when the line budget would be exceeded', () => {
    const words: SequenceWord[] = []
    for (let i = 0; i < 12; i++) {
      // 12 × "abcde " = 71 chars > 2 × 32-char budget → 3 cues
      words.push(word('abcde', i * 0.3, i * 0.3 + 0.25))
    }
    const cues = buildCues(words)
    expect(cues.length).toBeGreaterThan(1)
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(LINE_CHAR_BUDGET)
    }
  })

  it('never splits a single overlong word', () => {
    const long = 'a'.repeat(LINE_CHAR_BUDGET + 10)
    const cues = buildCues([word(long, 0, 0.5)])
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe(long)
  })

  it('breaks at clip boundaries even without a gap (cuts never share a cue)', () => {
    const cues = buildCues([
      word('end', 0, 0.3, { clipId: 'clip-a', clipBoundary: true }),
      word('start', 0.31, 0.6, { clipId: 'clip-b', clipBoundary: true })
    ])
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('end')
    expect(cues[1].text).toBe('start')
  })
})

describe('activeCueAt', () => {
  const cues = buildCues([
    word('one', 0, 0.3),
    word('two', 0.35, 0.6),
    word('three', 2, 2.4) // > 0.6 s gap → second cue
  ])

  it('finds the cue containing the time and the active word', () => {
    expect(activeCueAt(cues, 0.1 * S)).toEqual({ cueIndex: 0, wordIndex: 0 })
    expect(activeCueAt(cues, 0.4 * S)).toEqual({ cueIndex: 0, wordIndex: 1 })
    expect(activeCueAt(cues, 2.1 * S)).toEqual({ cueIndex: 1, wordIndex: 0 })
  })

  it('returns null before the first cue, between cues, and at/after a cue end', () => {
    expect(activeCueAt(cues, -1)).toBeNull()
    expect(activeCueAt(cues, 1 * S)).toBeNull() // silence between cues
    expect(activeCueAt(cues, 0.6 * S)).toBeNull() // half-open end
    expect(activeCueAt(cues, 10 * S)).toBeNull()
  })

  it('handles an empty cue list', () => {
    expect(activeCueAt([], 0)).toBeNull()
  })
})
