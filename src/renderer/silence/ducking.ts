import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { effectiveRole, type Sequence } from '../../shared/timeline/model'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import type { AudioEnvelope } from '../../shared/types'
import { clipWindows } from '../transcript/projection'
import { DEFAULT_THRESHOLD_DB } from './detect'

/**
 * Auto-ducking planner: find where dialogue is actually speaking (RMS above
 * the silence threshold) and dip every music-role bed under it. Pure — the
 * caller fetches envelopes and applies the plans as fx.duck ranges.
 */

export const DUCK_AMOUNT_DB = -12
/** Speech gaps shorter than this merge into one dip so the bed doesn't pump. */
const MERGE_GAP_FLICKS = FLICKS_PER_SECOND
/** Speech blips shorter than this don't earn a dip. */
const MIN_SPEECH_FLICKS = FLICKS_PER_SECOND * 0.3

export interface DuckRange {
  fromClipFlicks: number
  toClipFlicks: number
}

export interface DuckPlan {
  clipId: string
  ranges: DuckRange[]
}

interface SeqRange {
  fromFlicks: number
  toFlicks: number
}

/** Sequence-time ranges where any dialogue-role clip is above the threshold. */
function speechRanges(
  sequence: Sequence,
  envelopes: ReadonlyMap<string, AudioEnvelope>
): SeqRange[] {
  const roleOf = new Map<string, ReturnType<typeof effectiveRole>>()
  for (const item of sequence.spine) roleOf.set(item.id, effectiveRole(item))
  for (const cc of sequence.connected) roleOf.set(cc.id, effectiveRole(cc))

  const ranges: SeqRange[] = []
  for (const window of clipWindows(sequence)) {
    if (roleOf.get(window.clipId) !== 'dialogue') continue
    const envelope = envelopes.get(window.assetId)
    if (envelope === undefined || envelope.rmsDb.length === 0) continue
    const windowFlicks = envelope.windowMs * (FLICKS_PER_SECOND / 1000)
    const mediaStart = window.mediaInFlicks
    const mediaEnd = window.mediaInFlicks + window.durationFlicks
    const firstIndex = Math.max(0, Math.floor(mediaStart / windowFlicks))
    const lastIndex = Math.min(envelope.rmsDb.length - 1, Math.ceil(mediaEnd / windowFlicks) - 1)
    let runStart = -1
    const flushRun = (runEndExclusive: number): void => {
      if (runStart === -1) return
      const start = Math.max(mediaStart, runStart * windowFlicks)
      const end = Math.min(mediaEnd, runEndExclusive * windowFlicks)
      runStart = -1
      if (end - start < MIN_SPEECH_FLICKS) return
      ranges.push({
        fromFlicks: window.seqStartFlicks + (start - mediaStart),
        toFlicks: window.seqStartFlicks + (end - mediaStart)
      })
    }
    for (let i = firstIndex; i <= lastIndex; i += 1) {
      if (envelope.rmsDb[i] >= DEFAULT_THRESHOLD_DB) {
        if (runStart === -1) runStart = i
      } else {
        flushRun(i)
      }
    }
    flushRun(lastIndex + 1)
  }

  ranges.sort((a, b) => a.fromFlicks - b.fromFlicks)
  const merged: SeqRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.fromFlicks <= last.toFlicks + MERGE_GAP_FLICKS) {
      last.toFlicks = Math.max(last.toFlicks, range.toFlicks)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** One duck plan per music-role connected clip that overlaps speech. */
export function planDucking(
  sequence: Sequence,
  envelopes: ReadonlyMap<string, AudioEnvelope>
): DuckPlan[] {
  const speech = speechRanges(sequence, envelopes)
  if (speech.length === 0) return []
  const startOf = spineStartIndex(sequence.spine)
  const plans: DuckPlan[] = []
  for (const cc of sequence.connected) {
    if (effectiveRole(cc) !== 'music') continue
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) continue
    const clipStart = parentStart + cc.offsetFlicks
    const clipEnd = clipStart + cc.durationFlicks
    const ranges: DuckRange[] = []
    for (const range of speech) {
      const from = Math.max(range.fromFlicks, clipStart)
      const to = Math.min(range.toFlicks, clipEnd)
      if (to <= from) continue
      ranges.push({ fromClipFlicks: from - clipStart, toClipFlicks: to - clipStart })
    }
    if (ranges.length > 0) plans.push({ clipId: cc.id, ranges })
  }
  return plans
}
