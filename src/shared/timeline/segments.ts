import { secondsToFlicks, flicksToSeconds } from '../timecode'
import { sequenceDuration, visibleMarkers, type Sequence } from './model'

/**
 * Marketing handoff export unit: one on-screen "clip:" marker turned into a
 * playable range. Sequence (not media) seconds — the same clock the exported
 * video timeline uses.
 */
export interface Segment {
  id: string
  title: string
  startSec: number
  endSec: number
}

const CLIP_MARKER = /^clip:\s*(.+)$/i
const END_MARKER = /^end$/i
const MAX_SEGMENT_SECONDS = 90

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Segments from the `clip: <title>` marker convention (verbatim law): a
 * `clip:` marker starts a segment; it ends at the first of the next `end`
 * marker, the next `clip:` marker, start+90s, or the sequence end. Reuses
 * the kernel's visible-marker projection, so invisible markers (their
 * asset no longer shown by any clip) are excluded for free.
 */
export function deriveSegments(sequence: Sequence): Segment[] {
  const boundaries = visibleMarkers(sequence)
    .map(({ marker, seqFlicks }) => {
      const clipMatch = CLIP_MARKER.exec(marker.text)
      if (clipMatch !== null)
        return { seqFlicks, kind: 'clip' as const, title: clipMatch[1].trim() }
      if (END_MARKER.test(marker.text)) return { seqFlicks, kind: 'end' as const }
      return null
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    // visibleMarkers is already sorted by seqFlicks; keep that order explicit.
    .sort((a, b) => a.seqFlicks - b.seqFlicks)

  const sequenceEndFlicks = sequenceDuration(sequence)
  const capFlicks = secondsToFlicks(MAX_SEGMENT_SECONDS)

  const segments: Omit<Segment, 'id'>[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i]
    if (boundary.kind !== 'clip') continue
    const next = boundaries[i + 1]
    const endFlicks = Math.min(
      next !== undefined ? next.seqFlicks : Number.POSITIVE_INFINITY,
      boundary.seqFlicks + capFlicks,
      sequenceEndFlicks
    )
    segments.push({
      title: boundary.title,
      startSec: flicksToSeconds(boundary.seqFlicks),
      endSec: flicksToSeconds(endFlicks)
    })
  }

  const slugCounts = new Map<string, number>()
  return segments.map((segment) => {
    const base = slugify(segment.title)
    const count = (slugCounts.get(base) ?? 0) + 1
    slugCounts.set(base, count)
    const id = count === 1 ? base : `${base}-${count}`
    return { id, ...segment }
  })
}
