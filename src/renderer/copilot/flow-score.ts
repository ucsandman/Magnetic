import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Sequence } from '../../shared/timeline/model'
import { transitionsOf } from '../../shared/timeline/transitions'
import type { AudioEnvelope } from '../../shared/types'
import { detectSilence } from '../silence/detect'

/**
 * Flow self-check: heuristic "does this cut play well?" score the copilot
 * runs on its own output and the panels show after an accepted pass. All
 * three heuristics are documented and deterministic:
 *  - dead-air:   residual silence the cleanup missed (detectSilence defaults)
 *  - jump-cut:   adjacent same-asset clips with removed media between them
 *                and no transition covering the cut — the visible "jump"
 *  - short-clip: sub-0.5 s slivers that flash by
 */

export type FlowFlagKind = 'dead-air' | 'jump-cut' | 'short-clip'

export interface FlowFlag {
  flicks: number
  kind: FlowFlagKind
  message: string
}

export interface FlowReport {
  /** 0–100, 100 = nothing flagged. */
  score: number
  flags: FlowFlag[]
}

const PENALTY: Record<FlowFlagKind, number> = {
  'dead-air': 8,
  'jump-cut': 5,
  'short-clip': 4
}

const MIN_CLIP_FLICKS = FLICKS_PER_SECOND / 2

const fmtSec = (flicks: number): string => `${(flicks / FLICKS_PER_SECOND).toFixed(1)}s`

export function scoreFlow(
  sequence: Sequence,
  envelopes: ReadonlyMap<string, AudioEnvelope>
): FlowReport {
  const flags: FlowFlag[] = []

  for (const range of detectSilence(sequence, envelopes)) {
    flags.push({
      flicks: range.fromFlicks,
      kind: 'dead-air',
      message: `${fmtSec(range.toFlicks - range.fromFlicks)} of dead air`
    })
  }

  const transitionedCuts = new Set(
    transitionsOf(sequence).map((transition) => transition.afterClipId)
  )
  let position = 0
  for (let i = 0; i < sequence.spine.length; i++) {
    const item = sequence.spine[i]
    const start = position
    position += item.durationFlicks
    if (item.kind !== 'clip') continue
    if (item.durationFlicks < MIN_CLIP_FLICKS) {
      flags.push({
        flicks: start,
        kind: 'short-clip',
        message: `${fmtSec(item.durationFlicks)} sliver — barely visible`
      })
    }
    const next = sequence.spine[i + 1]
    if (
      next !== undefined &&
      next.kind === 'clip' &&
      next.assetId === item.assetId &&
      next.mediaInFlicks !== item.mediaInFlicks + item.durationFlicks &&
      !transitionedCuts.has(item.id)
    ) {
      flags.push({
        flicks: position,
        kind: 'jump-cut',
        message: 'jump cut within the same source — consider a short dissolve'
      })
    }
  }

  flags.sort((a, b) => a.flicks - b.flicks)
  const score = Math.max(0, 100 - flags.reduce((sum, flag) => sum + PENALTY[flag.kind], 0))
  return { score, flags }
}
