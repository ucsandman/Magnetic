import { describe, expect, it } from 'vitest'
import {
  clipAtTime,
  connectedStartOf,
  emptySequence,
  sequenceDuration,
  spineEditPoints,
  spineStartOf,
  type Clip,
  type GapClip,
  type Sequence
} from './model'

const FPS = { num: 30, den: 1 }
const F = 23_520_000 // one frame at 30fps, in flicks

function clip(id: string, durationFrames: number, mediaInFrames = 0): Clip {
  return {
    kind: 'clip',
    id,
    assetId: `asset-${id}`,
    mediaInFlicks: mediaInFrames * F,
    durationFlicks: durationFrames * F,
    sourceDurationFlicks: 600 * F
  }
}

function gap(id: string, durationFrames: number): GapClip {
  return { kind: 'gap', id, durationFlicks: durationFrames * F }
}

function seq(spine: Sequence['spine'], connected: Sequence['connected'] = []): Sequence {
  return { id: 'seq', fps: FPS, spine, connected }
}

describe('derived spine positions', () => {
  it('an empty sequence has zero duration', () => {
    expect(sequenceDuration(emptySequence('s', FPS))).toBe(0)
  })

  it('sequenceDuration sums all spine item durations', () => {
    const s = seq([clip('a', 10), gap('g', 5), clip('b', 20)])
    expect(sequenceDuration(s)).toBe(35 * F)
  })

  it('spineStartOf derives starts by summation', () => {
    const s = seq([clip('a', 10), gap('g', 5), clip('b', 20)])
    expect(spineStartOf(s, 'a')).toBe(0)
    expect(spineStartOf(s, 'g')).toBe(10 * F)
    expect(spineStartOf(s, 'b')).toBe(15 * F)
  })

  it('spineStartOf returns null for unknown ids', () => {
    expect(spineStartOf(seq([clip('a', 10)]), 'nope')).toBeNull()
  })

  it('clipAtTime finds the item whose half-open range contains the time', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    expect(clipAtTime(s, 0)?.id).toBe('a')
    expect(clipAtTime(s, 10 * F - 1)?.id).toBe('a')
    expect(clipAtTime(s, 10 * F)?.id).toBe('b')
    expect(clipAtTime(s, 20 * F)).toBeNull() // end is exclusive
    expect(clipAtTime(s, -1)).toBeNull()
  })

  it('spineEditPoints lists 0, every boundary, and the end', () => {
    const s = seq([clip('a', 10), gap('g', 5), clip('b', 20)])
    expect(spineEditPoints(s)).toEqual([0, 10 * F, 15 * F, 35 * F])
  })

  it('spineEditPoints of an empty sequence is just the origin', () => {
    expect(spineEditPoints(emptySequence('s', FPS))).toEqual([0])
  })

  it('connectedStartOf is parent start plus offset', () => {
    const s: Sequence = {
      ...seq([clip('a', 10), clip('b', 10)]),
      connected: [
        {
          id: 'c1',
          assetId: 'x',
          parentClipId: 'b',
          offsetFlicks: 3 * F,
          lane: 1,
          mediaInFlicks: 0,
          durationFlicks: 5 * F,
          sourceDurationFlicks: 600 * F
        }
      ]
    }
    expect(connectedStartOf(s, 'c1')).toBe(13 * F)
    expect(connectedStartOf(s, 'missing')).toBeNull()
  })

  it('connectedStartOf returns null when the parent is gone from the spine', () => {
    const s: Sequence = {
      ...seq([clip('a', 10)]),
      connected: [
        {
          id: 'c1',
          assetId: 'x',
          parentClipId: 'deleted',
          offsetFlicks: 0,
          lane: 1,
          mediaInFlicks: 0,
          durationFlicks: 5 * F,
          sourceDurationFlicks: 600 * F
        }
      ]
    }
    expect(connectedStartOf(s, 'c1')).toBeNull()
  })
})
