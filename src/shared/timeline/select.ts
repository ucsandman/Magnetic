import type { Sequence } from './model'

/**
 * Pure selection model: an ordered, duplicate-free list of selected clip ids
 * (spine or connected) plus an optional time range. All updates return new
 * objects; unchanged inputs come back by reference.
 */

export interface TimeRange {
  startFlicks: number
  endFlicks: number
}

export interface Selection {
  clipIds: string[]
  range: TimeRange | null
}

export function emptySelection(): Selection {
  return { clipIds: [], range: null }
}

export function selectOnly(sel: Selection, id: string): Selection {
  return { ...sel, clipIds: [id] }
}

export function addToSelection(sel: Selection, id: string): Selection {
  if (sel.clipIds.includes(id)) return sel
  return { ...sel, clipIds: [...sel.clipIds, id] }
}

export function removeFromSelection(sel: Selection, id: string): Selection {
  if (!sel.clipIds.includes(id)) return sel
  return { ...sel, clipIds: sel.clipIds.filter((existing) => existing !== id) }
}

export function toggleInSelection(sel: Selection, id: string): Selection {
  return sel.clipIds.includes(id) ? removeFromSelection(sel, id) : addToSelection(sel, id)
}

export function isSelected(sel: Selection, id: string): boolean {
  return sel.clipIds.includes(id)
}

export function setRange(sel: Selection, aFlicks: number, bFlicks: number): Selection {
  return {
    ...sel,
    range: { startFlicks: Math.min(aFlicks, bFlicks), endFlicks: Math.max(aFlicks, bFlicks) }
  }
}

export function clearRange(sel: Selection): Selection {
  if (sel.range === null) return sel
  return { ...sel, range: null }
}

/** Drop selected ids that no longer exist in the sequence (after deletes). */
export function pruneSelection(sel: Selection, seq: Sequence): Selection {
  const live = new Set<string>()
  for (const item of seq.spine) live.add(item.id)
  for (const cc of seq.connected) live.add(cc.id)
  const kept = sel.clipIds.filter((id) => live.has(id))
  if (kept.length === sel.clipIds.length) return sel
  return { ...sel, clipIds: kept }
}
