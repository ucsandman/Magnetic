import type { Sequence } from './model'
import { spineStartIndex } from './magnetic'

/**
 * Snap-point provider for timeline drag/trim interactions. Pure math —
 * pixel-tolerance conversion is the caller's job.
 */

export interface SnapPoint {
  timeFlicks: number
  kind: 'clip-edge' | 'connected-edge' | 'playhead' | 'marker'
}

export function collectSnapPoints(seq: Sequence, playheadFlicks: number | null): SnapPoint[] {
  const byTime = new Map<number, SnapPoint>()
  const add = (timeFlicks: number, kind: SnapPoint['kind']): void => {
    if (!byTime.has(timeFlicks)) byTime.set(timeFlicks, { timeFlicks, kind })
  }
  let position = 0
  add(0, 'clip-edge')
  for (const item of seq.spine) {
    position += item.durationFlicks
    add(position, 'clip-edge')
  }
  const startOf = spineStartIndex(seq.spine)
  for (const cc of seq.connected) {
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) continue
    const start = parentStart + cc.offsetFlicks
    add(start, 'connected-edge')
    add(start + cc.durationFlicks, 'connected-edge')
  }
  if (playheadFlicks !== null) add(playheadFlicks, 'playhead')
  return Array.from(byTime.values()).sort((a, b) => a.timeFlicks - b.timeFlicks)
}

export interface SnapResult {
  timeFlicks: number
  snapped: SnapPoint | null
}

/** Snap to the nearest point within tolerance; ties resolve to the earlier point. */
export function snapTime(
  timeFlicks: number,
  points: SnapPoint[],
  toleranceFlicks: number
): SnapResult {
  let best: SnapPoint | null = null
  let bestDistance = Infinity
  for (const point of points) {
    const distance = Math.abs(point.timeFlicks - timeFlicks)
    if (distance <= toleranceFlicks && distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }
  return best === null
    ? { timeFlicks, snapped: null }
    : { timeFlicks: best.timeFlicks, snapped: best }
}
