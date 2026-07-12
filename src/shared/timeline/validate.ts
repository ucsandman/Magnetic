import { flicksPerFrame } from '../timecode'
import type { Sequence } from './model'
import { connectedStartOf } from './model'
import type { OpError } from './ops'

/**
 * Runtime magnetic-timeline legality check — the invariants the property
 * suites enforce (invariants.test.ts), promoted to a typed guard so PROPOSED
 * sequences (rough cut, future copilot edits) can be rejected before they
 * ever reach the undo stack. Collects every violation rather than stopping
 * at the first.
 */
export function validateSequence(seq: Sequence): OpError[] {
  const errors: OpError[] = []
  const minFlicks = flicksPerFrame(seq.fps)
  const spineIds = new Set<string>()

  for (const item of seq.spine) {
    if (item.durationFlicks < minFlicks) {
      errors.push({
        code: 'invalid-clip',
        message: `spine item "${item.id}" is shorter than one frame`
      })
    }
    if (item.kind === 'clip') {
      if (item.mediaInFlicks < 0) {
        errors.push({ code: 'out-of-range', message: `clip "${item.id}" has negative mediaIn` })
      }
      if (item.mediaInFlicks + item.durationFlicks > item.sourceDurationFlicks) {
        errors.push({
          code: 'out-of-range',
          message: `clip "${item.id}" media window overruns its source`
        })
      }
    }
    if (spineIds.has(item.id)) {
      errors.push({ code: 'duplicate-id', message: `duplicate spine id "${item.id}"` })
    }
    spineIds.add(item.id)
  }

  const placed: { lane: number; start: number; end: number; id: string }[] = []
  for (const cc of seq.connected) {
    if (cc.durationFlicks < minFlicks) {
      errors.push({
        code: 'invalid-clip',
        message: `connected clip "${cc.id}" is shorter than one frame`
      })
    }
    if (cc.mediaInFlicks < 0) {
      errors.push({
        code: 'out-of-range',
        message: `connected clip "${cc.id}" has negative mediaIn`
      })
    }
    // looped clips tile their media, so the duration is unbounded by the source
    if (cc.loop !== true && cc.mediaInFlicks + cc.durationFlicks > cc.sourceDurationFlicks) {
      errors.push({
        code: 'out-of-range',
        message: `connected clip "${cc.id}" media window overruns its source`
      })
    }
    if (!spineIds.has(cc.parentClipId)) {
      errors.push({
        code: 'unknown-id',
        message: `connected clip "${cc.id}" parent "${cc.parentClipId}" is not on the spine`
      })
      continue // no derived start without a parent
    }
    const start = connectedStartOf(seq, cc.id)
    if (start === null) continue
    const end = start + cc.durationFlicks
    for (const other of placed) {
      if (other.lane === cc.lane && other.start < end && start < other.end) {
        errors.push({
          code: 'invariant',
          message: `connected clips "${other.id}" and "${cc.id}" overlap on lane ${cc.lane}`
        })
      }
    }
    placed.push({ lane: cc.lane, start, end, id: cc.id })
  }

  return errors
}
