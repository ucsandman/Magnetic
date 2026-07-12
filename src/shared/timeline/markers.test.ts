import { describe, expect, it } from 'vitest'
import { visibleMarkers, type Marker } from './model'
import { addMarker, blade, removeMarker, rippleDelete, updateMarker } from './ops'
import { clip, connected, F, seq } from './testing'

const mark = (over: Partial<Marker> = {}): Marker => ({
  id: 'm1',
  assetId: 'asset-a',
  atMediaFlicks: 40 * F,
  text: 'note',
  color: 'blue',
  ...over
})

describe('addMarker', () => {
  it('adds a marker anchored to media shown by a spine clip', () => {
    const base = seq([clip('a', 100)])
    const result = addMarker(base, {
      assetId: 'asset-a',
      atMediaFlicks: 40 * F,
      text: 'fix color',
      color: 'orange'
    })
    expect(result.error).toBeUndefined()
    expect(result.next.markers).toHaveLength(1)
    expect(result.next.markers?.[0].text).toBe('fix color')
  })

  it('rejects a marker on media no clip is showing', () => {
    const base = seq([clip('a', 100, 20)]) // window is media [20,120)
    const result = addMarker(base, {
      assetId: 'asset-a',
      atMediaFlicks: 5 * F,
      text: 'x',
      color: 'blue'
    })
    expect(result.error?.code).toBe('invalid-target')
  })

  it('rejects unknown colors', () => {
    const base = seq([clip('a', 100)])
    const result = addMarker(base, {
      assetId: 'asset-a',
      atMediaFlicks: 40 * F,
      text: 'x',
      color: 'mauve' as never
    })
    expect(result.error?.code).toBe('invalid-target')
  })
})

describe('removeMarker / updateMarker', () => {
  const base = { ...seq([clip('a', 100)]), markers: [mark()] }

  it('removes by id', () => {
    const result = removeMarker(base, { markerId: 'm1' })
    expect(result.next.markers).toHaveLength(0)
  })

  it('updates text and color', () => {
    const result = updateMarker(base, { markerId: 'm1', text: 'done', color: 'green' })
    expect(result.next.markers?.[0].text).toBe('done')
    expect(result.next.markers?.[0].color).toBe('green')
  })

  it('fails on unknown ids', () => {
    expect(removeMarker(base, { markerId: 'zzz' }).error?.code).toBe('unknown-id')
    expect(updateMarker(base, { markerId: 'zzz', text: 'x' }).error?.code).toBe('unknown-id')
  })
})

describe('marker survival across edits (media anchoring)', () => {
  it('survives a blade: the tail half still shows the media moment', () => {
    const base = { ...seq([clip('a', 100)]), markers: [mark({ atMediaFlicks: 70 * F })] }
    const result = blade(base, { clipId: 'a', timeFlicks: 30 * F })
    expect(result.next.markers).toHaveLength(1)
    const visible = visibleMarkers(result.next)
    expect(visible).toHaveLength(1)
    expect(visible[0].seqFlicks).toBe(70 * F)
  })

  it('is pruned when the clip showing it is deleted', () => {
    const base = {
      ...seq([clip('a', 100), clip('b', 50)]),
      markers: [mark(), mark({ id: 'm2', assetId: 'asset-b', atMediaFlicks: 10 * F })]
    }
    const result = rippleDelete(base, { ids: ['a'] })
    expect(result.next.markers?.map((m) => m.id)).toEqual(['m2'])
    // and undo restores it: the inverse carries the pre-edit sequence
    expect(result.inverse.sequence.markers).toHaveLength(2)
  })
})

describe('visibleMarkers', () => {
  it('maps media anchors through spine and connected windows, sorted by time', () => {
    const base = {
      ...seq([clip('a', 100)], [connected('c', 'a', 10, 50, -1)]),
      markers: [
        mark({ id: 'm2', assetId: 'asset-c', atMediaFlicks: 5 * F }),
        mark({ id: 'm1', atMediaFlicks: 80 * F })
      ]
    }
    const visible = visibleMarkers(base)
    expect(visible.map((entry) => entry.marker.id)).toEqual(['m2', 'm1'])
    expect(visible[0].seqFlicks).toBe(15 * F) // parent start 0 + offset 10 + (5 − 0)
    expect(visible[1].seqFlicks).toBe(80 * F)
  })

  it('returns empty when there are no markers', () => {
    expect(visibleMarkers(seq([clip('a', 100)]))).toEqual([])
  })
})
