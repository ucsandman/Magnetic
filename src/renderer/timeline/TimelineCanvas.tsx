import {
  useCallback,
  useEffect,
  useRef,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent
} from 'react'
import { FLICKS_PER_SECOND, flicksPerFrame } from '../../shared/timecode'
import { sequenceDuration, spineIndexOf } from '../../shared/timeline/model'
import { itemAtTime } from '../../shared/timeline/magnetic'
import { collectSnapPoints, snapTime } from '../../shared/timeline/snap'
import { playbackEngine } from '../playback/engine'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore, type SourceClip } from '../state/timeline-store'
import { onMediaReady } from './media-cache'
import { registerDrawDriver } from './perf'
import {
  EDGE_HIT_PX,
  RULER_H,
  SPINE_H,
  computeClipRects,
  drawTimeline,
  pxToFlicks,
  rowLayout,
  timeToX,
  xToTime,
  type ClipRect,
  type DragGhost,
  type HoverEdge,
  type RenderState,
  type SlipPreview
} from './render'

/** Snap tolerance for drags, in CSS px (converted to flicks at current zoom). */
const SNAP_TOLERANCE_PX = 9
/** Pointer must travel this far before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4

interface DragState {
  mode: 'move' | 'trim' | 'roll' | 'slip' | 'playhead'
  clipId: string
  /** trim: which clip edge is being dragged. */
  edge: 'head' | 'tail'
  /** roll: index of the edit point (left clip's spine index). */
  editPointIndex: number
  startX: number
  started: boolean
  /** trim/roll: original boundary position being dragged, in flicks. */
  origBoundaryFlicks: number
  pendingDeltaFlicks: number
  pendingToIndex: number
}

/** What the pointer is over inside the spine row. */
type SpineZone =
  | { type: 'edit-point'; editPointIndex: number; boundaryFlicks: number; x: number }
  | { type: 'edge'; clipId: string; edge: 'head' | 'tail'; boundaryFlicks: number; x: number }
  | { type: 'body'; clipId: string; isGap: boolean }
  | null

export function TimelineCanvas(): ReactNode {
  const { snapshot, openedAssetId } = useLibrary()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stillBusyRef = useRef(false)
  const scrollXRef = useRef(0)
  const skimmerXRef = useRef<number | null>(null)
  const snapGuideXRef = useRef<number | null>(null)
  const ghostRef = useRef<DragGhost | null>(null)
  const hoverEdgeRef = useRef<HoverEdge | null>(null)
  const slipPreviewRef = useRef<SlipPreview | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const rafRef = useRef<number | null>(null)
  const snapshotRef = useRef(snapshot)
  const openedAssetIdRef = useRef(openedAssetId)
  useEffect(() => {
    snapshotRef.current = snapshot
    openedAssetIdRef.current = openedAssetId
  }, [snapshot, openedAssetId])

  const buildRenderState = useCallback((): RenderState | null => {
    const { sequence, selection, playheadFlicks, zoomPxPerSec } = useTimelineStore.getState()
    const canvas = canvasRef.current
    if (sequence === null || canvas === null) return null
    return {
      sequence,
      selection,
      snapshot: snapshotRef.current,
      playheadFlicks,
      zoomPxPerSec,
      scrollX: scrollXRef.current,
      skimmerX: skimmerXRef.current,
      snapGuideX: snapGuideXRef.current,
      ghost: ghostRef.current,
      hoverEdge: hoverEdgeRef.current,
      slipPreview: slipPreviewRef.current,
      width: canvas.clientWidth,
      height: canvas.clientHeight
    }
  }, [])

  /** Synchronous full draw; returns ms spent (perf harness uses this). */
  const drawNow = useCallback((): number => {
    const canvas = canvasRef.current
    const state = buildRenderState()
    if (canvas === null || state === null) return 0
    const dpr = window.devicePixelRatio || 1
    const widthPx = Math.round(state.width * dpr)
    const heightPx = Math.round(state.height * dpr)
    if (canvas.width !== widthPx || canvas.height !== heightPx) {
      canvas.width = widthPx
      canvas.height = heightPx
    }
    const ctx = canvas.getContext('2d')
    if (ctx === null) return 0
    const started = performance.now()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawTimeline(ctx, state)
    return performance.now() - started
  }, [buildRenderState])

  /** rAF-coalesced redraw: many state changes per frame still draw once. */
  const scheduleDraw = useCallback((): void => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      drawNow()
    })
  }, [drawNow])

  useEffect(() => {
    const unsubscribe = useTimelineStore.subscribe(() => scheduleDraw())
    onMediaReady(() => scheduleDraw())
    const observer = new ResizeObserver(() => scheduleDraw())
    if (containerRef.current !== null) observer.observe(containerRef.current)
    scheduleDraw()
    return () => {
      unsubscribe()
      observer.disconnect()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [scheduleDraw])

  // redraw when the library snapshot brings filmstrips/waveforms online
  useEffect(() => {
    scheduleDraw()
  }, [snapshot, scheduleDraw])

  // perf harness driver (test builds call measureDraws via __magneticTimeline)
  useEffect(() => {
    registerDrawDriver(async (n: number) => {
      const times: number[] = []
      for (let i = 0; i < n; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        times.push(drawNow())
      }
      return times
    })
    return () => registerDrawDriver(null)
  }, [drawNow])

  const hitTest = (state: RenderState, x: number, y: number): ClipRect | null => {
    // fresh geometry from current state — never stale; back-to-front (connected on top)
    const rects = computeClipRects(state)
    for (let i = rects.length - 1; i >= 0; i--) {
      const rect = rects[i]
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return rect
    }
    return null
  }

  const localPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const bounds = canvasRef.current!.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const framesLabel = (deltaFlicks: number): string => {
    const sequence = useTimelineStore.getState().sequence
    if (sequence === null) return ''
    const frames = Math.round(deltaFlicks / flicksPerFrame(sequence.fps))
    return `${frames >= 0 ? '+' : ''}${frames}f`
  }

  /** Drag progression, fed by window-level mousemove while a drag is active. */
  const dragMove = (clientX: number): void => {
    const drag = dragRef.current
    const state = buildRenderState()
    if (drag === null || state === null) return
    const store = useTimelineStore.getState()
    const x = clientX - canvasRef.current!.getBoundingClientRect().left
    if (drag.mode === 'playhead') {
      store.setPlayhead(xToTime(state, x))
      return
    }
    if (!drag.started && Math.abs(x - drag.startX) < DRAG_THRESHOLD_PX) return
    drag.started = true
    const sequence = state.sequence
    if (drag.mode === 'trim' || drag.mode === 'roll') {
      const desiredBoundary = drag.origBoundaryFlicks + pxToFlicks(state, x - drag.startX)
      let boundaryFlicks = Math.max(0, desiredBoundary)
      snapGuideXRef.current = null
      if (store.snapping) {
        const points = collectSnapPoints(sequence, store.playheadFlicks).filter(
          (p) => p.timeFlicks !== drag.origBoundaryFlicks
        )
        const snapped = snapTime(boundaryFlicks, points, pxToFlicks(state, SNAP_TOLERANCE_PX))
        boundaryFlicks = snapped.timeFlicks
        if (snapped.snapped !== null) snapGuideXRef.current = timeToX(state, boundaryFlicks)
      }
      drag.pendingDeltaFlicks = boundaryFlicks - drag.origBoundaryFlicks
      ghostRef.current = {
        kind: 'trim',
        x: timeToX(state, boundaryFlicks),
        clipId: drag.clipId,
        label: framesLabel(drag.pendingDeltaFlicks)
      }
    } else if (drag.mode === 'slip') {
      // dragging right reveals earlier media (FCP slip direction)
      const delta = -pxToFlicks(state, x - drag.startX)
      const item = sequence.spine.find((candidate) => candidate.id === drag.clipId)
      if (item === undefined || item.kind !== 'clip') return
      const clamped =
        Math.min(
          Math.max(item.mediaInFlicks + delta, 0),
          item.sourceDurationFlicks - item.durationFlicks
        ) - item.mediaInFlicks
      drag.pendingDeltaFlicks = clamped
      slipPreviewRef.current = { clipId: drag.clipId, deltaFlicks: clamped }
      ghostRef.current = { kind: 'slip', x, clipId: drag.clipId, label: framesLabel(clamped) }
    } else {
      // move: caret at the nearest spine boundary to the cursor time
      const cursorFlicks = xToTime(state, x)
      let boundary = 0
      let index = 0
      let bestDistance = Infinity
      let bestBoundary = 0
      let bestIndex = 0
      for (const item of sequence.spine) {
        const distance = Math.abs(cursorFlicks - boundary)
        if (distance < bestDistance) {
          bestDistance = distance
          bestBoundary = boundary
          bestIndex = index
        }
        boundary += item.durationFlicks
        index += 1
      }
      if (Math.abs(cursorFlicks - boundary) < bestDistance) {
        bestBoundary = boundary
        bestIndex = index
      }
      drag.pendingToIndex = bestIndex
      ghostRef.current = { kind: 'move', x: timeToX(state, bestBoundary), clipId: drag.clipId }
    }
    scheduleDraw()
  }

  const clearDragOverlays = (): void => {
    dragRef.current = null
    ghostRef.current = null
    snapGuideXRef.current = null
    slipPreviewRef.current = null
  }

  const finishDrag = (): void => {
    const drag = dragRef.current
    clearDragOverlays()
    const store = useTimelineStore.getState()
    if (drag !== null && drag.started) {
      if (drag.mode === 'trim' && drag.pendingDeltaFlicks !== 0) {
        store.trimClip(drag.clipId, drag.edge, drag.pendingDeltaFlicks)
      } else if (drag.mode === 'roll' && drag.pendingDeltaFlicks !== 0) {
        store.rollEditPoint(drag.editPointIndex, drag.pendingDeltaFlicks)
      } else if (drag.mode === 'slip' && drag.pendingDeltaFlicks !== 0) {
        store.slipClip(drag.clipId, drag.pendingDeltaFlicks)
      } else if (drag.mode === 'move' && drag.pendingToIndex >= 0) {
        const sequence = store.sequence
        if (sequence !== null) {
          const from = spineIndexOf(sequence, drag.clipId)
          // boundary index → target index after removal
          const toIndex = drag.pendingToIndex > from ? drag.pendingToIndex - 1 : drag.pendingToIndex
          store.moveClip(drag.clipId, toIndex)
        }
      }
    }
    scheduleDraw()
  }

  /**
   * Window-level listeners keep the drag alive when the cursor leaves the
   * canvas; Escape cancels without committing (kernel untouched until mouseup).
   */
  const beginDragCapture = (): void => {
    const cleanup = (): void => {
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
      window.removeEventListener('keydown', onWindowKey, true)
    }
    const onWindowMove = (event: MouseEvent): void => dragMove(event.clientX)
    const onWindowUp = (): void => {
      cleanup()
      finishDrag()
    }
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      cleanup()
      clearDragOverlays()
      scheduleDraw()
    }
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
    window.addEventListener('keydown', onWindowKey, true)
  }

  /** Classify what the pointer is over inside the spine row. */
  const detectSpineZone = (state: RenderState, x: number, y: number): SpineZone => {
    const layout = rowLayout(state.sequence)
    if (y < layout.spineY || y > layout.spineY + SPINE_H) return null
    const spine = state.sequence.spine
    let position = 0
    for (let i = 0; i < spine.length; i++) {
      const item = spine[i]
      const startX = timeToX(state, position)
      const end = position + item.durationFlicks
      const endX = timeToX(state, end)
      if (x >= startX && x <= endX) {
        const nearHead = x - startX <= EDGE_HIT_PX
        const nearTail = endX - x <= EDGE_HIT_PX
        if (nearHead && i > 0) {
          return { type: 'edit-point', editPointIndex: i - 1, boundaryFlicks: position, x: startX }
        }
        if (nearTail && i < spine.length - 1) {
          return { type: 'edit-point', editPointIndex: i, boundaryFlicks: end, x: endX }
        }
        if (nearHead) {
          return {
            type: 'edge',
            clipId: item.id,
            edge: 'head',
            boundaryFlicks: position,
            x: startX
          }
        }
        if (nearTail) {
          return { type: 'edge', clipId: item.id, edge: 'tail', boundaryFlicks: end, x: endX }
        }
        return { type: 'body', clipId: item.id, isGap: item.kind === 'gap' }
      }
      position = end
    }
    return null
  }

  const startDrag = (
    drag: Omit<DragState, 'started' | 'pendingDeltaFlicks' | 'pendingToIndex'>
  ): void => {
    dragRef.current = { ...drag, started: false, pendingDeltaFlicks: 0, pendingToIndex: -1 }
    beginDragCapture()
  }

  // Mouse events, not pointer events: Electron does not deliver synthetic
  // pointermove for programmatic input, and mice are the only target device.
  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    containerRef.current?.focus()
    const store = useTimelineStore.getState()
    const state = buildRenderState()
    if (state === null) return
    const { x, y } = localPoint(event)
    if (y <= RULER_H) {
      store.setViewerMode('sequence') // scrubbing shows the sequence frame
      store.setPlayhead(xToTime(state, x))
      dragRef.current = {
        mode: 'playhead',
        clipId: '',
        edge: 'tail',
        editPointIndex: -1,
        startX: x,
        started: true,
        origBoundaryFlicks: 0,
        pendingDeltaFlicks: 0,
        pendingToIndex: -1
      }
      beginDragCapture()
      return
    }
    const sequence = state.sequence
    const tool = store.tool
    const zone = detectSpineZone(state, x, y)

    if (tool === 'blade') {
      if (
        zone !== null &&
        (zone.type === 'body' || zone.type === 'edge') &&
        !('isGap' in zone && zone.isGap)
      ) {
        const frame = flicksPerFrame(sequence.fps)
        const clipId = zone.type === 'body' ? zone.clipId : zone.clipId
        store.bladeAt(clipId, Math.round(xToTime(state, x) / frame) * frame)
      }
      return
    }

    if (zone === null) {
      const hit = hitTest(state, x, y)
      if (hit === null) {
        store.clearSelection()
      } else {
        store.selectClip(hit.id, event.shiftKey)
      }
      scheduleDraw()
      return
    }

    if (zone.type === 'edit-point') {
      if (tool === 'trim') {
        store.selectClip(sequence.spine[zone.editPointIndex].id, false)
        startDrag({
          mode: 'roll',
          clipId: '',
          edge: 'tail',
          editPointIndex: zone.editPointIndex,
          startX: x,
          origBoundaryFlicks: zone.boundaryFlicks
        })
        return
      }
      // select tool at an interior boundary: grab the nearer side's edge
      const pickTail = x <= zone.x
      const clip = sequence.spine[pickTail ? zone.editPointIndex : zone.editPointIndex + 1]
      store.selectClip(clip.id, event.shiftKey)
      startDrag({
        mode: 'trim',
        clipId: clip.id,
        edge: pickTail ? 'tail' : 'head',
        editPointIndex: -1,
        startX: x,
        origBoundaryFlicks: zone.boundaryFlicks
      })
      return
    }

    if (zone.type === 'edge') {
      store.selectClip(zone.clipId, event.shiftKey)
      startDrag({
        mode: 'trim',
        clipId: zone.clipId,
        edge: zone.edge,
        editPointIndex: -1,
        startX: x,
        origBoundaryFlicks: zone.boundaryFlicks
      })
      return
    }

    store.selectClip(zone.clipId, event.shiftKey)
    if (zone.isGap) {
      scheduleDraw()
      return
    }
    startDrag({
      mode: tool === 'trim' || event.altKey ? 'slip' : 'move',
      clipId: zone.clipId,
      edge: 'tail',
      editPointIndex: -1,
      startX: x,
      origBoundaryFlicks: 0
    })
  }

  const onMouseMove = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (dragRef.current !== null) return // window listeners drive the drag
    const state = buildRenderState()
    if (state === null) return
    const { x, y } = localPoint(event)
    const store = useTimelineStore.getState()

    // hover affordances: cursor + edge bracket, per tool and zone
    const tool = store.tool
    let cursor = tool === 'blade' ? 'crosshair' : 'default'
    const previousHover = hoverEdgeRef.current
    hoverEdgeRef.current = null
    if (tool !== 'blade') {
      const zone = detectSpineZone(state, x, y)
      if (zone !== null) {
        const layout = rowLayout(state.sequence)
        if (zone.type === 'edit-point') {
          cursor = 'col-resize'
          hoverEdgeRef.current = {
            x: zone.x,
            y: layout.spineY,
            h: SPINE_H,
            edge: tool === 'trim' ? 'point' : x <= zone.x ? 'tail' : 'head'
          }
        } else if (zone.type === 'edge') {
          cursor = 'col-resize'
          hoverEdgeRef.current = { x: zone.x, y: layout.spineY, h: SPINE_H, edge: zone.edge }
        } else if (!zone.isGap) {
          cursor = tool === 'trim' ? 'ew-resize' : 'grab'
        }
      }
    }
    if (containerRef.current !== null) containerRef.current.style.cursor = cursor
    if (previousHover !== null || hoverEdgeRef.current !== null) scheduleDraw()

    if (store.skimming && y > RULER_H) {
      skimmerXRef.current = x
      const timeFlicks = xToTime(state, x)
      // sequence-mode still preview of the frame under the skimmer
      if (!playbackEngine.isPlaying && itemAtTime(state.sequence.spine, timeFlicks) !== null) {
        store.setViewerMode('sequence')
        scheduleStill(timeFlicks)
      }
      scheduleDraw()
    } else if (skimmerXRef.current !== null) {
      skimmerXRef.current = null
      scheduleDraw()
    }
  }

  /** Busy-drop throttle: never queue more than one still decode at a time. */
  const scheduleStill = (timeFlicks: number): void => {
    if (stillBusyRef.current) return
    const sequence = useTimelineStore.getState().sequence
    const snapshot = snapshotRef.current
    if (sequence === null || snapshot === null) return
    stillBusyRef.current = true
    void playbackEngine.renderStill(sequence, snapshot, timeFlicks).finally(() => {
      stillBusyRef.current = false
    })
  }

  const onMouseLeave = (): void => {
    if (skimmerXRef.current !== null) {
      skimmerXRef.current = null
      scheduleDraw()
    }
  }

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const store = useTimelineStore.getState()
    if (event.ctrlKey) {
      const state = buildRenderState()
      if (state === null) return
      const { x } = localPoint(event)
      const anchorFlicks = xToTime(state, x)
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
      store.zoomBy(factor)
      // keep the time under the cursor stationary
      const zoom = useTimelineStore.getState().zoomPxPerSec
      scrollXRef.current = Math.max(0, (anchorFlicks / FLICKS_PER_SECOND) * zoom - x)
    } else {
      scrollXRef.current = Math.max(
        0,
        scrollXRef.current + (event.deltaX !== 0 ? event.deltaX : event.deltaY)
      )
    }
    scheduleDraw()
  }

  const sourceFromAsset = (assetId: string): SourceClip | null => {
    const asset = snapshotRef.current?.assets[assetId]
    if (asset === undefined) return null
    return {
      assetId: asset.id,
      mediaInFlicks: 0,
      durationFlicks: asset.durationFlicks,
      sourceDurationFlicks: asset.durationFlicks,
      fps: asset.video?.fps ?? null
    }
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.types.includes('application/x-magnetic-asset')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const assetId = event.dataTransfer.getData('application/x-magnetic-asset')
    if (assetId === '') return
    event.preventDefault()
    const source = sourceFromAsset(assetId)
    if (source === null) return
    const state = buildRenderState()
    const store = useTimelineStore.getState()
    if (state === null) return
    const { x, y } = localPoint(event)
    // upper-lane drop = anywhere above the spine row → connect; otherwise append
    if (y < rowLayout(state.sequence).spineY && sequenceDuration(state.sequence) > 0) {
      store.connectSourceAt(source, xToTime(state, x))
    } else {
      store.appendSource(source)
    }
  }

  return (
    <div
      ref={containerRef}
      className="timeline-canvas-host"
      data-testid="timeline-canvas"
      tabIndex={0}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <canvas ref={canvasRef} className="timeline-canvas" />
    </div>
  )
}
