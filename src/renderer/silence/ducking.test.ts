import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { AudioEnvelope } from '../../shared/types'
import { clip, connected, deepFreeze, FPS30 } from '../../shared/timeline/testing'
import type { Sequence } from '../../shared/timeline/model'
import { planDucking } from './ducking'

const SEC = FLICKS_PER_SECOND
const frames = (seconds: number): number => Math.round(seconds * 30)

/** Envelope with speech (−20 dB) over [speechFromSec, speechToSec), silence elsewhere. */
function envelope(totalSec: number, speechFromSec: number, speechToSec: number): AudioEnvelope {
  const windows = Math.ceil((totalSec * 1000) / 50)
  const rmsDb = Array.from({ length: windows }, (_, i) => {
    const atSec = (i * 50) / 1000
    return atSec >= speechFromSec && atSec < speechToSec ? -20 : -100
  })
  return { windowMs: 50, rmsDb }
}

/** 10 s dialogue spine clip + a music bed connected under all of it. */
function fixture(): Sequence {
  const music = { ...connected('m', 'a', 0, frames(10), -2), loop: true }
  return deepFreeze({
    id: 'seq',
    fps: FPS30,
    spine: [clip('a', frames(10))],
    connected: [music]
  })
}

describe('planDucking', () => {
  it('ducks the music bed exactly where the dialogue clip has speech', () => {
    const envelopes = new Map([['asset-a', envelope(10, 2, 6)]])
    const plans = planDucking(fixture(), envelopes)
    expect(plans).toHaveLength(1)
    expect(plans[0].clipId).toBe('m')
    expect(plans[0].ranges).toHaveLength(1)
    expect(plans[0].ranges[0].fromClipFlicks / SEC).toBeCloseTo(2, 1)
    expect(plans[0].ranges[0].toClipFlicks / SEC).toBeCloseTo(6, 1)
  })

  it('returns no plan when the dialogue is silent throughout', () => {
    const envelopes = new Map([['asset-a', envelope(10, 0, 0)]])
    expect(planDucking(fixture(), envelopes)).toHaveLength(0)
  })

  it('merges dips separated by short pauses so the bed does not pump', () => {
    // speech 1-4 s and 4.5-8 s: the 0.5 s pause is below the merge threshold
    const envelopes = new Map([
      [
        'asset-a',
        {
          windowMs: 50,
          rmsDb: Array.from({ length: 200 }, (_, i) => {
            const atSec = (i * 50) / 1000
            const speaking = (atSec >= 1 && atSec < 4) || (atSec >= 4.5 && atSec < 8)
            return speaking ? -20 : -100
          })
        }
      ]
    ])
    const plans = planDucking(fixture(), envelopes)
    expect(plans[0].ranges).toHaveLength(1)
    expect(plans[0].ranges[0].fromClipFlicks / SEC).toBeCloseTo(1, 1)
    expect(plans[0].ranges[0].toClipFlicks / SEC).toBeCloseTo(8, 1)
  })

  it('ignores clips that are not music-role', () => {
    const sfx = { ...connected('m', 'a', 0, frames(10), -2), role: 'sfx' as const }
    const sequence = deepFreeze({
      id: 'seq',
      fps: FPS30,
      spine: [clip('a', frames(10))],
      connected: [sfx]
    })
    const envelopes = new Map([['asset-a', envelope(10, 2, 6)]])
    expect(planDucking(sequence, envelopes)).toHaveLength(0)
  })
})
