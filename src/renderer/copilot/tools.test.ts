import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { clip, F, seq } from '../../shared/timeline/testing'
import { EDIT_TOOLS, executeEditTool } from './tools'

// 10 s + 5 s clips @30fps; b starts 1 s into its source so the edit point
// between them has media handles on both sides (transitions need them)
const base = seq([clip('a', 300), clip('b', 150, 30)])

describe('executeEditTool', () => {
  it('ripple_delete_range removes the range and reports a summary', () => {
    const outcome = executeEditTool(base, 'ripple_delete_range', { from_sec: 2, to_sec: 3.5 })
    expect(outcome.ok).toBe(true)
    const total = outcome.next.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
    expect(total).toBe(450 * F - 1.5 * FLICKS_PER_SECOND)
    expect(outcome.summary).toContain('0:02.0')
    expect(outcome.summary).toContain('0:03.5')
    expect(outcome.timeRefFlicks).toBe(2 * FLICKS_PER_SECOND)
    // the frozen base is untouched (deepFreeze would have thrown otherwise)
    expect(base.spine).toHaveLength(2)
  })

  it('returns the typed op error and an unchanged sequence for an unknown clip', () => {
    const outcome = executeEditTool(base, 'blade', { clip_id: 'ghost', at_sec: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('unknown-id')
    expect(outcome.next).toBe(base)
    expect(outcome.summary).toBeNull()
  })

  it('treats a boundary blade as an explicit no-op, not a change', () => {
    const outcome = executeEditTool(base, 'blade', { clip_id: 'a', at_sec: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.next).toBe(base)
    expect(outcome.summary).toBeNull()
    expect(outcome.resultText).toContain('no-op')
  })

  it('trim_clip head shrinks the front of the clip', () => {
    const outcome = executeEditTool(base, 'trim_clip', {
      clip_id: 'b',
      edge: 'head',
      delta_sec: 1
    })
    expect(outcome.ok).toBe(true)
    const b = outcome.next.spine.find((item) => item.id === 'b')!
    expect(b.durationFlicks).toBe(150 * F - FLICKS_PER_SECOND)
  })

  it('add_transition attaches at an edit point', () => {
    const outcome = executeEditTool(base, 'add_transition', {
      edit_point_index: 0, // the cut between a and b
      duration_sec: 1,
      kind: 'dissolve'
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.next.transitions?.length ?? 0).toBe(1)
    expect(outcome.summary).toContain('dissolve')
  })

  it('rejects malformed input with a readable error instead of throwing', () => {
    const outcome = executeEditTool(base, 'ripple_delete_range', { from_sec: 'two' })
    expect(outcome.ok).toBe(false)
    expect(outcome.next).toBe(base)
    expect(outcome.resultText.toLowerCase()).toContain('invalid')
  })

  it('rejects an unknown tool name', () => {
    const outcome = executeEditTool(base, 'export_video', {})
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('unknown tool')
  })
})

describe('EDIT_TOOLS', () => {
  it('declares every executor tool with an input schema, and no export tool', () => {
    const names = EDIT_TOOLS.map((tool) => tool.name)
    expect(names).toContain('ripple_delete_range')
    expect(names).toContain('blade')
    expect(names).toContain('trim_clip')
    expect(names).toContain('move_clip')
    expect(names).toContain('add_transition')
    expect(names.some((name) => name.includes('export'))).toBe(false)
    for (const tool of EDIT_TOOLS) {
      expect(tool.input_schema).toBeDefined()
      expect(tool.description!.length).toBeGreaterThan(20)
    }
  })
})
