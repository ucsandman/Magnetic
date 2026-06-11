import type { Clip, Sequence, Transition, TransitionKind } from './model'
import { spineStartIndex } from './magnetic'

/**
 * Transition helpers: edit-point handle math, validity pruning, and the
 * render-time window query. Pure and DOM-free like the rest of the kernel.
 */

export function transitionsOf(seq: Sequence): Transition[] {
  return seq.transitions ?? []
}

export interface EditPointInfo {
  left: Clip
  right: Clip
  /** Sequence time of the cut. */
  cutFlicks: number
  /** Largest centered transition the media handles allow. */
  maxDurationFlicks: number
}

/** Both sides of the edit point must be clips with media handles to overlap. */
export function editPointInfo(seq: Sequence, editPointIndex: number): EditPointInfo | null {
  if (editPointIndex < 0 || editPointIndex >= seq.spine.length - 1) return null
  const left = seq.spine[editPointIndex]
  const right = seq.spine[editPointIndex + 1]
  if (left.kind !== 'clip' || right.kind !== 'clip') return null
  let cut = 0
  for (let i = 0; i <= editPointIndex; i++) cut += seq.spine[i].durationFlicks
  const leftTailHandle = left.sourceDurationFlicks - left.mediaInFlicks - left.durationFlicks
  const rightHeadHandle = right.mediaInFlicks
  return {
    left,
    right,
    cutFlicks: cut,
    maxDurationFlicks: 2 * Math.min(leftTailHandle, rightHeadHandle)
  }
}

export function editPointIndexOfCut(seq: Sequence, afterClipId: string): number {
  const index = seq.spine.findIndex((item) => item.id === afterClipId)
  return index >= 0 && index < seq.spine.length - 1 ? index : -1
}

/**
 * Drop transitions whose cut no longer exists and clamp the rest to the
 * (possibly shrunken) media handles. Runs after every kernel op.
 */
export function pruneTransitions(seq: Sequence): Transition[] | undefined {
  const list = seq.transitions
  if (list === undefined) return undefined
  const pruned: Transition[] = []
  for (const transition of list) {
    const index = editPointIndexOfCut(seq, transition.afterClipId)
    if (index === -1) continue
    const info = editPointInfo(seq, index)
    if (info === null || info.maxDurationFlicks <= 0) continue
    pruned.push(
      transition.durationFlicks <= info.maxDurationFlicks
        ? transition
        : { ...transition, durationFlicks: info.maxDurationFlicks }
    )
  }
  return pruned
}

export interface ActiveTransition {
  transition: Transition
  kind: TransitionKind
  aClipId: string
  bClipId: string
  /** 0 at window start → 1 at window end. */
  progress: number
  windowStartFlicks: number
  windowEndFlicks: number
}

/** The transition whose centered window contains `timeFlicks`, if any. */
export function transitionAt(seq: Sequence, timeFlicks: number): ActiveTransition | null {
  const startOf = spineStartIndex(seq.spine)
  for (const transition of transitionsOf(seq)) {
    const index = editPointIndexOfCut(seq, transition.afterClipId)
    if (index === -1) continue
    const left = seq.spine[index]
    const right = seq.spine[index + 1]
    if (left.kind !== 'clip' || right.kind !== 'clip') continue
    const cut = (startOf.get(left.id) ?? 0) + left.durationFlicks
    const half = transition.durationFlicks / 2
    if (timeFlicks < cut - half || timeFlicks >= cut + half) continue
    return {
      transition,
      kind: transition.kind,
      aClipId: left.id,
      bClipId: right.id,
      progress: (timeFlicks - (cut - half)) / transition.durationFlicks,
      windowStartFlicks: cut - half,
      windowEndFlicks: cut + half
    }
  }
  return null
}
