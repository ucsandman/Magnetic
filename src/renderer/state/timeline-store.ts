import { create } from 'zustand'
import type { Rational } from '../../shared/timecode'
import type { Sequence } from '../../shared/timeline/model'
import {
  append,
  connectAt,
  insertAt,
  liftDelete,
  move,
  overwriteAt,
  rippleDelete,
  trimRipple,
  type ClipInput,
  type OpResult
} from '../../shared/timeline/ops'
import {
  emptySelection,
  pruneSelection,
  selectOnly,
  toggleInSelection,
  type Selection
} from '../../shared/timeline/select'
import { UndoStack, type Op } from '../../shared/timeline/undo'
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

interface TimelineStore {
  projectId: string | null
  sequence: Sequence | null
  selection: Selection
  playheadFlicks: number
  zoomPxPerSec: number
  snapping: boolean
  skimming: boolean
  load(): Promise<void>
  applyOp(op: Op): OpResult | null
  appendSource(src: SourceClip): void
  insertSourceAtPlayhead(src: SourceClip): void
  overwriteSourceAtPlayhead(src: SourceClip): void
  connectSourceAtPlayhead(src: SourceClip): void
  connectSourceAt(src: SourceClip, timeFlicks: number): void
  deleteSelection(mode: 'ripple' | 'lift'): void
  moveClip(clipId: string, toIndex: number): void
  trimClipTail(clipId: string, deltaFlicks: number): void
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

    trimClipTail(clipId, deltaFlicks) {
      apply((seq) => trimRipple(seq, { clipId, edge: 'tail', deltaFlicks }))
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

/** Test-only hooks (MAGNETIC_TEST builds): deep-equal state asserts + perf harness. */
export function installTimelineTestHooks(): void {
  const testWindow = window as unknown as Record<string, unknown>
  testWindow.__magneticState = () => {
    const { sequence, selection, playheadFlicks, zoomPxPerSec, snapping, skimming } =
      useTimelineStore.getState()
    return { sequence, selection, playheadFlicks, zoomPxPerSec, snapping, skimming }
  }
  testWindow.__magneticTimeline = {
    buildPerfSequence(count: number, asset: Omit<SourceClip, 'fps'>) {
      const store = useTimelineStore.getState()
      for (let i = 0; i < count; i++) {
        store.appendSource({ ...asset, fps: null })
      }
      store.setZoom(8)
    },
    measureDraws: (n: number) => measureDraws(n)
  }
}
