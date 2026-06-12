import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Sequence } from '../../shared/timeline/model'
import type { AudioEnvelope } from '../../shared/types'
import { clipWindows } from '../transcript/projection'

/**
 * Pure silence detection over the cached per-asset RMS envelopes, projected
 * into SEQUENCE time through the same clip-window math as the transcript.
 * Heuristic (documented, like markFillers): a 50 ms envelope window is silent
 * when its RMS is strictly below the threshold; runs of silent windows lasting
 * at least minDuration become candidate ranges, inset by `pad` on both ends so
 * speech onsets are never clipped. Padding only shrinks a range — a run whose
 * padded extent collapses to nothing is dropped.
 */

export interface TimeRange {
  fromFlicks: number
  toFlicks: number
}

export interface SilenceOptions {
  /** Windows strictly below this RMS level (dBFS) count as silent. */
  thresholdDb?: number
  /** Minimum un-padded run length to qualify as dead air. */
  minDurationFlicks?: number
  /** Inset applied to both ends of every detected run. */
  padFlicks?: number
}

export const DEFAULT_THRESHOLD_DB = -34
export const DEFAULT_MIN_DURATION_FLICKS = FLICKS_PER_SECOND / 2 // 0.5 s
export const DEFAULT_PAD_FLICKS = FLICKS_PER_SECOND / 10 // 100 ms

/**
 * Detect dead-air ranges across the sequence. Walks each clip's
 * [mediaIn, mediaIn+duration) slice of its asset envelope; clips without an
 * envelope (titles, gaps, silent imports) and audio-disabled spine clips are
 * skipped. Returns merged, ascending sequence-time ranges.
 */
export function detectSilence(
  sequence: Sequence,
  envelopes: ReadonlyMap<string, AudioEnvelope>,
  options: SilenceOptions = {}
): TimeRange[] {
  const thresholdDb = options.thresholdDb ?? DEFAULT_THRESHOLD_DB
  const minDurationFlicks = options.minDurationFlicks ?? DEFAULT_MIN_DURATION_FLICKS
  const padFlicks = options.padFlicks ?? DEFAULT_PAD_FLICKS

  // Detached-audio spine clips contribute no audio; their lane −1 clip does.
  const mutedSpineIds = new Set(
    sequence.spine
      .filter((item) => item.kind === 'clip' && item.audioDisabled === true)
      .map((item) => item.id)
  )

  const ranges: TimeRange[] = []
  for (const window of clipWindows(sequence)) {
    if (mutedSpineIds.has(window.clipId)) continue
    const envelope = envelopes.get(window.assetId)
    if (envelope === undefined || envelope.rmsDb.length === 0) continue

    // 50 ms at 705,600,000 flicks/s = 35,280,000 flicks — exact for integer ms.
    const windowFlicks = envelope.windowMs * (FLICKS_PER_SECOND / 1000)
    const mediaStart = window.mediaInFlicks
    const mediaEnd = window.mediaInFlicks + window.durationFlicks
    // First/last envelope windows overlapping the clip's media slice.
    const firstIndex = Math.max(0, Math.floor(mediaStart / windowFlicks))
    const lastIndex = Math.min(envelope.rmsDb.length - 1, Math.ceil(mediaEnd / windowFlicks) - 1)

    let runStart = -1
    const flushRun = (runEndExclusive: number): void => {
      if (runStart === -1) return
      // run extent in media time, clipped to the clip's media boundaries
      const start = Math.max(mediaStart, runStart * windowFlicks)
      const end = Math.min(mediaEnd, runEndExclusive * windowFlicks)
      runStart = -1
      if (end - start < minDurationFlicks) return
      const from = start + padFlicks
      const to = end - padFlicks
      if (to <= from) return
      ranges.push({
        fromFlicks: window.seqStartFlicks + (from - mediaStart),
        toFlicks: window.seqStartFlicks + (to - mediaStart)
      })
    }
    for (let i = firstIndex; i <= lastIndex; i += 1) {
      if (envelope.rmsDb[i] < thresholdDb) {
        if (runStart === -1) runStart = i
      } else {
        flushRun(i)
      }
    }
    flushRun(lastIndex + 1)
  }

  ranges.sort((a, b) => a.fromFlicks - b.fromFlicks)
  return mergeRanges(ranges)
}

/** Merge overlapping/touching ranges (clips cut from one silent region rejoin). */
function mergeRanges(sorted: TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.fromFlicks <= last.toFlicks) {
      last.toFlicks = Math.max(last.toFlicks, range.toFlicks)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}
