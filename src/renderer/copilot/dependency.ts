import type { Sequence } from '../../shared/timeline/model'
import { executeEditTool } from './tools'

/**
 * Partial-accept dependency analysis. NOT general dependency resolution — two
 * deliberately conservative rules (disclosed in the UI):
 *
 *  (a) an op referencing a clip id INTRODUCED by an earlier op (blade tails,
 *      boundary splits) is bound to that op;
 *  (b) a POSITION-addressed op (absolute times or spine/edit-point indices)
 *      is bound to every earlier LAYOUT-changing op, because excluding one
 *      would silently shift what the position means.
 *
 * Id-addressed, relative ops (trim by delta, slip, delete-by-id of a
 * pre-existing clip) stay independently checkable. Groups are connected
 * components, each listed in original op order.
 */

export interface OpCall {
  name: string
  input: unknown
}

/** Ops that change spine layout/timing when they succeed. */
const LAYOUT_CHANGING = new Set([
  'ripple_delete_range',
  'ripple_delete_clips',
  'blade',
  'trim_clip',
  'move_clip',
  'roll_edit'
])

/** Ops addressed by absolute time or index rather than a stable id. */
const POSITION_ADDRESSED = new Set([
  'ripple_delete_range',
  'blade',
  'roll_edit',
  'move_clip',
  'add_transition'
])

function referencedIds(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  const ids: string[] = []
  if (typeof record.clip_id === 'string') ids.push(record.clip_id)
  if (Array.isArray(record.clip_ids)) {
    for (const id of record.clip_ids) if (typeof id === 'string') ids.push(id)
  }
  if (typeof record.transition_id === 'string') ids.push(record.transition_id)
  return ids
}

export function dependencyGroups(base: Sequence, ops: readonly OpCall[]): number[][] {
  const parent = ops.map((_, index) => index)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (i: number, j: number): void => {
    parent[find(i)] = find(j)
  }

  const baseIds = new Set(base.spine.map((item) => item.id))
  const introducedBy = new Map<string, number>()
  let scratch = base
  const layoutChangers: number[] = []

  ops.forEach((op, index) => {
    // (a) references to ids some earlier op introduced
    for (const id of referencedIds(op.input)) {
      const introducer = introducedBy.get(id)
      if (introducer !== undefined) union(index, introducer)
    }
    // (b) position-addressed ops bind to every earlier layout change
    if (POSITION_ADDRESSED.has(op.name)) {
      for (const earlier of layoutChangers) union(index, earlier)
    }

    const outcome = executeEditTool(scratch, op.name, op.input)
    const changed = outcome.next !== scratch
    scratch = outcome.next
    if (changed) {
      for (const item of scratch.spine) {
        if (!baseIds.has(item.id) && !introducedBy.has(item.id)) {
          introducedBy.set(item.id, index)
        }
      }
      if (LAYOUT_CHANGING.has(op.name)) layoutChangers.push(index)
    }
  })

  const byRoot = new Map<number, number[]>()
  ops.forEach((_, index) => {
    const root = find(index)
    const group = byRoot.get(root) ?? []
    group.push(index)
    byRoot.set(root, group)
  })
  return [...byRoot.values()].sort((a, b) => a[0] - b[0])
}
