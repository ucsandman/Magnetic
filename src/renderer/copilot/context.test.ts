import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { clip, seq } from '../../shared/timeline/testing'
import type { AudioEnvelope, Transcript } from '../../shared/types'
import { buildCopilotContext, TRANSCRIPT_CHAR_CAP } from './context'

const SEC = FLICKS_PER_SECOND

function transcriptOf(words: { text: string; fromSec: number; toSec: number }[]): Transcript {
  return {
    words: words.map((w) => ({
      text: w.text,
      startFlicks: w.fromSec * SEC,
      endFlicks: w.toSec * SEC,
      p: 0.95
    }))
  }
}

/** 10 s envelope, silent between the given seconds (50 ms windows, -80 dB). */
function envelopeWithGap(fromSec: number, toSec: number): AudioEnvelope {
  const rmsDb = new Array(200).fill(-20)
  for (let i = fromSec * 20; i < toSec * 20; i++) rmsDb[i] = -80
  return { windowMs: 50, rmsDb }
}

const names = new Map([['asset-a', 'interview.mp4']])

describe('buildCopilotContext', () => {
  it('describes the timeline: duration, clip names, and positions', () => {
    const context = buildCopilotContext(seq([clip('a', 300)]), new Map(), new Map(), names)
    expect(context).toContain('interview.mp4')
    expect(context).toContain('10.0s') // total duration
    expect(context).toContain('0:00.0') // clip start
  })

  it('includes the transcript with timestamps', () => {
    const transcripts = new Map([
      [
        'asset-a',
        transcriptOf([
          { text: 'welcome', fromSec: 1, toSec: 1.4 },
          { text: 'back', fromSec: 1.4, toSec: 1.7 }
        ])
      ]
    ])
    const context = buildCopilotContext(seq([clip('a', 300)]), transcripts, new Map(), names)
    expect(context).toContain('welcome back')
    expect(context).toContain('[0:01.0]')
  })

  it('includes detected silence ranges', () => {
    const envelopes = new Map([['asset-a', envelopeWithGap(2, 4)]])
    const context = buildCopilotContext(seq([clip('a', 300)]), new Map(), envelopes, names)
    expect(context).toContain('Dead air')
    expect(context).toMatch(/0:02\.\d.*0:03\.\d/) // padded range inside 2s..4s
  })

  it('announces transcript truncation instead of silently cutting it', () => {
    const words = Array.from({ length: 30000 }, (_, i) => ({
      text: `word${i}`,
      fromSec: i * 0.3,
      toSec: i * 0.3 + 0.2
    }))
    const longClip = {
      ...clip('a', 300),
      durationFlicks: 9500 * SEC,
      sourceDurationFlicks: 9500 * SEC
    }
    const context = buildCopilotContext(
      seq([longClip]),
      new Map([['asset-a', transcriptOf(words)]]),
      new Map(),
      names
    )
    expect(context.length).toBeLessThan(TRANSCRIPT_CHAR_CAP + 5000)
    expect(context).toContain('truncated')
  })

  it('says so when the timeline is empty', () => {
    const context = buildCopilotContext(seq([]), new Map(), new Map(), new Map())
    expect(context).toContain('empty')
  })
})
