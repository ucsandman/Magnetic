import type { ConnectedClip, Sequence, SpineItem } from './model'
import { connectedStartOf } from './model'

/**
 * Magnetic semantics helpers: connected clips follow their spine parents.
 * When a parent vanishes, clips re-attach to whatever now occupies their old
 * absolute time; same-lane overlaps resolve by bumping the later-added clip
 * outward. All pure, deterministic, and free of DOM/Electron.
 */

/** Derived start position of every spine item, by id. */
export function spineStartIndex(spine: readonly SpineItem[]): Map<string, number> {
  const index = new Map<string, number>()
  let position = 0
  for (const item of spine) {
    index.set(item.id, position)
    position += item.durationFlicks
  }
  return index
}

/** Spine item whose half-open range [start, start+duration) contains the time. */
export function itemAtTime(
  spine: readonly SpineItem[],
  timeFlicks: number
): { item: SpineItem; startFlicks: number } | null {
  if (timeFlicks < 0) return null
  let position = 0
  for (const item of spine) {
    if (timeFlicks < position + item.durationFlicks) return { item, startFlicks: position }
    position += item.durationFlicks
  }
  return null
}

/**
 * Re-parent connected clips whose parent no longer exists in the new spine to
 * the item now under their old absolute time (FCP behavior); drop them when
 * that time is beyond the new sequence end.
 */
export function reattachByTime(
  oldSeq: Sequence,
  spine: SpineItem[],
  connected: readonly ConnectedClip[]
): ConnectedClip[] {
  const startOf = spineStartIndex(spine)
  const result: ConnectedClip[] = []
  for (const cc of connected) {
    if (startOf.has(cc.parentClipId)) {
      result.push(cc)
      continue
    }
    const oldAbsolute = connectedStartOf(oldSeq, cc.id)
    if (oldAbsolute === null) continue
    const target = itemAtTime(spine, oldAbsolute)
    if (target === null) continue
    result.push({
      ...cc,
      parentClipId: target.item.id,
      offsetFlicks: oldAbsolute - target.startFlicks
    })
  }
  return result
}

/**
 * Deterministic lane collision resolution: clips earlier in the array keep
 * their lane; a later clip overlapping one of them in absolute time bumps
 * outward (+1 per step above the spine, -1 below) until it finds a free lane.
 * Returns the input array unchanged (same reference) when nothing collides.
 */
export function resolveLaneCollisions(
  spine: readonly SpineItem[],
  connected: ConnectedClip[]
): ConnectedClip[] {
  const startOf = spineStartIndex(spine)
  const placed: { lane: number; start: number; end: number }[] = []
  let changed = false
  const result = connected.map((cc) => {
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) return cc
    const start = parentStart + cc.offsetFlicks
    const end = start + cc.durationFlicks
    const direction = cc.lane >= 0 ? 1 : -1
    let lane = cc.lane
    while (placed.some((p) => p.lane === lane && p.start < end && start < p.end)) {
      lane += direction
    }
    placed.push({ lane, start, end })
    if (lane === cc.lane) return cc
    changed = true
    return { ...cc, lane }
  })
  return changed ? result : connected
}
