import { create } from 'zustand'
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../shared/timecode'
import { clipAtTime, sequenceDuration, type Sequence } from '../../shared/timeline/model'
import {
  addTransition,
  append,
  blade,
  connectAt,
  insertAt,
  liftDelete,
  move,
  overwriteAt,
  rippleDelete,
  roll,
  setClipFx,
  setTitleData,
  setTransitionKind,
  slip,
  trimRipple,
  type ClipInput,
  type OpResult
} from '../../shared/timeline/ops'
import type { ClipFx, TitleData, TransitionKind } from '../../shared/timeline/model'
import { transitionsOf } from '../../shared/timeline/transitions'
import { TITLE_PRESETS } from '../titles/render'
import {
  emptySelection,
  pruneSelection,
  selectOnly,
  toggleInSelection,
  type Selection
} from '../../shared/timeline/select'
import { UndoStack, type Op } from '../../shared/timeline/undo'
import { playbackEngine } from '../playback/engine'
import { measureDraws } from '../timeline/perf'

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
  setFx(clipId: string, fx: ClipFx): void
  setTitle(clipId: string, titleData: TitleData): void
  /** Default 1 s dissolve at the edit point nearest the playhead (Ctrl+T). */
  addTransitionAtPlayhead(): void
  cycleTransitionKind(transitionId: string): void
  /** Connect a title preset at the playhead on the lane above the spine. */
  connectTitleAtPlayhead(preset: TitleData['preset']): void
  load(): Promise<void>
  applyOp(op: Op): OpResult | null
  bladeAt(clipId: string, timeFlicks: number): void
  /** Blade every selected spine clip (or the clip under the playhead) at the playhead. */
  bladeAtPlayhead(): void
  rollEditPoint(editPointIndex: number, deltaFlicks: number): void
  slipClip(clipId: string, deltaFlicks: number): void
  trimClip(clipId: string, edge: 'head' | 'tail', deltaFlicks: number): void
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

    setTool(tool) {
      set({ tool })
    },

    setViewerMode(viewerMode) {
      set({ viewerMode })
    },

    setSequencePlaying(isSequencePlaying) {
      set({ isSequencePlaying })
    },

    setFx(clipId, fx) {
      apply((seq) => setClipFx(seq, { clipId, fx }))
    },

    setTitle(clipId, titleData) {
      apply((seq) => setTitleData(seq, { clipId, titleData }))
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

    async load() {
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
    const { sequence, selection, playheadFlicks, zoomPxPerSec, snapping, skimming, tool } =
      useTimelineStore.getState()
    return { sequence, selection, playheadFlicks, zoomPxPerSec, snapping, skimming, tool }
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
    playback: {
      readPixels: (x: number, y: number, w: number, h: number) =>
        playbackEngine.readPixels(x, y, w, h),
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
