import { spineStartIndex } from '../../shared/timeline/magnetic'
import type { Sequence } from '../../shared/timeline/model'
import type { Transcript } from '../../shared/types'

/**
 * Project per-asset transcripts into SEQUENCE time: for every spine/connected
 * clip with a transcript, words fully inside the clip's media window map
 * through (mediaIn, duration, derived position). The transcript panel is a
 * pure projection of the sequence — never a second source of truth.
 */

export interface SequenceWord {
  text: string
  seqStartFlicks: number
  seqEndFlicks: number
  p: number
  clipId: string
  /** True for the first word of each clip (boundary marker in the panel). */
  clipBoundary: boolean
  isFiller: boolean
}

export interface ClipWindow {
  clipId: string
  assetId: string
  seqStartFlicks: number
  mediaInFlicks: number
  durationFlicks: number
}

/**
 * Every audio-bearing clip (spine + non-title connected) with its derived
 * sequence start. Spine clips whose audio was detached are skipped — their
 * audio (and therefore their transcript words) lives in the lane −1 child,
 * which covers the identical media window; including both would double every
 * projected word (captions, SRT export, filler ranges).
 */
export function clipWindows(sequence: Sequence): ClipWindow[] {
  const windows: ClipWindow[] = []
  let position = 0
  for (const item of sequence.spine) {
    if (item.kind === 'clip' && item.audioDisabled !== true) {
      windows.push({
        clipId: item.id,
        assetId: item.assetId,
        seqStartFlicks: position,
        mediaInFlicks: item.mediaInFlicks,
        durationFlicks: item.durationFlicks
      })
    }
    position += item.durationFlicks
  }
  const startOf = spineStartIndex(sequence.spine)
  for (const cc of sequence.connected) {
    if (cc.titleData !== undefined) continue
    // looped clips are music beds, not speech — their wrapped media math would
    // corrupt the linear mediaIn→sequence mapping every projection relies on
    if (cc.loop === true) continue
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) continue
    windows.push({
      clipId: cc.id,
      assetId: cc.assetId,
      seqStartFlicks: parentStart + cc.offsetFlicks,
      mediaInFlicks: cc.mediaInFlicks,
      durationFlicks: cc.durationFlicks
    })
  }
  return windows.sort((a, b) => a.seqStartFlicks - b.seqStartFlicks)
}

export function projectTranscript(
  sequence: Sequence,
  transcripts: Map<string, Transcript>
): SequenceWord[] {
  const words: SequenceWord[] = []
  for (const window of clipWindows(sequence)) {
    const transcript = transcripts.get(window.assetId)
    if (transcript === undefined) continue
    let first = true
    for (const word of transcript.words) {
      // drop words not fully inside the clip's media range (mid-word cuts)
      if (
        word.startFlicks < window.mediaInFlicks ||
        word.endFlicks > window.mediaInFlicks + window.durationFlicks
      ) {
        continue
      }
      words.push({
        text: word.text,
        seqStartFlicks: window.seqStartFlicks + (word.startFlicks - window.mediaInFlicks),
        seqEndFlicks: window.seqStartFlicks + (word.endFlicks - window.mediaInFlicks),
        p: word.p,
        clipId: window.clipId,
        clipBoundary: first,
        isFiller: false
      })
      first = false
    }
  }
  words.sort((a, b) => a.seqStartFlicks - b.seqStartFlicks)
  return markFillers(words)
}

const SINGLE_FILLERS = new Set(['um', 'uh', 'er', 'ah'])
const PHRASE_FILLERS = [
  ['you', 'know'],
  ['sort', 'of'],
  ['kind', 'of']
]
/** ≥200 ms pause on either side promotes an ambiguous "like" to a filler. */
const PAUSE_FLICKS = 0.2 * 705_600_000

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z']/g, '')
}

/**
 * Heuristic filler detection (documented): standalone um/uh/er/ah always;
 * two-word phrases you know / sort of / kind of; "like" only when the model
 * is unsure (p < 0.5) or it is isolated by ≥200 ms pauses on both sides.
 */
export function markFillers(words: SequenceWord[]): SequenceWord[] {
  const result = words.map((word) => ({ ...word }))
  for (let i = 0; i < result.length; i++) {
    const text = normalize(result[i].text)
    if (SINGLE_FILLERS.has(text)) {
      result[i].isFiller = true
      continue
    }
    if (text === 'like') {
      const pauseBefore =
        i === 0 || result[i].seqStartFlicks - result[i - 1].seqEndFlicks >= PAUSE_FLICKS
      const pauseAfter =
        i === result.length - 1 ||
        result[i + 1].seqStartFlicks - result[i].seqEndFlicks >= PAUSE_FLICKS
      if (result[i].p < 0.5 || (pauseBefore && pauseAfter)) result[i].isFiller = true
      continue
    }
    for (const [a, b] of PHRASE_FILLERS) {
      if (text === a && i + 1 < result.length && normalize(result[i + 1].text) === b) {
        result[i].isFiller = true
        result[i + 1].isFiller = true
      }
    }
  }
  return result
}

export interface TimeRange {
  fromFlicks: number
  toFlicks: number
}

/** Merge the marked fillers into contiguous deletable ranges. */
export function fillerRanges(words: SequenceWord[]): TimeRange[] {
  const ranges: TimeRange[] = []
  for (const word of words) {
    if (!word.isFiller) continue
    const last = ranges[ranges.length - 1]
    if (last !== undefined && word.seqStartFlicks <= last.toFlicks + PAUSE_FLICKS / 4) {
      last.toFlicks = Math.max(last.toFlicks, word.seqEndFlicks)
    } else {
      ranges.push({ fromFlicks: word.seqStartFlicks, toFlicks: word.seqEndFlicks })
    }
  }
  return ranges
}
