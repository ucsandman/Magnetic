import type { ClipFx, Sequence, TitleData } from './model'
import { connectedStartOf, spineStartOf } from './model'
import type { ClipInput } from './ops'

/**
 * Pure clipboard payload building + paste planning for copy/paste/duplicate.
 * The payload is position-independent: each entry stores its start relative to
 * the earliest copied clip, so a paste replays the same arrangement anywhere.
 * Renderer-side state (the zustand store) holds the payload; everything here
 * is pure so it unit-tests without Electron.
 */

export interface ClipboardClip {
  assetId: string
  mediaInFlicks: number
  durationFlicks: number
  sourceDurationFlicks: number
  fx?: ClipFx
  titleData?: TitleData
  /** Spine-only Detach Audio flag — preserved so a pasted copy stays silent. */
  audioDisabled?: boolean
  /** undefined = spine clip; non-zero = connected-clip lane (−1 = detached audio). */
  lane?: number
  /** Derived start relative to the earliest copied clip. */
  relOffsetFlicks: number
}

/** One kernel op of a paste replay: insertAt for spine clips, connectAt otherwise. */
export interface PasteStep {
  kind: 'insert' | 'connect'
  clip: ClipInput
  timeFlicks: number
  lane?: number
  titleData?: TitleData
}

/**
 * Snapshot the given clips (spine + connected, gaps and unknown ids skipped)
 * ordered by derived sequence start, offsets rebased onto the earliest clip.
 * fx/titleData are deep-cloned so later edits never mutate the clipboard.
 */
export function buildClipboardPayload(seq: Sequence, clipIds: string[]): ClipboardClip[] {
  const entries: { startFlicks: number; clip: ClipboardClip }[] = []
  for (const clipId of clipIds) {
    const spineItem = seq.spine.find((item) => item.id === clipId)
    if (spineItem !== undefined) {
      if (spineItem.kind !== 'clip') continue
      const start = spineStartOf(seq, clipId)
      if (start === null) continue
      const clip: ClipboardClip = {
        assetId: spineItem.assetId,
        mediaInFlicks: spineItem.mediaInFlicks,
        durationFlicks: spineItem.durationFlicks,
        sourceDurationFlicks: spineItem.sourceDurationFlicks,
        relOffsetFlicks: start
      }
      if (spineItem.fx !== undefined) clip.fx = structuredClone(spineItem.fx)
      if (spineItem.audioDisabled === true) clip.audioDisabled = true
      entries.push({ startFlicks: start, clip })
      continue
    }
    const cc = seq.connected.find((candidate) => candidate.id === clipId)
    if (cc === undefined) continue
    const start = connectedStartOf(seq, clipId)
    if (start === null) continue
    const clip: ClipboardClip = {
      assetId: cc.assetId,
      mediaInFlicks: cc.mediaInFlicks,
      durationFlicks: cc.durationFlicks,
      sourceDurationFlicks: cc.sourceDurationFlicks,
      lane: cc.lane,
      relOffsetFlicks: start
    }
    if (cc.fx !== undefined) clip.fx = structuredClone(cc.fx)
    if (cc.titleData !== undefined) clip.titleData = structuredClone(cc.titleData)
    entries.push({ startFlicks: start, clip })
  }
  if (entries.length === 0) return []
  entries.sort((a, b) => a.startFlicks - b.startFlicks)
  const earliest = entries[0].startFlicks
  return entries.map(({ clip }) => ({
    ...clip,
    relOffsetFlicks: clip.relOffsetFlicks - earliest
  }))
}

/**
 * Plan the kernel ops that replay a payload at `atFlicks`. In 'insert' mode
 * spine clips insert back-to-back at the paste point (magnetic: gaps between
 * copied spine clips collapse) and connected clips connect at their relative
 * offsets; in 'connect' mode everything connects (spine clips land on lane 1).
 * Fresh ids come from `newId`, so kernel duplicate-id validation never trips.
 */
export function pasteSteps(
  payload: ClipboardClip[],
  atFlicks: number,
  mode: 'insert' | 'connect',
  newId: () => string
): PasteStep[] {
  // Inserted spine clips land back-to-back, collapsing any original gaps. Each
  // copied spine clip therefore shifts by (insertedSoFar − relOffset); connected
  // clips inherit the shift of the nearest copied spine clip at/before them so
  // titles and detached audio stay glued to their content after the collapse.
  const spineShifts: { origStart: number; delta: number }[] = []
  if (mode === 'insert') {
    let insertedFlicks = 0
    for (const entry of payload) {
      if (entry.lane !== undefined) continue
      spineShifts.push({
        origStart: entry.relOffsetFlicks,
        delta: insertedFlicks - entry.relOffsetFlicks
      })
      insertedFlicks += entry.durationFlicks
    }
  }
  const shiftAt = (relOffset: number): number => {
    let delta = 0
    for (const shift of spineShifts) {
      if (shift.origStart > relOffset) break
      delta = shift.delta
    }
    return delta
  }

  const steps: PasteStep[] = []
  let insertedFlicks = 0
  for (const entry of payload) {
    const clip: ClipInput = {
      id: newId(),
      assetId: entry.assetId,
      mediaInFlicks: entry.mediaInFlicks,
      durationFlicks: entry.durationFlicks,
      sourceDurationFlicks: entry.sourceDurationFlicks
    }
    if (entry.fx !== undefined) clip.fx = structuredClone(entry.fx)
    if (entry.audioDisabled === true) clip.audioDisabled = true
    if (mode === 'insert' && entry.lane === undefined) {
      steps.push({ kind: 'insert', clip, timeFlicks: atFlicks + insertedFlicks })
      insertedFlicks += entry.durationFlicks
      continue
    }
    const step: PasteStep = {
      kind: 'connect',
      clip,
      timeFlicks: atFlicks + entry.relOffsetFlicks + shiftAt(entry.relOffsetFlicks),
      lane: entry.lane ?? 1
    }
    if (entry.titleData !== undefined) step.titleData = structuredClone(entry.titleData)
    steps.push(step)
  }
  // connect steps last: their parents are the spine AFTER all inserts landed
  return [...steps.filter((s) => s.kind === 'insert'), ...steps.filter((s) => s.kind === 'connect')]
}

/** Derived end (max start + duration) of the given clips; null when none resolve. */
export function selectionEndFlicks(seq: Sequence, clipIds: string[]): number | null {
  let end: number | null = null
  for (const clipId of clipIds) {
    const start = spineStartOf(seq, clipId) ?? connectedStartOf(seq, clipId)
    if (start === null) continue
    const item =
      seq.spine.find((candidate) => candidate.id === clipId) ??
      seq.connected.find((candidate) => candidate.id === clipId)
    if (item === undefined) continue
    end = Math.max(end ?? 0, start + item.durationFlicks)
  }
  return end
}
