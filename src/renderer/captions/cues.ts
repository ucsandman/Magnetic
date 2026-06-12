import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { SequenceWord } from '../transcript/projection'

/**
 * Caption cues: pure grouping of the transcript projection
 * (`projectTranscript`) into short on-screen lines. Cues are derived, never
 * stored — every blade/trim/ripple/edit-by-transcript edit re-derives them.
 */

export interface CueWord {
  text: string
  startFlicks: number
  endFlicks: number
}

export interface CaptionCue {
  startFlicks: number
  endFlicks: number
  /** Words joined by single spaces — the on-screen / sidecar text. */
  text: string
  words: CueWord[]
}

/** A pause longer than this starts a new cue. */
export const MAX_WORD_GAP_FLICKS = 0.6 * FLICKS_PER_SECOND
/** Approximate one-line character budget per cue. */
export const LINE_CHAR_BUDGET = 32

/**
 * Group projected words into cues. A new cue starts when (a) the gap to the
 * previous word exceeds 0.6 s, (b) appending the word would exceed the
 * ~32-char line budget, or (c) the word is the first of a different clip
 * (projectTranscript already segments per clip, so cues never span cuts).
 */
export function buildCues(words: SequenceWord[]): CaptionCue[] {
  const cues: CaptionCue[] = []
  let current: CueWord[] = []
  let chars = 0

  const flush = (): void => {
    if (current.length === 0) return
    cues.push({
      startFlicks: current[0].startFlicks,
      endFlicks: current[current.length - 1].endFlicks,
      text: current.map((word) => word.text).join(' '),
      words: current
    })
    current = []
    chars = 0
  }

  let previous: SequenceWord | null = null
  for (const word of words) {
    const gapBreak =
      previous !== null && word.seqStartFlicks - previous.seqEndFlicks > MAX_WORD_GAP_FLICKS
    const budgetBreak = current.length > 0 && chars + 1 + word.text.length > LINE_CHAR_BUDGET
    const clipBreak = current.length > 0 && word.clipBoundary
    if (gapBreak || budgetBreak || clipBreak) flush()
    current.push({
      text: word.text,
      startFlicks: word.seqStartFlicks,
      endFlicks: word.seqEndFlicks
    })
    chars += (current.length > 1 ? 1 : 0) + word.text.length
    previous = word
  }
  flush()
  return cues
}

export interface ActiveCue {
  cueIndex: number
  /** Index (into cue.words) of the word containing/last started at the time. */
  wordIndex: number
}

/**
 * The cue active at `timeFlicks` (half-open [start, end)), or null in
 * silence. Binary search over the sorted cue starts; the active word is the
 * last word whose start is at or before the time.
 */
export function activeCueAt(cues: CaptionCue[], timeFlicks: number): ActiveCue | null {
  let lo = 0
  let hi = cues.length - 1
  let candidate = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].startFlicks <= timeFlicks) {
      candidate = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (candidate === -1) return null
  const cue = cues[candidate]
  if (timeFlicks >= cue.endFlicks) return null
  let wordIndex = 0
  for (let i = 0; i < cue.words.length; i++) {
    if (cue.words[i].startFlicks <= timeFlicks) wordIndex = i
    else break
  }
  return { cueIndex: candidate, wordIndex }
}
