import { describe, expect, it } from 'vitest'
import { append, rippleDelete, trimRipple } from './ops'
import { UndoStack } from './undo'
import { F, clip, seq } from './testing'
import type { Clip } from './model'

function newClip(id: string, durationFrames: number): Omit<Clip, 'kind'> {
  return {
    id,
    assetId: `asset-${id}`,
    mediaInFlicks: 0,
    durationFlicks: durationFrames * F,
    sourceDurationFlicks: 600 * F
  }
}

describe('UndoStack', () => {
  it('applies ops and undo restores the deep-equal prior state', () => {
    const initial = seq([clip('a', 10)])
    const stack = new UndoStack(initial)
    stack.apply((s) => append(s, { clip: newClip('b', 5) }))
    expect(stack.current.spine.map((item) => item.id)).toEqual(['a', 'b'])
    expect(stack.undo()).toEqual(initial)
    expect(stack.current).toEqual(initial)
  })

  it('redo re-applies the undone op', () => {
    const stack = new UndoStack(seq([clip('a', 10)]))
    stack.apply((s) => append(s, { clip: newClip('b', 5) }))
    const after = stack.current
    stack.undo()
    expect(stack.redo()).toEqual(after)
    expect(stack.current).toEqual(after)
  })

  it('a new apply clears the redo stack', () => {
    const stack = new UndoStack(seq([clip('a', 10)]))
    stack.apply((s) => append(s, { clip: newClip('b', 5) }))
    stack.undo()
    stack.apply((s) => append(s, { clip: newClip('c', 5) }))
    expect(stack.canRedo).toBe(false)
    expect(stack.redo()).toBe(stack.current) // no-op
  })

  it('error results change nothing and add no history entry', () => {
    const initial = seq([clip('a', 10)])
    const stack = new UndoStack(initial)
    const result = stack.apply((s) => rippleDelete(s, { ids: ['zzz'] }))
    expect(result.error).toBeDefined()
    expect(stack.current).toBe(initial)
    expect(stack.canUndo).toBe(false)
  })

  it('clean no-ops add no history entry', () => {
    const initial = seq([clip('a', 10)])
    const stack = new UndoStack(initial)
    // trim clamped to zero delta is a clean no-op
    stack.apply((s) => trimRipple(s, { clipId: 'a', edge: 'tail', deltaFlicks: 0 }))
    expect(stack.current).toBe(initial)
    expect(stack.canUndo).toBe(false)
  })

  it('undo and redo on an empty stack return current unchanged', () => {
    const initial = seq([clip('a', 10)])
    const stack = new UndoStack(initial)
    expect(stack.undo()).toBe(initial)
    expect(stack.redo()).toBe(initial)
  })

  it('beginGroup/endGroup coalesces several ops into one undo step', () => {
    const initial = seq([clip('a', 10), clip('b', 10)])
    const stack = new UndoStack(initial)
    stack.beginGroup()
    stack.apply((s) => rippleDelete(s, { ids: ['a'] }))
    stack.apply((s) => append(s, { clip: newClip('c', 5) }))
    stack.endGroup()
    expect(stack.current.spine.map((item) => item.id)).toEqual(['b', 'c'])
    stack.undo()
    expect(stack.current).toEqual(initial)
    expect(stack.canUndo).toBe(false)
  })

  it('redo replays the whole group at once', () => {
    const initial = seq([clip('a', 10), clip('b', 10)])
    const stack = new UndoStack(initial)
    stack.beginGroup()
    stack.apply((s) => rippleDelete(s, { ids: ['a'] }))
    stack.apply((s) => append(s, { clip: newClip('c', 5) }))
    stack.endGroup()
    const after = stack.current
    stack.undo()
    expect(stack.redo()).toEqual(after)
  })

  it('a group in which nothing changed adds no history entry', () => {
    const initial = seq([clip('a', 10)])
    const stack = new UndoStack(initial)
    stack.beginGroup()
    stack.apply((s) => rippleDelete(s, { ids: ['zzz'] })) // error no-op
    stack.endGroup()
    expect(stack.canUndo).toBe(false)
  })

  it('endGroup without a matching beginGroup is ignored', () => {
    const stack = new UndoStack(seq([clip('a', 10)]))
    stack.endGroup()
    stack.apply((s) => append(s, { clip: newClip('b', 5) }))
    expect(stack.canUndo).toBe(true)
  })

  it('undo inside an open group is refused', () => {
    const stack = new UndoStack(seq([clip('a', 10)]))
    stack.beginGroup()
    stack.apply((s) => append(s, { clip: newClip('b', 5) }))
    const during = stack.current
    expect(stack.undo()).toBe(during)
    stack.endGroup()
  })

  it('nested groups commit a single entry when the outer group ends', () => {
    const initial = seq([clip('a', 10), clip('b', 10)])
    const stack = new UndoStack(initial)
    stack.beginGroup()
    stack.apply((s) => rippleDelete(s, { ids: ['a'] }))
    stack.beginGroup()
    stack.apply((s) => append(s, { clip: newClip('c', 5) }))
    stack.endGroup()
    expect(stack.canUndo).toBe(false) // still inside the outer group
    stack.endGroup()
    stack.undo()
    expect(stack.current).toEqual(initial)
    expect(stack.canUndo).toBe(false)
  })
})
