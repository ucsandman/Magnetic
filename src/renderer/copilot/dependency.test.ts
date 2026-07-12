import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { clip, seq } from '../../shared/timeline/testing'
import { dependencyGroups } from './dependency'

// two 10 s clips @30fps, b with head handles
const base = seq([clip('a', 300), clip('b', 150, 30)])

describe('dependencyGroups', () => {
  it('keeps ops on distinct pre-existing clips independent', () => {
    expect(
      dependencyGroups(base, [
        { name: 'trim_clip', input: { clip_id: 'a', edge: 'head', delta_sec: 1 } },
        { name: 'trim_clip', input: { clip_id: 'b', edge: 'tail', delta_sec: -1 } }
      ])
    ).toEqual([[0], [1]])
  })

  it('keeps an id-addressed trim independent of an earlier range delete', () => {
    expect(
      dependencyGroups(base, [
        { name: 'ripple_delete_range', input: { from_sec: 2, to_sec: 3 } },
        { name: 'trim_clip', input: { clip_id: 'b', edge: 'tail', delta_sec: -1 } }
      ])
    ).toEqual([[0], [1]])
  })

  it('groups position-addressed ops after layout-changing ops', () => {
    expect(
      dependencyGroups(base, [
        { name: 'ripple_delete_range', input: { from_sec: 2, to_sec: 3 } },
        { name: 'ripple_delete_range', input: { from_sec: 6, to_sec: 7 } }
      ])
    ).toEqual([[0, 1]])
    expect(
      dependencyGroups(base, [
        { name: 'trim_clip', input: { clip_id: 'a', edge: 'head', delta_sec: 1 } },
        {
          name: 'add_transition',
          input: { edit_point_index: 0, duration_sec: 1, kind: 'dissolve' }
        }
      ])
    ).toEqual([[0, 1]])
  })

  it('groups ops that reference ids introduced by earlier ops', () => {
    const tailId = `a:${2 * FLICKS_PER_SECOND}`
    expect(
      dependencyGroups(base, [
        { name: 'blade', input: { clip_id: 'a', at_sec: 2 } },
        { name: 'ripple_delete_clips', input: { clip_ids: [tailId] } }
      ])
    ).toEqual([[0, 1]])
  })

  it('keeps a slip independent of everything (no layout, no new ids)', () => {
    expect(
      dependencyGroups(base, [
        { name: 'ripple_delete_range', input: { from_sec: 2, to_sec: 3 } },
        { name: 'slip_clip', input: { clip_id: 'b', delta_sec: 0.5 } }
      ])
    ).toEqual([[0], [1]])
  })
})
