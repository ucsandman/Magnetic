import { describe, expect, it } from 'vitest'
import type { Transcript } from '../../shared/types'
import { fillerRanges, projectTranscript } from './projection'
import { F, clip, seq } from '../../shared/timeline/testing'

function transcript(words: [string, number, number, number?][]): Transcript {
  return {
    words: words.map(([text, startFrames, endFrames, p]) => ({
      text,
      startFlicks: startFrames * F,
      endFlicks: endFrames * F,
      p: p ?? 0.9
    }))
  }
}

describe('projectTranscript', () => {
  it('projects detached-audio clips once (spine muted, lane -1 child carries the words)', () => {
    const base = clip('a', 60)
    const s = seq(
      [{ ...base, audioDisabled: true }],
      [
        {
          id: 'a:audio',
          assetId: base.assetId,
          parentClipId: 'a',
          offsetFlicks: 0,
          lane: -1,
          mediaInFlicks: 0,
          durationFlicks: 60 * F,
          sourceDurationFlicks: 600 * F
        }
      ]
    )
    const words = projectTranscript(s, new Map([['asset-a', transcript([['once', 10, 20]])]]))
    expect(words).toHaveLength(1)
    expect(words[0].clipId).toBe('a:audio')
  })


  it('maps words through mediaIn into sequence time and drops mid-cut words', () => {
    // clip shows media [60, 120); word A inside, word B straddles the cut
    const s = seq([clip('a', 60, 60)])
    const words = projectTranscript(
      s,
      new Map([
        [
          'asset-a',
          transcript([
            ['inside', 70, 80],
            ['straddle', 115, 125]
          ])
        ]
      ])
    )
    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('inside')
    expect(words[0].seqStartFlicks).toBe(10 * F) // 70 - 60 after the clip start at 0
    expect(words[0].clipBoundary).toBe(true)
  })

  it('concatenates clips in spine order with boundary markers', () => {
    const s = seq([clip('a', 50), clip('b', 50)])
    const words = projectTranscript(
      s,
      new Map([
        [
          'asset-a',
          transcript([
            ['one', 0, 10],
            ['two', 20, 30]
          ])
        ],
        ['asset-b', transcript([['three', 5, 15]])]
      ])
    )
    expect(words.map((word) => word.text)).toEqual(['one', 'two', 'three'])
    expect(words.map((word) => word.clipBoundary)).toEqual([true, false, true])
    expect(words[2].seqStartFlicks).toBe(55 * F) // clip b starts at 50
  })

  it('marks standalone fillers and two-word phrases', () => {
    const s = seq([clip('a', 100)])
    const words = projectTranscript(
      s,
      new Map([
        [
          'asset-a',
          transcript([
            ['Um,', 0, 5],
            ['hello', 6, 10],
            ['you', 12, 14],
            ['know,', 14, 16],
            ['liked', 18, 22]
          ])
        ]
      ])
    )
    expect(words.map((word) => word.isFiller)).toEqual([true, false, true, true, false])
  })

  it('"like" needs low confidence or surrounding pauses', () => {
    const s = seq([clip('a', 200)])
    const words = projectTranscript(
      s,
      new Map([
        [
          'asset-a',
          transcript([
            ['I', 0, 2],
            ['like', 2, 4], // confident, no pauses → kept
            ['dogs', 4, 6],
            ['like', 30, 32, 0.3] // low confidence → filler
          ])
        ]
      ])
    )
    expect(words[1].isFiller).toBe(false)
    expect(words[3].isFiller).toBe(true)
  })

  it('fillerRanges merges adjacent fillers into deletable spans', () => {
    const s = seq([clip('a', 100)])
    const words = projectTranscript(
      s,
      new Map([
        [
          'asset-a',
          transcript([
            ['um', 0, 3],
            ['uh', 3, 6],
            ['fine', 10, 14],
            ['er', 50, 53]
          ])
        ]
      ])
    )
    const ranges = fillerRanges(words)
    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toEqual({ fromFlicks: 0, toFlicks: 6 * F })
    expect(ranges[1]).toEqual({ fromFlicks: 50 * F, toFlicks: 53 * F })
  })
})
