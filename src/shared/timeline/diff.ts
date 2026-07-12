import type { Sequence } from './model'

/**
 * Ghost-diff support: which parts of the BASE sequence's content do not
 * survive into a PROPOSED sequence, as base-time ranges (the hatch overlay).
 *
 * Matching is by root id + surviving media: blade derives its tail id as
 * `${id}:${time}` (splitInWorking), so everything cut from one original clip
 * shares its root. A base clip's hatch is whatever slice of its media window
 * no proposed clip with the same root still shows — which makes pure moves,
 * blades, and re-arrangements report nothing, while deletes and trims report
 * exactly the vanished ranges. Gaps carry no media; they compare by total
 * surviving duration.
 */

export interface TimeRange {
  fromFlicks: number
  toFlicks: number
}

const rootOf = (id: string): string => id.split(':')[0]

/**
 * Map a BASE-sequence time into the PROPOSED sequence across the deletions:
 * earlier removals shift it left; a time inside a removal clamps to the cut.
 * Keeps the A/B review's two stills on the same moment of content.
 */
export function proposedTimeAt(deletions: readonly TimeRange[], baseFlicks: number): number {
  let removed = 0
  for (const deletion of deletions) {
    removed += Math.min(
      Math.max(0, baseFlicks - deletion.fromFlicks),
      deletion.toFlicks - deletion.fromFlicks
    )
  }
  return baseFlicks - removed
}

/**
 * Proposed spine clips whose CONTENT differs from the base — trimmed media
 * windows, changed durations, or blade-derived ids. Pure moves report
 * nothing. Feeds the per-clip attribution tags after an accepted pass.
 */
export function touchedClipIds(base: Sequence, proposed: Sequence): Set<string> {
  if (base === proposed) return new Set()
  const baseById = new Map(
    base.spine.filter((item) => item.kind === 'clip').map((item) => [item.id, item])
  )
  const touched = new Set<string>()
  for (const item of proposed.spine) {
    if (item.kind !== 'clip') continue
    const before = baseById.get(item.id)
    if (before === undefined) {
      touched.add(item.id)
      continue
    }
    if (
      before.kind === 'clip' &&
      (before.mediaInFlicks !== item.mediaInFlicks || before.durationFlicks !== item.durationFlicks)
    ) {
      touched.add(item.id)
    }
  }
  return touched
}

export function diffDeletions(base: Sequence, proposed: Sequence): TimeRange[] {
  if (base === proposed) return []

  const survivors = new Map<string, { from: number; to: number }[]>()
  for (const item of proposed.spine) {
    const root = rootOf(item.id)
    const list = survivors.get(root) ?? []
    const from = item.kind === 'clip' ? item.mediaInFlicks : 0
    list.push({ from, to: from + item.durationFlicks })
    survivors.set(root, list)
  }

  const ranges: TimeRange[] = []
  let position = 0
  for (const item of base.spine) {
    const start = position
    position += item.durationFlicks
    const list = survivors.get(rootOf(item.id)) ?? []

    if (item.kind === 'gap') {
      const survived = Math.min(
        item.durationFlicks,
        list.reduce((sum, range) => sum + (range.to - range.from), 0)
      )
      if (survived < item.durationFlicks) {
        ranges.push({ fromFlicks: start + survived, toFlicks: position })
      }
      continue
    }

    const mediaFrom = item.mediaInFlicks
    const mediaTo = mediaFrom + item.durationFlicks
    const clipped = list
      .map((range) => ({
        from: Math.max(range.from, mediaFrom),
        to: Math.min(range.to, mediaTo)
      }))
      .filter((range) => range.to > range.from)
      .sort((a, b) => a.from - b.from)
    let cursor = mediaFrom
    for (const range of clipped) {
      if (range.from > cursor) {
        ranges.push({
          fromFlicks: start + (cursor - mediaFrom),
          toFlicks: start + (range.from - mediaFrom)
        })
      }
      cursor = Math.max(cursor, range.to)
    }
    if (cursor < mediaTo) {
      ranges.push({ fromFlicks: start + (cursor - mediaFrom), toFlicks: position })
    }
  }

  const merged: TimeRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.fromFlicks <= last.toFlicks) {
      last.toFlicks = Math.max(last.toFlicks, range.toFlicks)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}
