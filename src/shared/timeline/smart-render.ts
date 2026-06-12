import type { ClipFx, Sequence } from './model'
import { DEFAULT_FX } from './ops'
import { transitionsOf } from './transitions'

/**
 * Smart-render eligibility: when the export's video track is "one asset,
 * possibly trimmed, visually untouched", the H.264 bitstream can be
 * stream-copied instead of decoded/composited/re-encoded. Pure sequence
 * inspection — zero DOM, zero Electron, zero IO.
 *
 * Eligible iff the spine is clips from ONE asset, in source order and
 * media-contiguous (equivalent to a single trim — blade-and-leave rejoins
 * keep eligibility), with no gaps, no transitions, no titles, no connected
 * VIDEO clips (lane > 0), captions absent or disabled, and every spine clip's
 * video/color fx at identity with no keyframes. Audio is rendered separately
 * (the full mix), so spine audioDisabled/detached audio and connected AUDIO
 * clips (lane < 0, e.g. a music bed) do not disqualify.
 */
export interface SmartRenderPlan {
  assetId: string
  /** Media-time start of the single equivalent trim. */
  mediaInFlicks: number
  /** Duration of the trim (= the whole sequence duration). */
  durationFlicks: number
}

const VIDEO_PARAMS = [
  'posX',
  'posY',
  'scale',
  'rotation',
  'opacity',
  'exposure',
  'contrast',
  'saturation',
  'temperature'
] as const

/** True when every video/color scalar is at its default and no keyframes exist. */
function videoFxIsIdentity(fx: ClipFx | undefined): boolean {
  if (fx === undefined) return true
  if (fx.kf !== undefined) {
    for (const track of Object.values(fx.kf)) {
      if (track !== undefined && track.length > 0) return false
    }
  }
  return VIDEO_PARAMS.every((param) => fx[param] === DEFAULT_FX[param])
}

/** The single-trim plan when the sequence qualifies for video passthrough; else null. */
export function smartRenderPlan(sequence: Sequence): SmartRenderPlan | null {
  if (sequence.spine.length === 0) return null
  if (transitionsOf(sequence).length > 0) return null
  if (sequence.captions?.enabled === true) return null
  for (const cc of sequence.connected) {
    // lane > 0 composites video; titles are video regardless of lane
    if (cc.lane > 0 || cc.titleData !== undefined) return null
  }
  const first = sequence.spine[0]
  if (first.kind !== 'clip') return null
  let nextMediaIn = first.mediaInFlicks
  let durationFlicks = 0
  for (const item of sequence.spine) {
    if (item.kind !== 'clip') return null
    if (item.assetId !== first.assetId) return null
    if (item.mediaInFlicks !== nextMediaIn) return null
    if (!videoFxIsIdentity(item.fx)) return null
    nextMediaIn += item.durationFlicks
    durationFlicks += item.durationFlicks
  }
  return { assetId: first.assetId, mediaInFlicks: first.mediaInFlicks, durationFlicks }
}
