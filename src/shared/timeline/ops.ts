import { flicksPerFrame } from '../timecode'
import type {
  CaptionSettings,
  Clip,
  ClipFx,
  ClipRole,
  ConnectedClip,
  Sequence,
  SpineItem,
  TitleData,
  Transition,
  TransitionKind
} from './model'
import {
  connectedStartOf,
  markerIsVisible,
  sequenceDuration,
  spineIndexOf,
  spineStartOf,
  type Marker,
  type MarkerColor
} from './model'
import { itemAtTime, reattachByTime, resolveLaneCollisions } from './magnetic'
import { editPointIndexOfCut, editPointInfo, pruneTransitions, transitionsOf } from './transitions'

/**
 * Edit operations on the magnetic timeline. Every op is a total function
 * `(seq, args) → OpResult`: invalid arguments return the SAME sequence
 * reference plus a typed error — ops never throw mid-edit. The inverse is a
 * restore op carrying the prior sequence (snapshot undo).
 */

export interface OpError {
  code:
    | 'invalid-clip'
    | 'duplicate-id'
    | 'unknown-id'
    | 'out-of-range'
    | 'invalid-target'
    | 'invariant'
  message: string
}

export type Inverse = { type: 'restore'; sequence: Sequence }

export interface OpResult {
  next: Sequence
  inverse: Inverse
  error?: OpError
}

/** Clip payload for ops that introduce new media (kind is implied). */
export type ClipInput = Omit<Clip, 'kind'>

function ok(
  prev: Sequence,
  spine: SpineItem[],
  connected: ConnectedClip[],
  transitions?: Transition[]
): OpResult {
  const resolved = resolveLaneCollisions(spine, connected)
  const next: Sequence = { ...prev, spine, connected: resolved }
  if (transitions !== undefined) next.transitions = transitions
  // spine edits can remove cuts or shrink handles — keep transitions valid
  const pruned = pruneTransitions(next)
  if (pruned !== undefined) next.transitions = pruned
  // markers whose media moment no clip shows any more disappear (undoably —
  // the inverse restores the pre-edit sequence, markers included)
  if (next.markers !== undefined && next.markers.length > 0) {
    const kept = next.markers.filter((marker) => markerIsVisible(next, marker))
    if (kept.length !== next.markers.length) next.markers = kept
  }
  return {
    next,
    inverse: { type: 'restore', sequence: prev }
  }
}

/** Clean no-op: same sequence reference, no error. */
function noop(seq: Sequence): OpResult {
  return { next: seq, inverse: { type: 'restore', sequence: seq } }
}

function fail(seq: Sequence, code: OpError['code'], message: string): OpResult {
  return {
    next: seq,
    inverse: { type: 'restore', sequence: seq },
    error: { code, message }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function allIds(seq: Sequence): Set<string> {
  const ids = new Set<string>()
  for (const item of seq.spine) ids.add(item.id)
  for (const cc of seq.connected) ids.add(cc.id)
  return ids
}

/** Deterministic id allocation: use the base, or suffix ~2, ~3, … on collision. */
function uniqueId(ids: Set<string>, base: string): string {
  let id = base
  let n = 2
  while (ids.has(id)) {
    id = `${base}~${n}`
    n += 1
  }
  ids.add(id)
  return id
}

function validateClipInput(seq: Sequence, input: ClipInput): OpError | null {
  if (input.durationFlicks < flicksPerFrame(seq.fps)) {
    return { code: 'invalid-clip', message: `clip "${input.id}" is shorter than one frame` }
  }
  if (input.mediaInFlicks < 0) {
    return { code: 'invalid-clip', message: `clip "${input.id}" has a negative media in-point` }
  }
  if (input.mediaInFlicks + input.durationFlicks > input.sourceDurationFlicks) {
    return { code: 'invalid-clip', message: `clip "${input.id}" exceeds its source media` }
  }
  if (allIds(seq).has(input.id)) {
    return { code: 'duplicate-id', message: `id "${input.id}" already exists in the sequence` }
  }
  return null
}

/** Mutable working copy of the editable parts of a sequence. */
interface Working {
  spine: SpineItem[]
  connected: ConnectedClip[]
}

/**
 * Split the spine item at `index` into head (keeps its id) + tail
 * (id `${id}:${absoluteFlicks}`, media continues seamlessly). Connected clips
 * at or past the cut move to the tail with their offset rebased.
 */
function splitInWorking(
  working: Working,
  ids: Set<string>,
  index: number,
  localFlicks: number,
  absoluteFlicks: number
): void {
  const item = working.spine[index]
  const tailId = uniqueId(ids, `${item.id}:${absoluteFlicks}`)
  const tailDuration = item.durationFlicks - localFlicks
  const head: SpineItem = { ...item, durationFlicks: localFlicks }
  const tail: SpineItem =
    item.kind === 'clip'
      ? {
          ...item,
          id: tailId,
          mediaInFlicks: item.mediaInFlicks + localFlicks,
          durationFlicks: tailDuration
        }
      : { ...item, id: tailId, durationFlicks: tailDuration }
  working.spine.splice(index, 1, head, tail)
  working.connected = working.connected.map((cc) =>
    cc.parentClipId === item.id && cc.offsetFlicks >= localFlicks
      ? { ...cc, parentClipId: tailId, offsetFlicks: cc.offsetFlicks - localFlicks }
      : cc
  )
}

/**
 * Guarantee a spine boundary at (or near) `timeFlicks` and return its actual
 * position: existing boundaries are reused, mid-item times split the item, and
 * times within one frame of an item edge snap to that edge instead of cutting
 * a sub-frame sliver.
 */
function ensureBoundary(
  working: Working,
  ids: Set<string>,
  timeFlicks: number,
  minFlicks: number
): number {
  let position = 0
  for (let i = 0; i < working.spine.length; i++) {
    if (timeFlicks <= position) return position
    const duration = working.spine[i].durationFlicks
    const end = position + duration
    if (timeFlicks < end) {
      const local = timeFlicks - position
      if (local < minFlicks) return position
      if (duration - local < minFlicks) return end
      splitInWorking(working, ids, i, local, timeFlicks)
      return timeFlicks
    }
    position = end
  }
  return position
}

export function append(seq: Sequence, args: { clip: ClipInput }): OpResult {
  const error = validateClipInput(seq, args.clip)
  if (error) return fail(seq, error.code, error.message)
  return ok(seq, [...seq.spine, { kind: 'clip', ...args.clip }], seq.connected)
}

export function insertAt(seq: Sequence, args: { clip: ClipInput; timeFlicks: number }): OpResult {
  const error = validateClipInput(seq, args.clip)
  if (error) return fail(seq, error.code, error.message)
  const total = sequenceDuration(seq)
  const time = clamp(args.timeFlicks, 0, total)
  const working: Working = { spine: [...seq.spine], connected: seq.connected }
  const ids = allIds(seq)
  const minFlicks = flicksPerFrame(seq.fps)
  const boundary = ensureBoundary(working, ids, time, minFlicks)
  let insertIndex = working.spine.length
  let position = 0
  for (let i = 0; i < working.spine.length; i++) {
    if (boundary === position) {
      insertIndex = i
      break
    }
    position += working.spine[i].durationFlicks
  }
  working.spine.splice(insertIndex, 0, { kind: 'clip', ...args.clip })
  return ok(seq, working.spine, working.connected)
}

export function overwriteAt(
  seq: Sequence,
  args: { clip: ClipInput; timeFlicks: number }
): OpResult {
  const error = validateClipInput(seq, args.clip)
  if (error) return fail(seq, error.code, error.message)
  if (args.timeFlicks < 0) {
    return fail(seq, 'out-of-range', `cannot overwrite at negative time ${args.timeFlicks}`)
  }
  const total = sequenceDuration(seq)
  const minFlicks = flicksPerFrame(seq.fps)
  const working: Working = { spine: [...seq.spine], connected: seq.connected }
  const ids = allIds(seq)
  const end = ensureBoundary(
    working,
    ids,
    Math.min(args.timeFlicks + args.clip.durationFlicks, total),
    minFlicks
  )
  const start = Math.min(
    ensureBoundary(working, ids, Math.min(args.timeFlicks, total), minFlicks),
    end
  )
  const newClip: SpineItem = { kind: 'clip', ...args.clip }
  const spine: SpineItem[] = []
  let inserted = false
  let position = 0
  for (const item of working.spine) {
    const itemEnd = position + item.durationFlicks
    if (!inserted && position >= start) {
      spine.push(newClip)
      inserted = true
    }
    const covered = position >= start && itemEnd <= end
    if (!covered) spine.push(item)
    position = itemEnd
  }
  if (!inserted) {
    const gapLength = args.timeFlicks - position
    if (gapLength >= minFlicks) {
      spine.push({
        kind: 'gap',
        id: uniqueId(ids, `gap:${args.clip.id}`),
        durationFlicks: gapLength
      })
    }
    spine.push(newClip)
  }
  const connected = reattachByTime(seq, spine, working.connected)
  return ok(seq, spine, connected)
}

export function connectAt(
  seq: Sequence,
  args: { clip: ClipInput; timeFlicks: number; lane?: number; titleData?: TitleData }
): OpResult {
  const error = validateClipInput(seq, args.clip)
  if (error) return fail(seq, error.code, error.message)
  if (args.lane === 0) {
    return fail(seq, 'invalid-target', 'lane 0 is the spine; connected clips need a non-zero lane')
  }
  const target = itemAtTime(seq.spine, args.timeFlicks)
  if (target === null) {
    return fail(seq, 'out-of-range', `no spine item at time ${args.timeFlicks}`)
  }
  const cc: ConnectedClip = {
    id: args.clip.id,
    assetId: args.clip.assetId,
    parentClipId: target.item.id,
    offsetFlicks: args.timeFlicks - target.startFlicks,
    lane: args.lane ?? 1,
    mediaInFlicks: args.clip.mediaInFlicks,
    durationFlicks: args.clip.durationFlicks,
    sourceDurationFlicks: args.clip.sourceDurationFlicks
  }
  if (args.clip.fx !== undefined) cc.fx = args.clip.fx
  if (args.titleData !== undefined) cc.titleData = args.titleData
  if (args.clip.audioDisabled === true) cc.audioDisabled = true
  return ok(seq, seq.spine, [...seq.connected, cc])
}

function validateSpineIds(seq: Sequence, ids: string[]): OpError | null {
  const missing = ids.filter((id) => spineIndexOf(seq, id) === -1)
  if (missing.length > 0) {
    return { code: 'unknown-id', message: `not in the spine: ${missing.join(', ')}` }
  }
  return null
}

export function rippleDelete(seq: Sequence, args: { ids: string[] }): OpResult {
  const error = validateSpineIds(seq, args.ids)
  if (error) return fail(seq, error.code, error.message)
  if (args.ids.length === 0) return noop(seq)
  const removal = new Set(args.ids)
  const spine = seq.spine.filter((item) => !removal.has(item.id))
  const connected = reattachByTime(seq, spine, seq.connected)
  return ok(seq, spine, connected)
}

export function liftDelete(seq: Sequence, args: { ids: string[] }): OpResult {
  const error = validateSpineIds(seq, args.ids)
  if (error) return fail(seq, error.code, error.message)
  if (args.ids.length === 0) return noop(seq)
  const removal = new Set(args.ids)
  const ids = allIds(seq)
  const gapIdByOld = new Map<string, string>()
  const spine = seq.spine.map((item): SpineItem => {
    if (!removal.has(item.id)) return item
    const gapId = uniqueId(ids, `gap:${item.id}`)
    gapIdByOld.set(item.id, gapId)
    return { kind: 'gap', id: gapId, durationFlicks: item.durationFlicks }
  })
  const connected = seq.connected.map((cc) => {
    const gapId = gapIdByOld.get(cc.parentClipId)
    return gapId === undefined ? cc : { ...cc, parentClipId: gapId }
  })
  return ok(seq, spine, connected)
}

export function blade(seq: Sequence, args: { clipId: string; timeFlicks: number }): OpResult {
  const index = spineIndexOf(seq, args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no spine item "${args.clipId}"`)
  const item = seq.spine[index]
  const local = args.timeFlicks - spineStartOf(seq, args.clipId)!
  const minFlicks = flicksPerFrame(seq.fps)
  // Boundary cuts — and cuts that would leave a sub-frame sliver — are no-ops.
  if (local < minFlicks || item.durationFlicks - local < minFlicks) return noop(seq)
  const working: Working = { spine: [...seq.spine], connected: seq.connected }
  splitInWorking(working, allIds(seq), index, local, args.timeFlicks)
  return ok(seq, working.spine, working.connected)
}

export function trimRipple(
  seq: Sequence,
  args: { clipId: string; edge: 'head' | 'tail'; deltaFlicks: number }
): OpResult {
  const index = spineIndexOf(seq, args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no spine item "${args.clipId}"`)
  const item = seq.spine[index]
  const minFlicks = flicksPerFrame(seq.fps)
  let replacement: SpineItem
  if (args.edge === 'tail') {
    const maxDuration =
      item.kind === 'clip'
        ? item.sourceDurationFlicks - item.mediaInFlicks
        : Number.MAX_SAFE_INTEGER
    const duration = clamp(item.durationFlicks + args.deltaFlicks, minFlicks, maxDuration)
    if (duration === item.durationFlicks) return noop(seq)
    replacement = { ...item, durationFlicks: duration }
  } else if (item.kind === 'clip') {
    // Positive head delta shrinks from the front: duration down, mediaIn up.
    const delta = clamp(args.deltaFlicks, -item.mediaInFlicks, item.durationFlicks - minFlicks)
    if (delta === 0) return noop(seq)
    replacement = {
      ...item,
      mediaInFlicks: item.mediaInFlicks + delta,
      durationFlicks: item.durationFlicks - delta
    }
  } else {
    const delta = clamp(args.deltaFlicks, -Number.MAX_SAFE_INTEGER, item.durationFlicks - minFlicks)
    if (delta === 0) return noop(seq)
    replacement = { ...item, durationFlicks: item.durationFlicks - delta }
  }
  const spine = [...seq.spine]
  spine[index] = replacement
  return ok(seq, spine, seq.connected)
}

export function roll(
  seq: Sequence,
  args: { editPointIndex: number; deltaFlicks: number }
): OpResult {
  const index = args.editPointIndex
  if (!Number.isInteger(index) || index < 0 || index >= seq.spine.length - 1) {
    return fail(seq, 'invalid-target', `no edit point at index ${index}`)
  }
  const left = seq.spine[index]
  const right = seq.spine[index + 1]
  const minFlicks = flicksPerFrame(seq.fps)
  const leftExtendRoom =
    left.kind === 'clip'
      ? left.sourceDurationFlicks - left.mediaInFlicks - left.durationFlicks
      : Number.MAX_SAFE_INTEGER
  const rightExtendRoom = right.kind === 'clip' ? right.mediaInFlicks : Number.MAX_SAFE_INTEGER
  const actual =
    args.deltaFlicks >= 0
      ? Math.min(args.deltaFlicks, leftExtendRoom, right.durationFlicks - minFlicks)
      : Math.max(args.deltaFlicks, -(left.durationFlicks - minFlicks), -rightExtendRoom)
  if (actual === 0) return noop(seq)
  const spine = [...seq.spine]
  spine[index] = { ...left, durationFlicks: left.durationFlicks + actual }
  spine[index + 1] =
    right.kind === 'clip'
      ? {
          ...right,
          mediaInFlicks: right.mediaInFlicks + actual,
          durationFlicks: right.durationFlicks - actual
        }
      : { ...right, durationFlicks: right.durationFlicks - actual }
  return ok(seq, spine, seq.connected)
}

export function slip(seq: Sequence, args: { clipId: string; deltaFlicks: number }): OpResult {
  const index = spineIndexOf(seq, args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no spine item "${args.clipId}"`)
  const item = seq.spine[index]
  if (item.kind !== 'clip') return fail(seq, 'invalid-target', 'cannot slip a gap')
  const mediaIn = clamp(
    item.mediaInFlicks + args.deltaFlicks,
    0,
    item.sourceDurationFlicks - item.durationFlicks
  )
  if (mediaIn === item.mediaInFlicks) return noop(seq)
  const spine = [...seq.spine]
  spine[index] = { ...item, mediaInFlicks: mediaIn }
  return ok(seq, spine, seq.connected)
}

/**
 * Detach a spine clip's audio into a connected lane −1 clip covering the same
 * media window. The spine clip keeps its video and gets `audioDisabled: true`;
 * the new audio clip starts at offset 0 and follows its parent magnetically.
 */
export function detachAudio(seq: Sequence, args: { clipId: string }): OpResult {
  const index = spineIndexOf(seq, args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no spine item "${args.clipId}"`)
  const item = seq.spine[index]
  if (item.kind !== 'clip') return fail(seq, 'invalid-target', 'gaps carry no audio to detach')
  if (item.audioDisabled === true) {
    return fail(seq, 'invalid-target', `audio of "${args.clipId}" is already detached`)
  }
  const spine = [...seq.spine]
  spine[index] = { ...item, audioDisabled: true }
  const audioClip: ConnectedClip = {
    id: uniqueId(allIds(seq), `${args.clipId}:audio`),
    assetId: item.assetId,
    parentClipId: args.clipId,
    offsetFlicks: 0,
    lane: -1,
    mediaInFlicks: item.mediaInFlicks,
    durationFlicks: item.durationFlicks,
    sourceDurationFlicks: item.sourceDurationFlicks
  }
  return ok(seq, spine, [...seq.connected, audioClip])
}

/**
 * Trim a connected clip's head or tail independently of its parent — the
 * split-edit primitive. A negative head delta pulls the start earlier
 * (offset can go negative = J-cut); a negative tail delta ends it early
 * (L-cut). Head clamps: media start, one-frame minimum, derived absolute
 * start ≥ 0. Tail clamps: one-frame minimum, source media end.
 */
export function trimConnected(
  seq: Sequence,
  args: { clipId: string; edge: 'head' | 'tail'; deltaFlicks: number }
): OpResult {
  const index = seq.connected.findIndex((cc) => cc.id === args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no connected clip "${args.clipId}"`)
  const cc = seq.connected[index]
  const minFlicks = flicksPerFrame(seq.fps)
  let replacement: ConnectedClip
  if (args.edge === 'head') {
    const startFlicks = connectedStartOf(seq, args.clipId)
    if (startFlicks === null) {
      return fail(seq, 'invalid-target', `connected clip "${args.clipId}" has no spine parent`)
    }
    // Positive delta shrinks from the front; negative reveals earlier media,
    // bounded by media start AND by absolute time 0 (offset may go negative).
    const delta = clamp(
      args.deltaFlicks,
      Math.max(-cc.mediaInFlicks, -startFlicks),
      cc.durationFlicks - minFlicks
    )
    if (delta === 0) return noop(seq)
    replacement = {
      ...cc,
      offsetFlicks: cc.offsetFlicks + delta,
      mediaInFlicks: cc.mediaInFlicks + delta,
      durationFlicks: cc.durationFlicks - delta
    }
  } else {
    // looped clips tile their media, so the source-end clamp does not apply
    const maxDuration =
      cc.loop === true ? Number.MAX_SAFE_INTEGER : cc.sourceDurationFlicks - cc.mediaInFlicks
    const duration = clamp(cc.durationFlicks + args.deltaFlicks, minFlicks, maxDuration)
    if (duration === cc.durationFlicks) return noop(seq)
    replacement = { ...cc, durationFlicks: duration }
  }
  const connected = [...seq.connected]
  connected[index] = replacement
  return ok(seq, seq.spine, connected)
}

/**
 * Set or clear a connected clip's loop-to-fill flag (undoable). Setting it
 * lifts trimConnected's tail clamp so the clip can stretch past its source
 * (the media tiles — see ConnectedClip.loop). Clearing it restores the
 * non-loop invariant in the same op: mediaIn is normalized back into the
 * source (head trims on a looped clip may push it past the end) and the
 * duration is clamped to the remaining source window — one atomic undo step,
 * never an out-of-bounds non-loop clip.
 */
export function setConnectedLoop(seq: Sequence, args: { clipId: string; loop: boolean }): OpResult {
  const index = seq.connected.findIndex((cc) => cc.id === args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no connected clip "${args.clipId}"`)
  const cc = seq.connected[index]
  if (cc.titleData !== undefined) {
    return fail(seq, 'invalid-target', 'titles carry no media to loop')
  }
  if ((cc.loop === true) === args.loop) return noop(seq)
  let replacement: ConnectedClip
  if (args.loop) {
    replacement = { ...cc, loop: true }
  } else {
    const minFlicks = flicksPerFrame(seq.fps)
    const mediaIn = Math.min(
      cc.mediaInFlicks % cc.sourceDurationFlicks,
      cc.sourceDurationFlicks - minFlicks
    )
    replacement = {
      ...cc,
      mediaInFlicks: mediaIn,
      durationFlicks: clamp(cc.durationFlicks, minFlicks, cc.sourceDurationFlicks - mediaIn)
    }
    delete replacement.loop
  }
  const connected = [...seq.connected]
  connected[index] = replacement
  return ok(seq, seq.spine, connected)
}

export const DEFAULT_FX: ClipFx = {
  posX: 0,
  posY: 0,
  scale: 100,
  rotation: 0,
  opacity: 100,
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  fadeInFlicks: 0,
  fadeOutFlicks: 0,
  volumeDb: 0,
  pan: 0
}

/** Set the video transform of a spine clip or connected clip (undoable). */
export function setClipFx(seq: Sequence, args: { clipId: string; fx: ClipFx }): OpResult {
  const spineIndex = spineIndexOf(seq, args.clipId)
  if (spineIndex !== -1) {
    const item = seq.spine[spineIndex]
    if (item.kind !== 'clip') {
      return fail(seq, 'invalid-target', 'gaps cannot carry fx')
    }
    const spine = [...seq.spine]
    spine[spineIndex] = { ...item, fx: args.fx }
    return ok(seq, spine, seq.connected)
  }
  const connectedIndex = seq.connected.findIndex((cc) => cc.id === args.clipId)
  if (connectedIndex === -1) return fail(seq, 'unknown-id', `no clip "${args.clipId}"`)
  const connected = [...seq.connected]
  connected[connectedIndex] = { ...connected[connectedIndex], fx: args.fx }
  return ok(seq, seq.spine, connected)
}

/**
 * Ripple-delete an arbitrary time range: ensure boundaries at both ends
 * (splitting clips as needed, with the usual sub-frame snapping), drop every
 * item fully inside, and let derived positions close the gap. One undo step.
 */
export function rippleDeleteRange(
  seq: Sequence,
  args: { fromFlicks: number; toFlicks: number }
): OpResult {
  const total = sequenceDuration(seq)
  const from = clamp(Math.min(args.fromFlicks, args.toFlicks), 0, total)
  const to = clamp(Math.max(args.fromFlicks, args.toFlicks), 0, total)
  const minFlicks = flicksPerFrame(seq.fps)
  if (to - from < minFlicks) return noop(seq)
  const working: Working = { spine: [...seq.spine], connected: seq.connected }
  const ids = allIds(seq)
  const end = ensureBoundary(working, ids, to, minFlicks)
  const start = Math.min(ensureBoundary(working, ids, from, minFlicks), end)
  const spine: SpineItem[] = []
  let position = 0
  for (const item of working.spine) {
    const itemEnd = position + item.durationFlicks
    const covered = position >= start && itemEnd <= end
    if (!covered) spine.push(item)
    position = itemEnd
  }
  if (spine.length === working.spine.length) return noop(seq)

  // Media-bearing connected clips (detached audio, B-roll) overlapping the
  // removed range are CUT like the spine — otherwise a detached audio clip
  // keeps playing the deleted span and desyncs from the video. Titles keep
  // the old reattach-by-time behavior (they are decoration, not media).
  const removedLen = end - start
  const untouched: ConnectedClip[] = []
  const overlapping: ConnectedClip[] = []
  for (const cc of working.connected) {
    const oldAbs = connectedStartOf(seq, cc.id)
    const overlaps =
      cc.titleData === undefined &&
      oldAbs !== null &&
      oldAbs < end &&
      oldAbs + cc.durationFlicks > start
    ;(overlaps ? overlapping : untouched).push(cc)
  }
  const connected = reattachByTime(seq, spine, untouched)
  for (const cc of overlapping) {
    const oldAbs = connectedStartOf(seq, cc.id)
    if (oldAbs === null) continue
    const oldEnd = oldAbs + cc.durationFlicks
    const pieces: { absStart: number; mediaIn: number; duration: number }[] = []
    if (oldAbs < start) {
      pieces.push({
        absStart: oldAbs,
        mediaIn: cc.mediaInFlicks,
        duration: Math.min(oldEnd, start) - oldAbs
      })
    }
    if (oldEnd > end) {
      const afterStart = Math.max(oldAbs, end)
      pieces.push({
        absStart: afterStart - removedLen,
        mediaIn: cc.mediaInFlicks + (afterStart - oldAbs),
        duration: oldEnd - afterStart
      })
    }
    let first = true
    for (const piece of pieces) {
      if (piece.duration < minFlicks) continue
      const target = itemAtTime(spine, piece.absStart)
      if (target === null) continue
      connected.push({
        ...cc,
        id: first ? cc.id : uniqueId(ids, cc.id),
        parentClipId: target.item.id,
        offsetFlicks: piece.absStart - target.startFlicks,
        mediaInFlicks: piece.mediaIn,
        durationFlicks: piece.duration
      })
      first = false
    }
  }
  return ok(seq, spine, connected)
}

const MARKER_COLORS: readonly MarkerColor[] = ['blue', 'green', 'orange', 'red']

/**
 * Add a marker at a media moment some clip currently shows (undoable).
 * Callers usually derive (assetId, atMediaFlicks) from the playhead.
 */
export function addMarker(
  seq: Sequence,
  args: { assetId: string; atMediaFlicks: number; text: string; color: MarkerColor; id?: string }
): OpResult {
  if (!MARKER_COLORS.includes(args.color)) {
    return fail(seq, 'invalid-target', `unknown marker color "${args.color}"`)
  }
  const marker: Marker = {
    id: args.id ?? uniqueId(new Set(seq.markers?.map((m) => m.id)), 'marker'),
    assetId: args.assetId,
    atMediaFlicks: args.atMediaFlicks,
    text: args.text,
    color: args.color
  }
  if (seq.markers?.some((existing) => existing.id === marker.id) === true) {
    return fail(seq, 'duplicate-id', `marker id "${marker.id}" already exists`)
  }
  if (!markerIsVisible(seq, marker)) {
    return fail(seq, 'invalid-target', 'no clip is showing that media moment')
  }
  return {
    next: { ...seq, markers: [...(seq.markers ?? []), marker] },
    inverse: { type: 'restore', sequence: seq }
  }
}

export function removeMarker(seq: Sequence, args: { markerId: string }): OpResult {
  const markers = seq.markers ?? []
  const kept = markers.filter((marker) => marker.id !== args.markerId)
  if (kept.length === markers.length) {
    return fail(seq, 'unknown-id', `no marker "${args.markerId}"`)
  }
  return {
    next: { ...seq, markers: kept },
    inverse: { type: 'restore', sequence: seq }
  }
}

export function updateMarker(
  seq: Sequence,
  args: { markerId: string; text?: string; color?: MarkerColor }
): OpResult {
  if (args.color !== undefined && !MARKER_COLORS.includes(args.color)) {
    return fail(seq, 'invalid-target', `unknown marker color "${args.color}"`)
  }
  const index = (seq.markers ?? []).findIndex((marker) => marker.id === args.markerId)
  if (index === -1) return fail(seq, 'unknown-id', `no marker "${args.markerId}"`)
  const markers = [...seq.markers!]
  markers[index] = {
    ...markers[index],
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.color !== undefined ? { color: args.color } : {})
  }
  return {
    next: { ...seq, markers },
    inverse: { type: 'restore', sequence: seq }
  }
}

const ROLE_VALUES: readonly ClipRole[] = ['dialogue', 'music', 'sfx']

/** Tag a spine clip or connected media clip with an audio role (undoable). */
export function setClipRole(seq: Sequence, args: { clipId: string; role: ClipRole }): OpResult {
  if (!ROLE_VALUES.includes(args.role)) {
    return fail(seq, 'invalid-target', `unknown role "${args.role}"`)
  }
  const spineIndex = spineIndexOf(seq, args.clipId)
  if (spineIndex !== -1) {
    const item = seq.spine[spineIndex]
    if (item.kind !== 'clip') return fail(seq, 'invalid-target', 'gaps carry no audio role')
    if (item.role === args.role) return noop(seq)
    const spine = [...seq.spine]
    spine[spineIndex] = { ...item, role: args.role }
    return ok(seq, spine, seq.connected)
  }
  const connectedIndex = seq.connected.findIndex((cc) => cc.id === args.clipId)
  if (connectedIndex === -1) return fail(seq, 'unknown-id', `no clip "${args.clipId}"`)
  const cc = seq.connected[connectedIndex]
  if (cc.titleData !== undefined) return fail(seq, 'invalid-target', 'titles carry no audio role')
  if (cc.role === args.role) return noop(seq)
  const connected = [...seq.connected]
  connected[connectedIndex] = { ...cc, role: args.role }
  return ok(seq, seq.spine, connected)
}

/** Set the roles silenced in the mix (mute/solo; undoable, persists with the sequence). */
export function setMutedRoles(seq: Sequence, args: { roles: ClipRole[] }): OpResult {
  for (const role of args.roles) {
    if (!ROLE_VALUES.includes(role)) {
      return fail(seq, 'invalid-target', `unknown role "${role}"`)
    }
  }
  const roles = [...new Set(args.roles)].sort()
  const current = seq.mutedRoles ?? []
  if (roles.length === current.length && roles.every((role, i) => role === current[i])) {
    return noop(seq)
  }
  return {
    next: { ...seq, mutedRoles: roles },
    inverse: { type: 'restore', sequence: seq }
  }
}

export const DEFAULT_CAPTIONS: CaptionSettings = {
  enabled: false,
  preset: 'pop-in',
  font: 'system-ui, sans-serif',
  sizePx: 56,
  color: '#ffffff',
  highlightColor: '#ffd60a',
  position: 'bottom'
}

const CAPTION_PRESETS: readonly CaptionSettings['preset'][] = ['pop-in', 'karaoke', 'block']
const CAPTION_POSITIONS: readonly CaptionSettings['position'][] = ['bottom', 'middle', 'top']

/** Set the sequence-level caption settings (undoable; persists via saveSequence). */
export function setCaptionSettings(seq: Sequence, args: { captions: CaptionSettings }): OpResult {
  const captions = args.captions
  if (!CAPTION_PRESETS.includes(captions.preset)) {
    return fail(seq, 'invalid-target', `unknown caption preset "${captions.preset}"`)
  }
  if (!CAPTION_POSITIONS.includes(captions.position)) {
    return fail(seq, 'invalid-target', `unknown caption position "${captions.position}"`)
  }
  if (!Number.isFinite(captions.sizePx) || captions.sizePx <= 0) {
    return fail(seq, 'invalid-target', `caption size must be a positive number`)
  }
  return {
    next: { ...seq, captions },
    inverse: { type: 'restore', sequence: seq }
  }
}

/** Update a connected title's text payload (undoable). */
export function setTitleData(
  seq: Sequence,
  args: { clipId: string; titleData: TitleData }
): OpResult {
  const index = seq.connected.findIndex((cc) => cc.id === args.clipId)
  if (index === -1) return fail(seq, 'unknown-id', `no connected clip "${args.clipId}"`)
  const connected = [...seq.connected]
  connected[index] = { ...connected[index], titleData: args.titleData }
  return ok(seq, seq.spine, connected)
}

/** Add (or replace) a centered transition at an edit point between two clips. */
export function addTransition(
  seq: Sequence,
  args: { editPointIndex: number; durationFlicks: number; kind: TransitionKind }
): OpResult {
  const info = editPointInfo(seq, args.editPointIndex)
  if (info === null) {
    return fail(seq, 'invalid-target', 'transitions need an edit point between two clips')
  }
  const minFlicks = flicksPerFrame(seq.fps)
  if (info.maxDurationFlicks < minFlicks) {
    return fail(seq, 'invalid-target', 'no media handles on one side of the cut')
  }
  const duration = clamp(args.durationFlicks, minFlicks, info.maxDurationFlicks)
  const ids = new Set(transitionsOf(seq).map((transition) => transition.id))
  const id = uniqueId(ids, `tr:${info.left.id}`)
  const kept = transitionsOf(seq).filter((transition) => transition.afterClipId !== info.left.id)
  return ok(seq, seq.spine, seq.connected, [
    ...kept,
    { id, afterClipId: info.left.id, durationFlicks: duration, kind: args.kind }
  ])
}

export function removeTransition(seq: Sequence, args: { transitionId: string }): OpResult {
  const list = transitionsOf(seq)
  if (!list.some((transition) => transition.id === args.transitionId)) {
    return fail(seq, 'unknown-id', `no transition "${args.transitionId}"`)
  }
  return ok(
    seq,
    seq.spine,
    seq.connected,
    list.filter((transition) => transition.id !== args.transitionId)
  )
}

export function resizeTransition(
  seq: Sequence,
  args: { transitionId: string; durationFlicks: number }
): OpResult {
  const list = transitionsOf(seq)
  const target = list.find((transition) => transition.id === args.transitionId)
  if (target === undefined) return fail(seq, 'unknown-id', `no transition "${args.transitionId}"`)
  const info = editPointInfo(seq, editPointIndexOfCut(seq, target.afterClipId))
  if (info === null) return fail(seq, 'invalid-target', 'transition cut no longer exists')
  const duration = clamp(args.durationFlicks, flicksPerFrame(seq.fps), info.maxDurationFlicks)
  return ok(
    seq,
    seq.spine,
    seq.connected,
    list.map((transition) =>
      transition.id === args.transitionId ? { ...transition, durationFlicks: duration } : transition
    )
  )
}

export function setTransitionKind(
  seq: Sequence,
  args: { transitionId: string; kind: TransitionKind }
): OpResult {
  const list = transitionsOf(seq)
  if (!list.some((transition) => transition.id === args.transitionId)) {
    return fail(seq, 'unknown-id', `no transition "${args.transitionId}"`)
  }
  return ok(
    seq,
    seq.spine,
    seq.connected,
    list.map((transition) =>
      transition.id === args.transitionId ? { ...transition, kind: args.kind } : transition
    )
  )
}

export function move(seq: Sequence, args: { clipId: string; toIndex: number }): OpResult {
  const from = spineIndexOf(seq, args.clipId)
  if (from === -1) return fail(seq, 'unknown-id', `no spine item "${args.clipId}"`)
  const to = clamp(args.toIndex, 0, seq.spine.length - 1)
  if (to === from) return noop(seq)
  const spine = [...seq.spine]
  const [item] = spine.splice(from, 1)
  spine.splice(to, 0, item)
  return ok(seq, spine, seq.connected)
}
