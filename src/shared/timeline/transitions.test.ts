import { describe, expect, it } from 'vitest'
import {
  addTransition,
  removeTransition,
  resizeTransition,
  rippleDelete,
  setTransitionKind
} from './ops'
import { transitionAt, transitionsOf } from './transitions'
import { F, clip, seq } from './testing'

/** Two clips with 2s of handles on each side of the cut at 8s. */
function handleSeq(): ReturnType<typeof seq> {
  return seq([
    clip('a', 8), // mediaIn 0, source 600 → tail handle huge
    { ...clip('b', 6, 2) } // mediaIn 2 → head handle 2s
  ])
}

describe('addTransition', () => {
  it('adds a centered transition at an edit point', () => {
    const s = handleSeq()
    const { next, error } = addTransition(s, {
      editPointIndex: 0,
      durationFlicks: 2 * F,
      kind: 'dissolve'
    })
    expect(error).toBeUndefined()
    const transitions = transitionsOf(next)
    expect(transitions).toHaveLength(1)
    expect(transitions[0].afterClipId).toBe('a')
    expect(transitions[0].durationFlicks).toBe(2 * F)
    expect(transitions[0].kind).toBe('dissolve')
  })

  it('clamps duration to twice the smaller media handle', () => {
    const s = handleSeq() // b head handle = 2s (60 frames at builder fps... 2 frames *F: F = frame)
    const { next } = addTransition(s, {
      editPointIndex: 0,
      durationFlicks: 100 * F,
      kind: 'dissolve'
    })
    // b's head handle is 2 frames-worth ×F = 2F → max duration 4F
    expect(transitionsOf(next)[0].durationFlicks).toBe(4 * F)
  })

  it('rejects edit points where a side has zero handles', () => {
    const s = seq([clip('a', 10), clip('b', 10)]) // b mediaIn 0 → no head handle
    const result = addTransition(s, { editPointIndex: 0, durationFlicks: F, kind: 'dissolve' })
    expect(result.error?.code).toBe('invalid-target')
    expect(result.next).toBe(s)
  })

  it('rejects invalid edit point indexes and gaps', () => {
    const s = handleSeq()
    expect(
      addTransition(s, { editPointIndex: 5, durationFlicks: F, kind: 'dissolve' }).error
    ).toBeDefined()
  })

  it('replaces an existing transition at the same edit point', () => {
    const s = handleSeq()
    const first = addTransition(s, { editPointIndex: 0, durationFlicks: 2 * F, kind: 'dissolve' })
    const second = addTransition(first.next, {
      editPointIndex: 0,
      durationFlicks: F,
      kind: 'wipeL'
    })
    expect(transitionsOf(second.next)).toHaveLength(1)
    expect(transitionsOf(second.next)[0].kind).toBe('wipeL')
  })
})

describe('remove/resize/kind + undo', () => {
  it('removeTransition deletes it; the inverse restores it', () => {
    const s = handleSeq()
    const added = addTransition(s, { editPointIndex: 0, durationFlicks: 2 * F, kind: 'dissolve' })
    const removed = removeTransition(added.next, { transitionId: transitionsOf(added.next)[0].id })
    expect(transitionsOf(removed.next)).toHaveLength(0)
    expect(removed.inverse).toEqual({ type: 'restore', sequence: added.next })
  })

  it('resizeTransition clamps like add', () => {
    const s = handleSeq()
    const added = addTransition(s, { editPointIndex: 0, durationFlicks: 2 * F, kind: 'dissolve' })
    const id = transitionsOf(added.next)[0].id
    const resized = resizeTransition(added.next, { transitionId: id, durationFlicks: 100 * F })
    expect(transitionsOf(resized.next)[0].durationFlicks).toBe(4 * F)
    expect(
      resizeTransition(added.next, { transitionId: 'zzz', durationFlicks: F }).error
    ).toBeDefined()
  })

  it('setTransitionKind switches the blend', () => {
    const s = handleSeq()
    const added = addTransition(s, { editPointIndex: 0, durationFlicks: 2 * F, kind: 'dissolve' })
    const id = transitionsOf(added.next)[0].id
    const changed = setTransitionKind(added.next, { transitionId: id, kind: 'fadeBlack' })
    expect(transitionsOf(changed.next)[0].kind).toBe('fadeBlack')
  })

  it('deleting either side of the cut drops the transition', () => {
    const s = handleSeq()
    const added = addTransition(s, { editPointIndex: 0, durationFlicks: 2 * F, kind: 'dissolve' })
    const deleted = rippleDelete(added.next, { ids: ['b'] })
    expect(transitionsOf(deleted.next)).toHaveLength(0)
  })
})

describe('transitionAt', () => {
  it('reports kind/progress/clips inside the centered window and null outside', () => {
    const s = handleSeq() // cut at 8 frames-worth (8F)
    const { next } = addTransition(s, { editPointIndex: 0, durationFlicks: 4 * F, kind: 'wipeR' })
    expect(transitionAt(next, 5 * F)).toBeNull()
    const mid = transitionAt(next, 8 * F)!
    expect(mid.kind).toBe('wipeR')
    expect(mid.aClipId).toBe('a')
    expect(mid.bClipId).toBe('b')
    expect(mid.progress).toBeCloseTo(0.5)
    const early = transitionAt(next, 6 * F)!
    expect(early.progress).toBeCloseTo(0)
    expect(transitionAt(next, 10 * F)).toBeNull() // window end is exclusive
  })
})
