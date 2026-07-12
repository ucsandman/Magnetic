import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { addTransition, rippleDeleteRange } from '../../shared/timeline/ops'
import { clip, F, seq } from '../../shared/timeline/testing'
import type { AudioEnvelope } from '../../shared/types'
import { scoreFlow } from './flow-score'

/** 10 s envelope, silent between the given seconds (50 ms windows, -80 dB). */
function envelopeWithGap(fromSec: number, toSec: number): AudioEnvelope {
  const rmsDb = new Array(200).fill(-20)
  for (let i = fromSec * 20; i < toSec * 20; i++) rmsDb[i] = -80
  return { windowMs: 50, rmsDb }
}

describe('scoreFlow', () => {
  it('gives a clean single-clip cut a perfect score', () => {
    const report = scoreFlow(seq([clip('a', 300)]), new Map())
    expect(report.score).toBe(100)
    expect(report.flags).toEqual([])
  })

  it('flags residual dead air with its position', () => {
    const envelopes = new Map([['asset-a', envelopeWithGap(2, 4)]])
    const report = scoreFlow(seq([clip('a', 300)]), envelopes)
    expect(report.score).toBeLessThan(100)
    const flag = report.flags.find((candidate) => candidate.kind === 'dead-air')
    expect(flag).toBeDefined()
    expect(flag!.flicks).toBeGreaterThanOrEqual(2 * FLICKS_PER_SECOND)
    expect(flag!.flicks).toBeLessThan(4 * FLICKS_PER_SECOND)
  })

  it('flags an untransitioned jump cut between same-asset clips', () => {
    // a range delete inside one clip leaves two same-asset clips with a media gap
    const base = seq([clip('a', 300)])
    const cut = rippleDeleteRange(base, { fromFlicks: 100 * F, toFlicks: 160 * F }).next
    const report = scoreFlow(cut, new Map())
    const flag = report.flags.find((candidate) => candidate.kind === 'jump-cut')
    expect(flag).toBeDefined()
    expect(flag!.flicks).toBe(100 * F) // at the cut point
  })

  it('does not flag a jump cut once a transition covers it', () => {
    const base = seq([clip('a', 300, 30)])
    const cut = rippleDeleteRange(base, { fromFlicks: 100 * F, toFlicks: 160 * F }).next
    const smoothed = addTransition(cut, {
      editPointIndex: 0,
      durationFlicks: 30 * F,
      kind: 'dissolve'
    }).next
    const report = scoreFlow(smoothed, new Map())
    expect(report.flags.find((candidate) => candidate.kind === 'jump-cut')).toBeUndefined()
  })

  it('flags sub-half-second slivers', () => {
    const report = scoreFlow(seq([clip('a', 300), clip('b', 10)]), new Map()) // 10 frames = 0.33s
    const flag = report.flags.find((candidate) => candidate.kind === 'short-clip')
    expect(flag).toBeDefined()
    expect(flag!.flicks).toBe(300 * F)
  })

  it('never scores below zero', () => {
    const slivers = Array.from({ length: 40 }, (_, i) => clip(`c${i}`, 5))
    const report = scoreFlow(seq(slivers), new Map())
    expect(report.score).toBe(0)
  })
})
