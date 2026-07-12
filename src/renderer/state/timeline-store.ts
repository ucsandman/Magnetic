import { create } from 'zustand'
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../shared/timecode'
import {
  clipAtTime,
  connectedStartOf,
  sequenceDuration,
  spineStartOf,
  type Clip,
  type ConnectedClip,
  type Sequence
} from '../../shared/timeline/model'
import {
  buildClipboardPayload,
  pasteSteps,
  selectionEndFlicks,
  type ClipboardClip
} from '../../shared/timeline/clipboard'
import { rebaseKeyframes } from '../../shared/timeline/fx-eval'
import {
  addMarker,
  addTransition,
  append,
  blade,
  connectAt,
  DEFAULT_FX,
  detachAudio,
  setCaptionSettings,
  setConnectedLoop,
  insertAt,
  liftDelete,
  move,
  overwriteAt,
  rippleDelete,
  rippleDeleteRange,
  roll,
  setClipFx,
  setClipRole,
  setMutedRoles,
  setTitleData,
  setTransitionKind,
  slip,
  trimConnected,
  trimRipple,
  type ClipInput,
  type OpResult
} from '../../shared/timeline/ops'
import type {
  CaptionSettings,
  ClipFx,
  ClipRole,
  TitleData,
  TransitionKind
} from '../../shared/timeline/model'
import { transitionsOf } from '../../shared/timeline/transitions'
import { TITLE_PRESETS } from '../titles/render'
import {
  clearRange,
  emptySelection,
  pruneSelection,
  selectOnly,
  setRange,
  toggleInSelection,
  type Selection
} from '../../shared/timeline/select'
import { touchedClipIds } from '../../shared/timeline/diff'
import { DEFAULT_TARGET_LUFS, normalizeGainDb } from '../../shared/loudness'
import { UndoStack, type Op } from '../../shared/timeline/undo'
import { validateSequence } from '../../shared/timeline/validate'
import {
  buildRoughCutProposal,
  cutPointsFor,
  type RoughCutPoint,
  type RoughCutRange
} from '../agent/roughcut'
import { executeEditTool } from '../copilot/tools'
import { playbackEngine } from '../playback/engine'
import { loadLoopPref, saveLoopPref } from '../playback/loop'
import { measureDraws } from '../timeline/perf'
import { timelineView } from '../timeline/view-probe'

/**
 * Timeline state. Every sequence mutation goes through a kernel op applied on
 * the UndoStack; the store mirrors the stack's current sequence and persists
 * it (debounced) into the project JSON via IPC.
 */

const PERSIST_DELAY_MS = 250
const MIN_ZOOM = 4
const MAX_ZOOM = 1000

/** Source media for an edit command: browser selection + viewer I/O range. */
export interface SourceClip {
  assetId: string
  mediaInFlicks: number
  durationFlicks: number
  sourceDurationFlicks: number
  /** fps of the source video; adopted as sequence format on first edit. */
  fps: Rational | null
}

let stack: UndoStack | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null

export type Tool = 'select' | 'blade' | 'trim'

interface TimelineStore {
  projectId: string | null
  sequence: Sequence | null
  selection: Selection
  playheadFlicks: number
  zoomPxPerSec: number
  snapping: boolean
  skimming: boolean
  tool: Tool
  setTool(tool: Tool): void
  /** What the single viewer shows: a source clip or the sequence (phase 7). */
  viewerMode: 'source' | 'sequence'
  setViewerMode(mode: 'source' | 'sequence'): void
  isSequencePlaying: boolean
  setSequencePlaying(playing: boolean): void
  /** Loop-playback view setting (Ctrl+L); persisted, not undoable. */
  loopPlayback: boolean
  setLoopPlayback(loop: boolean): void
  setFx(clipId: string, fx: ClipFx): void
  /** Tag a clip's audio role (undoable). */
  setRole(clipId: string, role: ClipRole): void
  /** Drop a blue marker on the spine clip under the playhead (M). */
  addMarkerAtPlayhead(): void
  /**
   * Measure each clip's source loudness and set its volume so it plays at the
   * target LUFS (one undo group). Returns how many clips were adjusted.
   */
  normalizeLoudness(clipIds: string[], targetLufs?: number): Promise<number>
  /** Replace the set of muted roles (mute/solo buttons; undoable). */
  setRoleMutes(roles: ClipRole[]): void
  setTitle(clipId: string, titleData: TitleData): void
  /** Sequence-level burned-in caption settings (undoable). */
  setCaptions(captions: CaptionSettings): void
  /** Default 1 s dissolve at the edit point nearest the playhead (Ctrl+T). */
  addTransitionAtPlayhead(): void
  cycleTransitionKind(transitionId: string): void
  /** Connect a title preset at the playhead on the lane above the spine. */
  connectTitleAtPlayhead(preset: TitleData['preset']): void
  /** Ripple-delete several time ranges as ONE undo step (back-to-front). */
  deleteRanges(ranges: { fromFlicks: number; toFlicks: number }[]): void
  /** Session-only clipboard: selected clips relative to the earliest (Ctrl+C). */
  clipboard: ClipboardClip[]
  /** Snapshot the selected clips into the clipboard. */
  copySelection(): void
  /** Replay the clipboard at the playhead as ONE undo step (Ctrl+V / Ctrl+Shift+V). */
  pasteAtPlayhead(mode: 'insert' | 'connect'): void
  /** Duplicate the selected clips right after the selection's end (Ctrl+D). */
  duplicateSelection(): void
  /** Apply the single copied clip's fx (incl. keyframes) to every selected clip. */
  pasteAttributes(): void
  /** Selection time-range (transcript word selection ↔ timeline band). */
  setTimeRange(fromFlicks: number | null, toFlicks?: number): void
  /** Candidate dead-air ranges previewed on the timeline (SilencePanel owns this). */
  silenceRanges: { fromFlicks: number; toFlicks: number }[] | null
  setSilenceRanges(ranges: { fromFlicks: number; toFlicks: number }[] | null): void
  /**
   * Ephemeral rough-cut provenance (RoughCutPanel review + canvas AI badges).
   * Valid only while `sequence` IS `resultSequence` — any later edit or undo
   * replaces the sequence object and closes the review window. Never persisted.
   */
  roughCut: {
    baseSequence: Sequence
    resultSequence: Sequence
    ranges: RoughCutRange[]
    cuts: RoughCutPoint[]
  } | null
  /**
   * Ghost-diff-before-commit: a validated scratch sequence that has NOT
   * touched the undo stack. The canvas ghost-renders it; Accept replays it as
   * one undo group, Discard drops it leaving ZERO history. Stale the moment
   * `sequence` is no longer `baseSequence` (the human kept editing — allowed).
   */
  pendingProposal: {
    baseSequence: Sequence
    proposedSequence: Sequence
    /** Rough-cut proposals carry ranges: Accept re-applies them with per-cut
     *  review provenance. Copilot op batches carry null + a change list. */
    ranges: RoughCutRange[] | null
    /** Plain-English change list (copilot batches). */
    changes: string[]
    /** Replayable op log (copilot batches) — enables partial accept. */
    ops: { name: string; input: unknown; summary: string }[] | null
    label: 'Rough Cut' | 'Copilot' | 'Agent'
  } | null
  /**
   * Build + validate a rough-cut proposal against the current sequence.
   * False (with a console warning) when the plan is empty, no-ops, or fails
   * the validateSequence gate — an unusable proposal is never offered.
   */
  proposeRoughCut(ranges: RoughCutRange[]): boolean
  /**
   * Offer a copilot op batch (already executed against a scratch) as the
   * pending proposal. Same gates: validated, non-empty, computed against the
   * CURRENT sequence.
   */
  proposeCopilotChanges(
    proposedSequence: Sequence,
    ops: { name: string; input: unknown; summary: string }[],
    label?: 'Copilot' | 'Agent'
  ): boolean
  /** Commit the pending proposal through the undo stack as ONE group. */
  acceptProposal(): void
  /**
   * Partial accept: replay only the ops at `indices` (original order) against
   * the base — transactionally: any failed op or invariant violation aborts
   * the whole accept and keeps the proposal pending. Returns success.
   */
  acceptCopilotOps(indices: number[]): boolean
  /** Drop the pending proposal. Zero history entries by construction. */
  discardProposal(): void
  /** Where the copilot last touched the timeline (ruler marker); ephemeral. */
  agentPlayheadFlicks: number | null
  setAgentPlayhead(flicks: number | null): void
  /** True while the human is mid-gesture on the timeline (drag/scrub). */
  isInteracting: boolean
  setInteracting(interacting: boolean): void
  /** External agent requests parked behind an active gesture ("N queued"). */
  agentQueuedCount: number
  bumpAgentQueued(delta: number): void
  /**
   * Session-only provenance: clips whose content an accepted AI pass changed
   * (clip dot + Inspector line). Never persisted into the project.
   */
  attributions: ReadonlyMap<string, { actor: 'Copilot' | 'Rough Cut'; atMs: number }>
  /**
   * Flow self-check of the last accepted AI pass (score chip + ruler flag
   * markers). Valid only while `sequence` IS `forSequence`; panels compute it
   * (they own the envelopes) and any later edit silently retires it.
   */
  flowReport: {
    forSequence: Sequence
    score: number
    flags: { flicks: number; kind: string; message: string }[]
  } | null
  setFlowReport(report: TimelineStore['flowReport']): void
  /**
   * Ripple-delete a rough-cut plan (ascending, non-overlapping — what
   * planRoughCut returns) as ONE undo step, remembering provenance.
   */
  applyRoughCut(ranges: RoughCutRange[]): void
  /** Restore one applied cut, keeping the rest (spell-checker style). */
  rejectRoughCutCut(index: number): void
  clearRoughCut(): void
  load(): Promise<void>
  applyOp(op: Op): OpResult | null
  bladeAt(clipId: string, timeFlicks: number): void
  /** Blade every selected spine clip (or the clip under the playhead) at the playhead. */
  bladeAtPlayhead(): void
  rollEditPoint(editPointIndex: number, deltaFlicks: number): void
  slipClip(clipId: string, deltaFlicks: number): void
  trimClip(clipId: string, edge: 'head' | 'tail', deltaFlicks: number): void
  /** Detach a spine clip's audio into a connected lane −1 clip (J/L-cut prep). */
  detachAudio(clipId: string): void
  /** Trim a connected clip's edge independently of its parent (J/L cuts). */
  trimConnectedClip(clipId: string, edge: 'head' | 'tail', deltaFlicks: number): void
  /** Loop a connected audio clip and stretch it to the spine end (ONE undo step). */
  loopConnectedToSpineEnd(clipId: string): void
  /** Clear the loop flag; the duration clamps back into the source (one op). */
  unloopConnected(clipId: string): void
  appendSource(src: SourceClip): void
  insertSourceAtPlayhead(src: SourceClip): void
  overwriteSourceAtPlayhead(src: SourceClip): void
  connectSourceAtPlayhead(src: SourceClip): void
  connectSourceAt(src: SourceClip, timeFlicks: number): void
  deleteSelection(mode: 'ripple' | 'lift'): void
  moveClip(clipId: string, toIndex: number): void
  undo(): void
  redo(): void
  selectClip(id: string, additive: boolean): void
  clearSelection(): void
  setPlayhead(flicks: number): void
  setZoom(pxPerSec: number): void
  zoomBy(factor: number): void
  toggleSnapping(): void
  toggleSkimming(): void
}

/** A timeline clip (spine or connected) with its derived sequence start. */
function timelineClipOf(
  sequence: Sequence,
  clipId: string
): { clip: Clip | ConnectedClip; startFlicks: number } | null {
  const spineItem = sequence.spine.find((item) => item.id === clipId)
  if (spineItem !== undefined) {
    if (spineItem.kind !== 'clip') return null
    const start = spineStartOf(sequence, clipId)
    return start === null ? null : { clip: spineItem, startFlicks: start }
  }
  const connected = sequence.connected.find((cc) => cc.id === clipId)
  if (connected === undefined) return null
  const start = connectedStartOf(sequence, clipId)
  return start === null ? null : { clip: connected, startFlicks: start }
}

/** A clip's media time at a sequence time, clamped to its media window (keyframe writes). */
export function clipMediaTimeAt(
  sequence: Sequence,
  clipId: string,
  timeFlicks: number
): number | null {
  const found = timelineClipOf(sequence, clipId)
  if (found === null) return null
  const offset = Math.min(Math.max(timeFlicks - found.startFlicks, 0), found.clip.durationFlicks)
  return found.clip.mediaInFlicks + offset
}

/** Inverse mapping: the sequence time at which a clip shows a media time (keyframe nav). */
export function clipSequenceTimeOfMedia(
  sequence: Sequence,
  clipId: string,
  mediaFlicks: number
): number | null {
  const found = timelineClipOf(sequence, clipId)
  if (found === null) return null
  return found.startFlicks + (mediaFlicks - found.clip.mediaInFlicks)
}

function clipInputFrom(src: SourceClip): ClipInput {
  return {
    id: crypto.randomUUID(),
    assetId: src.assetId,
    mediaInFlicks: src.mediaInFlicks,
    durationFlicks: src.durationFlicks,
    sourceDurationFlicks: src.sourceDurationFlicks
  }
}

/** First edit into an empty sequence adopts the source's frame rate (FCP behavior). */
function withAdoptedFps(seq: Sequence, src: SourceClip): Sequence {
  if (seq.spine.length > 0 || seq.connected.length > 0 || src.fps === null) return seq
  if (seq.fps.num === src.fps.num && seq.fps.den === src.fps.den) return seq
  return { ...seq, fps: src.fps }
}

export const useTimelineStore = create<TimelineStore>((set, get) => {
  function syncFromStack(): void {
    if (stack === null) return
    const sequence = stack.current
    set((state) => ({
      sequence,
      selection: pruneSelection(state.selection, sequence)
    }))
    window.api.notifyEditState({ canUndo: stack.canUndo, canRedo: stack.canRedo })
    schedulePersist()
  }

  function schedulePersist(): void {
    const { projectId, sequence } = get()
    if (projectId === null || sequence === null) return
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void window.api.saveSequence(projectId, sequence)
    }, PERSIST_DELAY_MS)
  }

  function apply(op: Op): OpResult | null {
    if (stack === null) return null
    const result = stack.apply(op)
    syncFromStack()
    return result
  }

  /** Stamp session-only provenance on every clip an accepted AI pass touched. */
  function recordAttribution(base: Sequence, next: Sequence, actor: 'Copilot' | 'Rough Cut'): void {
    const touched = touchedClipIds(base, next)
    if (touched.size === 0) return
    set((state) => {
      const attributions = new Map(state.attributions)
      const atMs = Date.now()
      for (const id of touched) attributions.set(id, { actor, atMs })
      return { attributions }
    })
  }

  /** Replay a clipboard payload at `atFlicks` through kernel ops as ONE undo step. */
  function replayClipboard(
    payload: ClipboardClip[],
    atFlicks: number,
    mode: 'insert' | 'connect'
  ): void {
    if (stack === null || payload.length === 0) return
    stack.beginGroup()
    const failures: string[] = []
    for (const step of pasteSteps(payload, atFlicks, mode, () => crypto.randomUUID())) {
      const result = stack.apply((seq) =>
        step.kind === 'insert'
          ? insertAt(seq, { clip: step.clip, timeFlicks: step.timeFlicks })
          : connectAt(seq, {
              clip: step.clip,
              timeFlicks: step.timeFlicks,
              lane: step.lane,
              titleData: step.titleData
            })
      )
      if (result.error !== undefined) failures.push(`${step.kind}: ${result.error.message}`)
    }
    stack.endGroup()
    if (failures.length > 0) {
      console.warn(`paste: ${failures.length} clip(s) skipped — ${failures.join('; ')}`)
    }
    syncFromStack()
  }

  return {
    projectId: null,
    sequence: null,
    selection: emptySelection(),
    playheadFlicks: 0,
    zoomPxPerSec: 60,
    snapping: true,
    skimming: true,
    tool: 'select',
    viewerMode: 'source',
    isSequencePlaying: false,
    loopPlayback: loadLoopPref(),

    setTool(tool) {
      set({ tool })
    },

    setViewerMode(viewerMode) {
      set({ viewerMode })
    },

    setSequencePlaying(isSequencePlaying) {
      set({ isSequencePlaying })
    },

    setLoopPlayback(loopPlayback) {
      set({ loopPlayback })
      playbackEngine.setLoop(loopPlayback)
      saveLoopPref(loopPlayback)
    },

    setFx(clipId, fx) {
      apply((seq) => setClipFx(seq, { clipId, fx }))
    },

    setRole(clipId, role) {
      apply((seq) => setClipRole(seq, { clipId, role }))
    },

    addMarkerAtPlayhead() {
      const { sequence, playheadFlicks } = get()
      if (sequence === null) return
      const item = clipAtTime(sequence, playheadFlicks)
      if (item === null || item.kind !== 'clip') return
      const start = spineStartOf(sequence, item.id)
      if (start === null) return
      apply((seq) =>
        addMarker(seq, {
          assetId: item.assetId,
          atMediaFlicks: item.mediaInFlicks + (playheadFlicks - start),
          text: '',
          color: 'blue'
        })
      )
    },

    async normalizeLoudness(clipIds, targetLufs = DEFAULT_TARGET_LUFS) {
      const { sequence } = get()
      if (stack === null || sequence === null) return 0
      const targets: { clipId: string; assetId: string; fx: ClipFx | undefined }[] = []
      for (const clipId of clipIds) {
        const spine = sequence.spine.find((item) => item.id === clipId && item.kind === 'clip')
        if (spine !== undefined && spine.kind === 'clip') {
          targets.push({ clipId, assetId: spine.assetId, fx: spine.fx })
          continue
        }
        const cc = sequence.connected.find(
          (candidate) => candidate.id === clipId && candidate.titleData === undefined
        )
        if (cc !== undefined) targets.push({ clipId, assetId: cc.assetId, fx: cc.fx })
      }
      const lufsByAsset = new Map<string, number | null>()
      await Promise.all(
        [...new Set(targets.map((target) => target.assetId))].map(async (assetId) => {
          try {
            lufsByAsset.set(assetId, await window.api.audioLoudness(assetId))
          } catch {
            lufsByAsset.set(assetId, null)
          }
        })
      )
      const adjustable = targets.filter(
        (target) => (lufsByAsset.get(target.assetId) ?? null) !== null
      )
      if (adjustable.length === 0) return 0
      stack.beginGroup()
      for (const target of adjustable) {
        const gain = normalizeGainDb(lufsByAsset.get(target.assetId)!, targetLufs)
        stack.apply((seq) =>
          setClipFx(seq, {
            clipId: target.clipId,
            fx: { ...DEFAULT_FX, ...(target.fx ?? {}), volumeDb: gain }
          })
        )
      }
      stack.endGroup()
      syncFromStack()
      return adjustable.length
    },

    setRoleMutes(roles) {
      apply((seq) => setMutedRoles(seq, { roles }))
    },

    setTitle(clipId, titleData) {
      apply((seq) => setTitleData(seq, { clipId, titleData }))
    },

    setCaptions(captions) {
      apply((seq) => setCaptionSettings(seq, { captions }))
    },

    addTransitionAtPlayhead() {
      const { sequence, playheadFlicks } = get()
      if (sequence === null || sequence.spine.length < 2) return
      let best = -1
      let bestDistance = Infinity
      let position = 0
      for (let i = 0; i < sequence.spine.length - 1; i++) {
        position += sequence.spine[i].durationFlicks
        const distance = Math.abs(position - playheadFlicks)
        if (distance < bestDistance) {
          bestDistance = distance
          best = i
        }
      }
      if (best === -1) return
      apply((seq) =>
        addTransition(seq, {
          editPointIndex: best,
          durationFlicks: FLICKS_PER_SECOND,
          kind: 'dissolve'
        })
      )
    },

    cycleTransitionKind(transitionId) {
      const sequence = get().sequence
      if (sequence === null) return
      const target = transitionsOf(sequence).find((t) => t.id === transitionId)
      if (target === undefined) return
      const kinds: TransitionKind[] = ['dissolve', 'wipeL', 'wipeR', 'fadeBlack']
      const next = kinds[(kinds.indexOf(target.kind) + 1) % kinds.length]
      apply((seq) => setTransitionKind(seq, { transitionId, kind: next }))
    },

    connectTitleAtPlayhead(preset) {
      const { playheadFlicks } = get()
      const titleData = TITLE_PRESETS[preset].make()
      apply((seq) =>
        connectAt(seq, {
          clip: {
            id: crypto.randomUUID(),
            assetId: 'title',
            mediaInFlicks: 0,
            durationFlicks: 4 * FLICKS_PER_SECOND,
            sourceDurationFlicks: 24 * 3600 * FLICKS_PER_SECOND
          },
          timeFlicks: playheadFlicks,
          lane: 1,
          titleData
        })
      )
    },

    bladeAt(clipId, timeFlicks) {
      apply((seq) => blade(seq, { clipId, timeFlicks }))
    },

    bladeAtPlayhead() {
      const { sequence, selection, playheadFlicks } = get()
      if (sequence === null) return
      const selectedSpine = selection.clipIds.filter((id) =>
        sequence.spine.some((item) => item.id === id)
      )
      const targets =
        selectedSpine.length > 0
          ? selectedSpine
          : [clipAtTime(sequence, playheadFlicks)?.id].filter(
              (id): id is string => id !== undefined
            )
      for (const clipId of targets) {
        apply((seq) => blade(seq, { clipId, timeFlicks: playheadFlicks }))
      }
    },

    rollEditPoint(editPointIndex, deltaFlicks) {
      apply((seq) => roll(seq, { editPointIndex, deltaFlicks }))
    },

    slipClip(clipId, deltaFlicks) {
      apply((seq) => slip(seq, { clipId, deltaFlicks }))
    },

    trimClip(clipId, edge, deltaFlicks) {
      apply((seq) => trimRipple(seq, { clipId, edge, deltaFlicks }))
    },

    detachAudio(clipId) {
      apply((seq) => detachAudio(seq, { clipId }))
    },

    trimConnectedClip(clipId, edge, deltaFlicks) {
      apply((seq) => trimConnected(seq, { clipId, edge, deltaFlicks }))
    },

    loopConnectedToSpineEnd(clipId) {
      const { sequence } = get()
      if (stack === null || sequence === null) return
      const cc = sequence.connected.find((candidate) => candidate.id === clipId)
      const startFlicks = connectedStartOf(sequence, clipId)
      if (cc === undefined || startFlicks === null) return
      const targetFlicks = sequenceDuration(sequence) - startFlicks
      stack.beginGroup()
      stack.apply((seq) => setConnectedLoop(seq, { clipId, loop: true }))
      stack.apply((seq) =>
        trimConnected(seq, { clipId, edge: 'tail', deltaFlicks: targetFlicks - cc.durationFlicks })
      )
      stack.endGroup()
      syncFromStack()
    },

    unloopConnected(clipId) {
      apply((seq) => setConnectedLoop(seq, { clipId, loop: false }))
    },

    async load() {
      // A pending debounced save would persist the PRE-load sequence over
      // whatever we are about to read (e.g. after Delete Media pruned clips).
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      const project = await window.api.getProject()
      stack = new UndoStack(project.sequence)
      set({ projectId: project.id, sequence: project.sequence })
    },

    applyOp(op) {
      return apply(op)
    },

    appendSource(src) {
      apply((seq) => append(withAdoptedFps(seq, src), { clip: clipInputFrom(src) }))
    },

    insertSourceAtPlayhead(src) {
      const time = get().playheadFlicks
      apply((seq) =>
        insertAt(withAdoptedFps(seq, src), { clip: clipInputFrom(src), timeFlicks: time })
      )
    },

    overwriteSourceAtPlayhead(src) {
      const time = get().playheadFlicks
      apply((seq) =>
        overwriteAt(withAdoptedFps(seq, src), { clip: clipInputFrom(src), timeFlicks: time })
      )
    },

    connectSourceAtPlayhead(src) {
      get().connectSourceAt(src, get().playheadFlicks)
    },

    connectSourceAt(src, timeFlicks) {
      apply((seq) => connectAt(seq, { clip: clipInputFrom(src), timeFlicks, lane: 1 }))
    },

    deleteRanges(ranges) {
      if (stack === null || ranges.length === 0) return
      stack.beginGroup()
      for (const range of [...ranges].sort((a, b) => b.fromFlicks - a.fromFlicks)) {
        stack.apply((seq) => rippleDeleteRange(seq, range))
      }
      stack.endGroup()
      syncFromStack()
    },

    clipboard: [],

    copySelection() {
      const { sequence, selection } = get()
      if (sequence === null) return
      const payload = buildClipboardPayload(sequence, selection.clipIds)
      if (payload.length === 0) return
      set({ clipboard: payload })
    },

    pasteAtPlayhead(mode) {
      const { clipboard, playheadFlicks } = get()
      replayClipboard(clipboard, playheadFlicks, mode)
    },

    duplicateSelection() {
      const { sequence, selection } = get()
      if (sequence === null) return
      const payload = buildClipboardPayload(sequence, selection.clipIds)
      const end = selectionEndFlicks(sequence, selection.clipIds)
      if (payload.length === 0 || end === null) return
      replayClipboard(payload, end, 'insert')
    },

    pasteAttributes() {
      const { clipboard, sequence, selection } = get()
      // Attributes come from exactly ONE copied clip — ambiguous otherwise.
      if (stack === null || sequence === null || clipboard.length !== 1) return
      if (selection.clipIds.length === 0) return
      const fx = clipboard[0].fx ?? DEFAULT_FX
      stack.beginGroup()
      for (const clipId of selection.clipIds) {
        // Keyframes are media-time anchored to the SOURCE clip — shift them
        // into each target's media window so the animation keeps its shape.
        const target =
          sequence.spine.find((item) => item.id === clipId && item.kind === 'clip') ??
          sequence.connected.find((candidate) => candidate.id === clipId)
        const rebased =
          target !== undefined && 'mediaInFlicks' in target
            ? rebaseKeyframes(fx, clipboard[0].mediaInFlicks, target.mediaInFlicks)
            : fx
        stack.apply((seq) => setClipFx(seq, { clipId, fx: structuredClone(rebased) }))
      }
      stack.endGroup()
      syncFromStack()
    },

    silenceRanges: null,

    setSilenceRanges(silenceRanges) {
      set({ silenceRanges })
    },

    pendingProposal: null,

    proposeRoughCut(ranges) {
      const { sequence } = get()
      if (sequence === null || ranges.length === 0) return false
      const { proposed, errors } = buildRoughCutProposal(sequence, ranges)
      if (errors.length > 0 || proposed === sequence) {
        const detail = errors.map((error) => `${error.code}: ${error.message}`).join('; ')
        console.warn(`rough cut proposal rejected — ${detail || 'plan removes nothing'}`)
        return false
      }
      set({
        pendingProposal: {
          baseSequence: sequence,
          proposedSequence: proposed,
          ranges,
          changes: [],
          ops: null,
          label: 'Rough Cut'
        }
      })
      return true
    },

    proposeCopilotChanges(proposedSequence, ops, label = 'Copilot') {
      const { sequence } = get()
      if (sequence === null || proposedSequence === sequence) return false
      const violations = validateSequence(proposedSequence)
      if (violations.length > 0) {
        console.warn(
          `copilot proposal rejected — ${violations.map((error) => `${error.code}: ${error.message}`).join('; ')}`
        )
        return false
      }
      set({
        pendingProposal: {
          baseSequence: sequence,
          proposedSequence,
          ranges: null,
          changes: ops.map((op) => op.summary),
          ops,
          label
        }
      })
      return true
    },

    acceptCopilotOps(indices) {
      const { sequence, pendingProposal } = get()
      if (stack === null || pendingProposal === null || pendingProposal.ops === null) return false
      if (sequence === null || sequence !== pendingProposal.baseSequence) {
        set({ pendingProposal: null })
        return false
      }
      const keep = new Set(indices)
      const ops = pendingProposal.ops.filter((_, index) => keep.has(index))
      if (ops.length === pendingProposal.ops.length) {
        get().acceptProposal()
        return true
      }
      if (ops.length === 0) {
        set({ pendingProposal: null })
        return true
      }
      // Transactional replay: the kept ops re-execute in original order; any
      // failure (or invariant violation) aborts and leaves the proposal
      // pending so the human can pick a different subset.
      let scratch: Sequence = sequence
      for (const op of ops) {
        const outcome = executeEditTool(scratch, op.name, op.input)
        if (!outcome.ok) {
          console.warn(`partial accept aborted at "${op.summary}" — ${outcome.resultText}`)
          return false
        }
        scratch = outcome.next
      }
      if (validateSequence(scratch).length > 0) return false
      if (scratch === sequence) {
        set({ pendingProposal: null })
        return true
      }
      stack.apply((seq) => ({
        next: scratch,
        inverse: { type: 'restore', sequence: seq }
      }))
      syncFromStack()
      set({ pendingProposal: null })
      recordAttribution(sequence, scratch, 'Copilot')
      return true
    },

    acceptProposal() {
      const { sequence, pendingProposal } = get()
      if (pendingProposal === null) return
      // The scratch was computed against this exact sequence; if the human
      // kept editing underneath it, the proposal is stale and silently drops.
      if (sequence !== pendingProposal.baseSequence) {
        set({ pendingProposal: null })
        return
      }
      if (pendingProposal.ranges !== null) {
        set({ pendingProposal: null })
        get().applyRoughCut(pendingProposal.ranges)
        return
      }
      // Op batches commit as ONE snapshot entry through the same stack the
      // human's keystrokes use: {before: base, after: proposed} — one Ctrl+Z.
      if (stack === null) return
      // Apply BEFORE clearing so outcome watchers (agent gateway) see the
      // sequence move off the base while the proposal is still identifiable.
      stack.apply((seq) => ({
        next: pendingProposal.proposedSequence,
        inverse: { type: 'restore', sequence: seq }
      }))
      syncFromStack()
      set({ pendingProposal: null })
      recordAttribution(pendingProposal.baseSequence, pendingProposal.proposedSequence, 'Copilot')
    },

    discardProposal() {
      set({ pendingProposal: null })
    },

    agentPlayheadFlicks: null,

    setAgentPlayhead(agentPlayheadFlicks) {
      set({ agentPlayheadFlicks })
    },

    isInteracting: false,

    setInteracting(isInteracting) {
      set({ isInteracting })
    },

    agentQueuedCount: 0,

    bumpAgentQueued(delta) {
      set((state) => ({ agentQueuedCount: Math.max(0, state.agentQueuedCount + delta) }))
    },

    attributions: new Map(),

    flowReport: null,

    setFlowReport(flowReport) {
      set({ flowReport })
    },

    roughCut: null,

    applyRoughCut(ranges) {
      const { sequence } = get()
      if (stack === null || sequence === null || ranges.length === 0) return
      const baseSequence = sequence
      stack.beginGroup()
      for (const range of [...ranges].sort((a, b) => b.fromFlicks - a.fromFlicks)) {
        stack.apply((seq) => rippleDeleteRange(seq, range))
      }
      stack.endGroup()
      syncFromStack()
      const resultSequence = stack.current
      // Nothing actually deleted → no history entry to attribute or reject.
      if (resultSequence === baseSequence) return
      set({ roughCut: { baseSequence, resultSequence, ranges, cuts: cutPointsFor(ranges) } })
      recordAttribution(baseSequence, resultSequence, 'Rough Cut')
    },

    rejectRoughCutCut(index) {
      const { sequence, roughCut } = get()
      if (stack === null || roughCut === null) return
      // Only while the rough cut is the top of history: any later edit (or an
      // undo of the pass itself) replaced the sequence object, and popping the
      // stack here would eat that edit instead of the rough cut.
      if (sequence !== roughCut.resultSequence) return
      if (index < 0 || index >= roughCut.ranges.length) return
      stack.undo()
      const remaining = roughCut.ranges.filter((_, i) => i !== index)
      if (remaining.length === 0) {
        set({ roughCut: null })
        syncFromStack()
        return
      }
      stack.beginGroup()
      for (const range of [...remaining].sort((a, b) => b.fromFlicks - a.fromFlicks)) {
        stack.apply((seq) => rippleDeleteRange(seq, range))
      }
      stack.endGroup()
      syncFromStack()
      set({
        roughCut: {
          baseSequence: roughCut.baseSequence,
          resultSequence: stack.current,
          ranges: remaining,
          cuts: cutPointsFor(remaining)
        }
      })
    },

    clearRoughCut() {
      set({ roughCut: null })
    },

    setTimeRange(fromFlicks, toFlicks) {
      set((state) => ({
        selection:
          fromFlicks === null
            ? clearRange(state.selection)
            : setRange(state.selection, fromFlicks, toFlicks ?? fromFlicks)
      }))
    },

    deleteSelection(mode) {
      const { selection, sequence } = get()
      if (sequence === null) return
      const spineIds = selection.clipIds.filter((id) =>
        sequence.spine.some((item) => item.id === id)
      )
      if (spineIds.length === 0) return
      apply((seq) =>
        mode === 'ripple'
          ? rippleDelete(seq, { ids: spineIds })
          : liftDelete(seq, { ids: spineIds })
      )
    },

    moveClip(clipId, toIndex) {
      apply((seq) => move(seq, { clipId, toIndex }))
    },

    undo() {
      stack?.undo()
      syncFromStack()
    },

    redo() {
      stack?.redo()
      syncFromStack()
    },

    selectClip(id, additive) {
      set((state) => ({
        selection: additive
          ? toggleInSelection(state.selection, id)
          : selectOnly(state.selection, id)
      }))
    },

    clearSelection() {
      set({ selection: emptySelection() })
    },

    setPlayhead(flicks) {
      set({ playheadFlicks: Math.max(0, flicks) })
    },

    setZoom(pxPerSec) {
      set({ zoomPxPerSec: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSec)) })
    },

    zoomBy(factor) {
      get().setZoom(get().zoomPxPerSec * factor)
    },

    toggleSnapping() {
      set((state) => ({ snapping: !state.snapping }))
    },

    toggleSkimming() {
      set((state) => ({ skimming: !state.skimming }))
    }
  }
})

// The engine reflects playback into the store regardless of which view is mounted.
playbackEngine.onTime = (flicks) => useTimelineStore.getState().setPlayhead(flicks)
playbackEngine.onPlayState = (playing) => useTimelineStore.getState().setSequencePlaying(playing)
playbackEngine.setLoop(useTimelineStore.getState().loopPlayback)

/** Deterministic PRNG (mulberry32) so the undo-storm E2E is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Apply `count` randomized edit ops through the regular store commands (the
 * exact code paths the UI uses). Returns how many ops actually changed state.
 */
function applyRandomOps(count: number, seed: number, asset: Omit<SourceClip, 'fps'>): number {
  const random = mulberry32(seed)
  const store = useTimelineStore.getState
  let applied = 0
  for (let i = 0; i < count; i++) {
    const state = store()
    const sequence = state.sequence
    if (sequence === null) return applied
    const before = sequence
    const frame = flicksPerFrame(sequence.fps)
    const spineIds = sequence.spine.map((item) => item.id)
    const pickSpineId = (): string => spineIds[Math.floor(random() * spineIds.length)] ?? 'none'
    const total = sequenceDuration(sequence)
    const time = Math.floor(random() * (total + frame))
    const delta = Math.floor((random() - 0.5) * 120) * frame
    const source: SourceClip = {
      ...asset,
      mediaInFlicks: 0,
      durationFlicks: Math.max(frame, Math.floor((random() * asset.durationFlicks) / 4)),
      fps: null
    }
    const kind = Math.floor(random() * 10)
    if (kind === 0 || spineIds.length === 0) store().appendSource(source)
    else if (kind === 1) store().insertSourceAtPlayhead(source)
    else if (kind === 2) store().overwriteSourceAtPlayhead(source)
    else if (kind === 3) store().connectSourceAt(source, Math.min(time, Math.max(0, total - frame)))
    else if (kind === 4) store().bladeAt(pickSpineId(), time)
    else if (kind === 5) store().trimClip(pickSpineId(), random() < 0.5 ? 'head' : 'tail', delta)
    else if (kind === 6) store().rollEditPoint(Math.floor(random() * sequence.spine.length), delta)
    else if (kind === 7) store().slipClip(pickSpineId(), delta)
    else if (kind === 8)
      store().moveClip(pickSpineId(), Math.floor(random() * sequence.spine.length))
    else store().setPlayhead(time)
    if (store().sequence !== before) applied += 1
  }
  return applied
}

/** Test-only hooks (MAGNETIC_TEST builds): deep-equal state asserts + perf harness. */
export function installTimelineTestHooks(): void {
  const testWindow = window as unknown as Record<string, unknown>
  testWindow.__magneticState = () => {
    const {
      sequence,
      selection,
      playheadFlicks,
      zoomPxPerSec,
      snapping,
      skimming,
      tool,
      clipboard,
      silenceRanges,
      roughCut,
      pendingProposal,
      attributions,
      flowReport
    } = useTimelineStore.getState()
    return {
      sequence,
      selection,
      playheadFlicks,
      zoomPxPerSec,
      snapping,
      skimming,
      tool,
      clipboard,
      silenceRanges,
      roughCutCuts: roughCut?.cuts ?? null,
      proposalRanges: pendingProposal?.ranges ?? null,
      proposalChanges: pendingProposal?.changes ?? null,
      proposalLabel: pendingProposal?.label ?? null,
      attributions: [...attributions.entries()],
      flowScore: flowReport?.score ?? null,
      flowFlags: flowReport?.flags ?? null
    }
  }
  testWindow.__magneticTimeline = {
    buildPerfSequence(count: number, asset: Omit<SourceClip, 'fps'>) {
      const store = useTimelineStore.getState()
      for (let i = 0; i < count; i++) {
        store.appendSource({ ...asset, fps: null })
      }
      store.setZoom(8)
    },
    measureDraws: (n: number) => measureDraws(n),
    applyRandomOps,
    /** Set a clip's fx directly (smart-render E2E: flip eligibility off). */
    setClipFx(clipId: string, fx: ClipFx) {
      useTimelineStore.getState().setFx(clipId, fx)
    },
    /** Canvas-local view state (scrollX/minimap) — see view-probe.ts. */
    view: () => timelineView(),
    playback: {
      readPixels: (x: number, y: number, w: number, h: number) =>
        playbackEngine.readPixels(x, y, w, h),
      /** Seek the sequence playhead (captions E2E: park the playhead in silence). */
      seek: (flicks: number) => useTimelineStore.getState().setPlayhead(flicks),
      drift: () => playbackEngine.driftReport(),
      rms: () => playbackEngine.audioRms(),
      isPlaying: () => playbackEngine.isPlaying
    },
    undoTimes(count: number): number {
      const store = useTimelineStore.getState()
      let undone = 0
      for (let i = 0; i < count; i++) {
        const before = useTimelineStore.getState().sequence
        store.undo()
        if (useTimelineStore.getState().sequence !== before) undone += 1
      }
      return undone
    }
  }
}
