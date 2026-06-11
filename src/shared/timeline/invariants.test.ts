import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { flicksPerFrame } from '../timecode'
import type { Clip, ConnectedClip, Sequence } from './model'
import { connectedStartOf, sequenceDuration, spineStartOf } from './model'
import { resolveLaneCollisions } from './magnetic'
import {
  append,
  blade,
  connectAt,
  insertAt,
  liftDelete,
  move,
  overwriteAt,
  rippleDelete,
  rippleDeleteRange,
  roll,
  slip,
  trimRipple,
  type OpResult
} from './ops'
import { UndoStack } from './undo'
import { F, FPS30, deepFreeze } from './testing'

/**
 * Property suites: after ANY randomly generated op sequence the kernel
 * invariants hold, and undo/redo round-trips are exact. Times and deltas are
 * deliberately NOT frame-aligned so shrinking can hunt sub-frame edge cases.
 */

const SOURCE_FRAMES = 600

type Cmd =
  | { op: 'append'; durFrames: number; mediaInFrames: number }
  | { op: 'insertAt'; durFrames: number; mediaInFrames: number; frac: number; jitter: number }
  | { op: 'overwriteAt'; durFrames: number; mediaInFrames: number; frac: number; jitter: number }
  | {
      op: 'connectAt'
      durFrames: number
      mediaInFrames: number
      frac: number
      jitter: number
      lane: number
    }
  | { op: 'rippleDelete'; pick: number }
  | { op: 'liftDelete'; pick: number }
  | { op: 'blade'; pick: number; frac: number; jitter: number }
  | { op: 'trimRipple'; pick: number; edge: 'head' | 'tail'; deltaFrames: number; jitter: number }
  | { op: 'roll'; pick: number; deltaFrames: number; jitter: number }
  | { op: 'slip'; pick: number; deltaFrames: number; jitter: number }
  | { op: 'move'; pick: number; toPick: number }
  | { op: 'rippleDeleteRange'; frac: number; jitter: number; durFrames: number }

const durFrames = fc.integer({ min: 1, max: 50 })
const mediaInFrames = fc.integer({ min: 0, max: 580 })
const frac = fc.double({ min: 0, max: 1.2, noNaN: true })
const jitter = fc.integer({ min: 0, max: F - 1 })
const deltaJitter = fc.integer({ min: -(F - 1), max: F - 1 })
const pick = fc.nat(40)
const deltaFrames = fc.integer({ min: -60, max: 60 })

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ op: fc.constant('append' as const), durFrames, mediaInFrames }),
  fc.record({ op: fc.constant('insertAt' as const), durFrames, mediaInFrames, frac, jitter }),
  fc.record({ op: fc.constant('overwriteAt' as const), durFrames, mediaInFrames, frac, jitter }),
  fc.record({
    op: fc.constant('connectAt' as const),
    durFrames,
    mediaInFrames,
    frac,
    jitter,
    lane: fc.constantFrom(1, -1, 2, -2)
  }),
  fc.record({ op: fc.constant('rippleDelete' as const), pick }),
  fc.record({ op: fc.constant('liftDelete' as const), pick }),
  fc.record({ op: fc.constant('blade' as const), pick, frac, jitter }),
  fc.record({
    op: fc.constant('trimRipple' as const),
    pick,
    edge: fc.constantFrom('head' as const, 'tail' as const),
    deltaFrames,
    jitter: deltaJitter
  }),
  fc.record({ op: fc.constant('roll' as const), pick, deltaFrames, jitter: deltaJitter }),
  fc.record({ op: fc.constant('slip' as const), pick, deltaFrames, jitter: deltaJitter }),
  fc.record({ op: fc.constant('move' as const), pick, toPick: pick }),
  fc.record({ op: fc.constant('rippleDeleteRange' as const), frac, jitter, durFrames })
)

const initialArb: fc.Arbitrary<Sequence> = fc
  .record({
    clips: fc.array(
      fc.record({
        durFrames: fc.integer({ min: 1, max: 100 }),
        mediaInFrames: fc.integer({ min: 0, max: 400 })
      }),
      { minLength: 1, maxLength: 6 }
    ),
    connected: fc.array(
      fc.record({
        parentPick: fc.nat(10),
        offsetFrames: fc.integer({ min: 0, max: 80 }),
        durFrames: fc.integer({ min: 1, max: 30 }),
        lane: fc.constantFrom(1, -1, 2, -2)
      }),
      { maxLength: 3 }
    )
  })
  .map(({ clips, connected }) => {
    const spine = clips.map(
      (c, i): Clip => ({
        kind: 'clip',
        id: `a${i}`,
        assetId: `asset-a${i}`,
        mediaInFlicks: Math.min(c.mediaInFrames, SOURCE_FRAMES - c.durFrames) * F,
        durationFlicks: c.durFrames * F,
        sourceDurationFlicks: SOURCE_FRAMES * F
      })
    )
    const ccs = connected.map(
      (c, i): ConnectedClip => ({
        id: `c${i}`,
        assetId: `asset-c${i}`,
        parentClipId: spine[c.parentPick % spine.length].id,
        offsetFlicks: c.offsetFrames * F,
        lane: c.lane,
        mediaInFlicks: 0,
        durationFlicks: Math.min(c.durFrames, SOURCE_FRAMES) * F,
        sourceDurationFlicks: SOURCE_FRAMES * F
      })
    )
    const seq: Sequence = {
      id: 'seq',
      fps: FPS30,
      spine,
      connected: resolveLaneCollisions(spine, ccs)
    }
    return deepFreeze(seq)
  })

function clipInput(id: string, durFrames: number, mediaInFrames: number): Omit<Clip, 'kind'> {
  return {
    id,
    assetId: `asset-${id}`,
    mediaInFlicks: mediaInFrames * F,
    durationFlicks: durFrames * F,
    sourceDurationFlicks: SOURCE_FRAMES * F
  }
}

function pickSpineId(seq: Sequence, n: number): string {
  if (seq.spine.length === 0) return 'missing'
  return seq.spine[n % seq.spine.length].id
}

function applyCommand(seq: Sequence, cmd: Cmd, step: number): OpResult {
  const total = sequenceDuration(seq)
  switch (cmd.op) {
    case 'append':
      return append(seq, { clip: clipInput(`n${step}`, cmd.durFrames, cmd.mediaInFrames) })
    case 'insertAt':
      return insertAt(seq, {
        clip: clipInput(`n${step}`, cmd.durFrames, cmd.mediaInFrames),
        timeFlicks: Math.round(cmd.frac * total) + cmd.jitter
      })
    case 'overwriteAt':
      return overwriteAt(seq, {
        clip: clipInput(`n${step}`, cmd.durFrames, cmd.mediaInFrames),
        timeFlicks: Math.round(cmd.frac * total) + cmd.jitter
      })
    case 'connectAt':
      return connectAt(seq, {
        clip: clipInput(`n${step}`, cmd.durFrames, cmd.mediaInFrames),
        timeFlicks: Math.round(cmd.frac * total) + cmd.jitter,
        lane: cmd.lane
      })
    case 'rippleDelete':
      return rippleDelete(seq, { ids: [pickSpineId(seq, cmd.pick)] })
    case 'liftDelete':
      return liftDelete(seq, { ids: [pickSpineId(seq, cmd.pick)] })
    case 'blade': {
      const id = pickSpineId(seq, cmd.pick)
      const start = spineStartOf(seq, id) ?? 0
      const item = seq.spine.find((candidate) => candidate.id === id)
      const duration = item?.durationFlicks ?? 0
      return blade(seq, {
        clipId: id,
        timeFlicks: start + Math.round(cmd.frac * duration) + cmd.jitter
      })
    }
    case 'trimRipple':
      return trimRipple(seq, {
        clipId: pickSpineId(seq, cmd.pick),
        edge: cmd.edge,
        deltaFlicks: cmd.deltaFrames * F + cmd.jitter
      })
    case 'roll':
      return roll(seq, {
        editPointIndex: cmd.pick % Math.max(seq.spine.length, 1),
        deltaFlicks: cmd.deltaFrames * F + cmd.jitter
      })
    case 'slip':
      return slip(seq, {
        clipId: pickSpineId(seq, cmd.pick),
        deltaFlicks: cmd.deltaFrames * F + cmd.jitter
      })
    case 'move':
      return move(seq, {
        clipId: pickSpineId(seq, cmd.pick),
        toIndex: cmd.toPick % Math.max(seq.spine.length, 1)
      })
    case 'rippleDeleteRange': {
      const from = Math.round(cmd.frac * total) + cmd.jitter
      return rippleDeleteRange(seq, { fromFlicks: from, toFlicks: from + cmd.durFrames * F })
    }
  }
}

function checkInvariants(seq: Sequence): void {
  const minFlicks = flicksPerFrame(seq.fps)
  const spineIds = new Set<string>()
  let position = 0
  for (const item of seq.spine) {
    expect(item.durationFlicks, `duration of ${item.id}`).toBeGreaterThanOrEqual(minFlicks)
    if (item.kind === 'clip') {
      expect(item.mediaInFlicks, `mediaIn of ${item.id}`).toBeGreaterThanOrEqual(0)
      expect(
        item.mediaInFlicks + item.durationFlicks,
        `media bounds of ${item.id}`
      ).toBeLessThanOrEqual(item.sourceDurationFlicks)
    }
    expect(spineIds.has(item.id), `duplicate spine id ${item.id}`).toBe(false)
    spineIds.add(item.id)
    // derived positions strictly increasing: each start matches the prefix sum
    expect(spineStartOf(seq, item.id), `start of ${item.id}`).toBe(position)
    position += item.durationFlicks
  }
  const placed: { lane: number; start: number; end: number }[] = []
  for (const cc of seq.connected) {
    expect(cc.durationFlicks, `duration of connected ${cc.id}`).toBeGreaterThanOrEqual(minFlicks)
    expect(cc.mediaInFlicks, `mediaIn of connected ${cc.id}`).toBeGreaterThanOrEqual(0)
    expect(
      cc.mediaInFlicks + cc.durationFlicks,
      `media bounds of connected ${cc.id}`
    ).toBeLessThanOrEqual(cc.sourceDurationFlicks)
    expect(spineIds.has(cc.parentClipId), `parent of ${cc.id} exists`).toBe(true)
    const start = connectedStartOf(seq, cc.id)!
    const end = start + cc.durationFlicks
    for (const other of placed) {
      const overlaps = other.lane === cc.lane && other.start < end && start < other.end
      expect(overlaps, `lane ${cc.lane} overlap at ${start}`).toBe(false)
    }
    placed.push({ lane: cc.lane, start, end })
  }
}

describe('kernel property suites', () => {
  it('any random op sequence preserves all spine + connected invariants', () => {
    fc.assert(
      fc.property(
        initialArb,
        fc.array(cmdArb, { minLength: 20, maxLength: 30 }),
        (initial, cmds) => {
          checkInvariants(initial)
          let current = initial
          cmds.forEach((cmd, step) => {
            const result = applyCommand(current, cmd, step)
            if (result.error !== undefined) {
              // total functions: errors must leave the sequence untouched
              expect(result.next).toBe(current)
            }
            // the inverse always restores the pre-op sequence
            expect(result.inverse.type).toBe('restore')
            expect(result.inverse.sequence).toBe(current)
            current = deepFreeze(result.next)
            checkInvariants(current)
          })
        }
      ),
      { numRuns: 200 }
    )
  })

  it('undo N times restores the deep-equal initial state; redo N restores the final', () => {
    fc.assert(
      fc.property(
        initialArb,
        fc.array(cmdArb, { minLength: 1, maxLength: 25 }),
        (initial, cmds) => {
          const stack = new UndoStack(initial)
          cmds.forEach((cmd, step) => stack.apply((seq) => applyCommand(seq, cmd, step)))
          const final = stack.current
          while (stack.canUndo) stack.undo()
          expect(stack.current).toEqual(initial)
          while (stack.canRedo) stack.redo()
          expect(stack.current).toEqual(final)
        }
      ),
      { numRuns: 200 }
    )
  })
})
