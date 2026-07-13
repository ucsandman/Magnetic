import { describe, expect, it } from 'vitest'
import { deriveSegments } from './segments'
import type { Marker } from './model'
import { clip, F, seq } from './testing'

const mark = (over: Partial<Marker>): Marker => ({
  id: over.id ?? 'm',
  assetId: 'asset-a',
  atMediaFlicks: 0,
  text: 'note',
  color: 'blue',
  ...over
})

describe('deriveSegments', () => {
  it('one clip: marker + later end marker -> one segment with exact seconds', () => {
    const base = {
      ...seq([clip('a', 300)]), // 300 frames @30fps = 10s
      markers: [
        mark({ id: 'start', text: 'clip: Hook', atMediaFlicks: 0 }),
        mark({ id: 'stop', text: 'end', atMediaFlicks: 150 * F }) // 5s
      ]
    }
    const segments = deriveSegments(base)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ id: 'hook', title: 'Hook', startSec: 0, endSec: 5 })
  })

  it('two clip: markers with no end -> first segment ends at second start', () => {
    const base = {
      ...seq([clip('a', 300)]), // 10s
      markers: [
        mark({ id: 'a', text: 'clip: A', atMediaFlicks: 0 }),
        mark({ id: 'b', text: 'clip: B', atMediaFlicks: 150 * F }) // 5s
      ]
    }
    const segments = deriveSegments(base)
    expect(segments).toEqual([
      { id: 'a', title: 'A', startSec: 0, endSec: 5 },
      { id: 'b', title: 'B', startSec: 5, endSec: 10 }
    ])
  })

  it('clip: with nothing after -> ends at min(start+90, sequence end)', () => {
    const base = {
      ...seq([clip('a', 150)]), // 5s, shorter than the 90s cap
      markers: [mark({ id: 'only', text: 'clip: Only', atMediaFlicks: 0 })]
    }
    const segments = deriveSegments(base)
    expect(segments).toEqual([{ id: 'only', title: 'Only', startSec: 0, endSec: 5 }])
  })

  it('cap case: next marker 120s later -> endSec = start + 90', () => {
    const base = {
      ...seq([clip('a', 6000)]), // 200s, long enough to hold a 120s gap
      markers: [
        mark({ id: 'a', text: 'clip: A', atMediaFlicks: 0 }),
        mark({ id: 'b', text: 'clip: B', atMediaFlicks: 3600 * F }) // 120s
      ]
    }
    const segments = deriveSegments(base)
    expect(segments[0]).toEqual({ id: 'a', title: 'A', startSec: 0, endSec: 90 })
  })

  it('excludes a marker whose asset is not shown by any clip (invisible)', () => {
    const base = {
      ...seq([clip('a', 300)]), // 10s
      markers: [
        mark({ id: 'ghost', text: 'clip: Hidden', assetId: 'asset-ghost', atMediaFlicks: 0 }),
        mark({ id: 'real', text: 'clip: Visible', atMediaFlicks: 0 })
      ]
    }
    const segments = deriveSegments(base)
    expect(segments).toEqual([{ id: 'visible', title: 'Visible', startSec: 0, endSec: 10 }])
  })

  it('ignores non-clip: markers as both starts and end boundaries', () => {
    const base = {
      ...seq([clip('a', 600)]), // 20s
      markers: [
        mark({ id: 'note1', text: 'random note', atMediaFlicks: 0 }),
        mark({ id: 'real', text: 'clip: Real', atMediaFlicks: 60 * F }), // 2s
        mark({ id: 'note2', text: 'FYI check this', atMediaFlicks: 240 * F }) // 8s, must not act as end
      ]
    }
    const segments = deriveSegments(base)
    expect(segments).toEqual([{ id: 'real', title: 'Real', startSec: 2, endSec: 20 }])
  })

  it('slugs the title (clip: Guard decisions! -> id guard-decisions)', () => {
    const base = {
      ...seq([clip('a', 300)]),
      markers: [mark({ id: 'a', text: 'clip: Guard decisions!', atMediaFlicks: 0 })]
    }
    const segments = deriveSegments(base)
    expect(segments[0].id).toBe('guard-decisions')
    expect(segments[0].title).toBe('Guard decisions!')
  })

  it('gives duplicate titles deterministic -2/-3 suffixes', () => {
    const base = {
      ...seq([clip('a', 900)]), // 30s
      markers: [
        mark({ id: 'a1', text: 'clip: Intro', atMediaFlicks: 0 }),
        mark({ id: 'a2', text: 'clip: Intro', atMediaFlicks: 300 * F }), // 10s
        mark({ id: 'a3', text: 'clip: Intro', atMediaFlicks: 600 * F }) // 20s
      ]
    }
    const segments = deriveSegments(base)
    expect(segments.map((s) => s.id)).toEqual(['intro', 'intro-2', 'intro-3'])
  })

  it('returns segments sorted by startSec regardless of marker array order', () => {
    const base = {
      ...seq([clip('a', 900)]), // 30s
      markers: [
        mark({ id: 'late', text: 'clip: Late', atMediaFlicks: 600 * F }), // 20s, listed first
        mark({ id: 'early', text: 'clip: Early', atMediaFlicks: 0 }) // listed second
      ]
    }
    const segments = deriveSegments(base)
    expect(segments.map((s) => s.title)).toEqual(['Early', 'Late'])
    expect(segments[0].startSec).toBeLessThan(segments[1].startSec)
  })
})
