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
