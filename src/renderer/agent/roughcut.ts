import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Sequence } from '../../shared/timeline/model'
import { rippleDeleteRange, type OpError } from '../../shared/timeline/ops'
import { validateSequence } from '../../shared/timeline/validate'
import type { AudioEnvelope, Transcript } from '../../shared/types'
import { DEFAULT_PAD_FLICKS, detectSilence, type SilenceOptions } from '../silence/detect'
import { fillerRanges, projectTranscript } from '../transcript/projection'

/**
 * Pure rough-cut planner: one pass that merges the existing silence detection
 * (RMS envelopes) and filler detection (transcript projection) into a single
 * ascending, reason-tagged cut plan. Composition only — both detectors already
 * ship and stay the single source of their heuristics.
 */

export type CutReason = 'silence' | 'filler'

export interface RoughCutRange {
  fromFlicks: number
  toFlicks: number
  reason: CutReason
}

export interface RoughCutOptions {
  silence?: SilenceOptions
  /** Include transcript filler words (um/uh/…) in the plan. Default true. */
  includeFillers?: boolean
}

/** An applied cut's position in the RESULT sequence (badges, review rows). */
export interface RoughCutPoint {
  flicks: number
  reason: CutReason
  removedFlicks: number
}

export function planRoughCut(
  sequence: Sequence,
  transcripts: Map<string, Transcript>,
  envelopes: ReadonlyMap<string, AudioEnvelope>,
  options: RoughCutOptions = {}
): RoughCutRange[] {
  const ranges: RoughCutRange[] = detectSilence(sequence, envelopes, options.silence).map(
    (range) => ({ ...range, reason: 'silence' as const })
  )
  if (options.includeFillers !== false) {
    for (const range of fillerRanges(projectTranscript(sequence, transcripts))) {
      ranges.push({ ...range, reason: 'filler' })
    }
  }
  ranges.sort((a, b) => a.fromFlicks - b.fromFlicks || a.toFlicks - b.toFlicks)
  // Merge overlaps so the executor never double-deletes; a mixed-reason merge
  // reports 'silence' (the dead air is what makes the range worth cutting).
  const merged: RoughCutRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.fromFlicks < last.toFlicks) {
      last.toFlicks = Math.max(last.toFlicks, range.toFlicks)
      if (range.reason === 'silence') last.reason = 'silence'
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Where each applied cut lands in the result sequence: range starts shifted
 * left by everything removed before them. Requires ascending non-overlapping
 * ranges (what planRoughCut returns).
 */
export function cutPointsFor(ranges: readonly RoughCutRange[]): RoughCutPoint[] {
  let removed = 0
  const points: RoughCutPoint[] = []
  for (const range of ranges) {
    points.push({
      flicks: range.fromFlicks - removed,
      reason: range.reason,
      removedFlicks: range.toFlicks - range.fromFlicks
    })
    removed += range.toFlicks - range.fromFlicks
  }
  return points
}

export interface RoughCutProposal {
  proposed: Sequence
  errors: OpError[]
}

/**
 * Ghost-diff-before-commit: run the plan against a SCRATCH sequence — pure
 * kernel ops, no store, no undo stack — and gate the result through
 * validateSequence. Op errors and invariant violations are collected so the
 * panel can refuse to offer an unusable proposal; ranges that no-op (already
 * clamped away) are skipped, matching how the executor treats them.
 */
export function buildRoughCutProposal(
  base: Sequence,
  ranges: readonly RoughCutRange[]
): RoughCutProposal {
  const errors: OpError[] = []
  let proposed = base
  for (const range of [...ranges].sort((a, b) => b.fromFlicks - a.fromFlicks)) {
    const result = rippleDeleteRange(proposed, range)
    if (result.error !== undefined) {
      errors.push(result.error)
      continue
    }
    proposed = result.next
  }
  errors.push(...validateSequence(proposed))
  return { proposed, errors }
}

/**
 * One slider instead of three: aggressiveness 0..1 maps to silence options.
 * 0 = cautious (-44 dB, 1.2 s runs), 1 = fierce (-28 dB, 0.3 s runs); the
 * 100 ms speech-onset pad never changes.
 */
export function silenceOptionsFor(aggressiveness: number): Required<SilenceOptions> {
  const a = Math.min(1, Math.max(0, aggressiveness))
  return {
    thresholdDb: -44 + 16 * a,
    minDurationFlicks: Math.round(((120 - 90 * a) / 100) * FLICKS_PER_SECOND),
    padFlicks: DEFAULT_PAD_FLICKS
  }
}
