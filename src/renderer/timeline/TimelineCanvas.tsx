import {
  useCallback,
  useEffect,
  useRef,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent
} from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { sequenceDuration, spineIndexOf, spineStartOf } from '../../shared/timeline/model'
import { itemAtTime } from '../../shared/timeline/magnetic'
import { collectSnapPoints, snapTime } from '../../shared/timeline/snap'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore, type SourceClip } from '../state/timeline-store'
import { onMediaReady } from './media-cache'
import { registerDrawDriver } from './perf'
import {
  EDGE_HIT_PX,
  RULER_H,
  computeClipRects,
  drawTimeline,
  pxToFlicks,
  rowLayout,
  timeToX,
  xToTime,
  type ClipRect,
  type DragGhost,
  type RenderState
} from './render'

/** Snap tolerance for drags, in CSS px (converted to flicks at current zoom). */
const SNAP_TOLERANCE_PX = 9
/** Pointer must travel this far before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4

interface DragState {
  mode: 'move' | 'trim' | 'playhead'
  clipId: string
  startX: number
  started: boolean
  /** trim: original clip end time; move: pointer offset inside the clip. */
  origEndFlicks: number
  pendingDeltaFlicks: number
  pendingToIndex: number
}

export function TimelineCanvas(): ReactNode {
  const { snapshot, openedAssetId, openAsset, setSkimTarget } = useLibrary()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollXRef = useRef(0)
  const skimmerXRef = useRef<number | null>(null)
  const snapGuideXRef = useRef<number | null>(null)
  const ghostRef = useRef<DragGhost | null>(null)
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
    if (drag.mode === 'trim') {
      const desiredEnd = drag.origEndFlicks + pxToFlicks(state, x - drag.startX)
      let endFlicks = Math.max(0, desiredEnd)
      snapGuideXRef.current = null
      if (store.snapping) {
        const points = collectSnapPoints(sequence, store.playheadFlicks).filter(
          (p) => p.timeFlicks !== drag.origEndFlicks
        )
        const snapped = snapTime(endFlicks, points, pxToFlicks(state, SNAP_TOLERANCE_PX))
        endFlicks = snapped.timeFlicks
        if (snapped.snapped !== null) snapGuideXRef.current = timeToX(state, endFlicks)
      }
      drag.pendingDeltaFlicks = endFlicks - drag.origEndFlicks
      ghostRef.current = { kind: 'trim', x: timeToX(state, endFlicks), clipId: drag.clipId }
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

  const finishDrag = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    ghostRef.current = null
    snapGuideXRef.current = null
    const store = useTimelineStore.getState()
    if (drag !== null && drag.started) {
      if (drag.mode === 'trim' && drag.pendingDeltaFlicks !== 0) {
        store.trimClipTail(drag.clipId, drag.pendingDeltaFlicks)
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

  /** Window-level listeners keep the drag alive when the cursor leaves the canvas. */
  const beginDragCapture = (): void => {
    const onWindowMove = (event: MouseEvent): void => dragMove(event.clientX)
    const onWindowUp = (): void => {
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
      finishDrag()
    }
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
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
      store.setPlayhead(xToTime(state, x))
      dragRef.current = {
        mode: 'playhead',
        clipId: '',
        startX: x,
        started: true,
        origEndFlicks: 0,
        pendingDeltaFlicks: 0,
        pendingToIndex: -1
      }
      beginDragCapture()
      return
    }
    const hit = hitTest(state, x, y)
    if (hit === null) {
      store.clearSelection()
      scheduleDraw()
      return
    }
    store.selectClip(hit.id, event.shiftKey)
    const sequence = store.sequence
    if (sequence === null) return
    if (hit.kind === 'spine') {
      const isTrimEdge = x >= hit.x + hit.w - EDGE_HIT_PX
      const start = spineStartOf(sequence, hit.id) ?? 0
      const item = sequence.spine[spineIndexOf(sequence, hit.id)]
      dragRef.current = {
        mode: isTrimEdge ? 'trim' : 'move',
        clipId: hit.id,
        startX: x,
        started: false,
        origEndFlicks: start + item.durationFlicks,
        pendingDeltaFlicks: 0,
        pendingToIndex: -1
      }
      beginDragCapture()
    }
  }

  const onMouseMove = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (dragRef.current !== null) return // window listeners drive the drag
    const state = buildRenderState()
    if (state === null) return
    const { x, y } = localPoint(event)
    const store = useTimelineStore.getState()
    if (store.skimming && y > RULER_H) {
      skimmerXRef.current = x
      const sequence = state.sequence
      const timeFlicks = xToTime(state, x)
      const under = itemAtTime(sequence.spine, timeFlicks)
      if (under !== null && under.item.kind === 'clip') {
        const mediaFlicks = under.item.mediaInFlicks + (timeFlicks - under.startFlicks)
        if (openedAssetIdRef.current !== under.item.assetId) openAsset(under.item.assetId)
        setSkimTarget({ assetId: under.item.assetId, mediaFlicks })
      }
      scheduleDraw()
    } else if (skimmerXRef.current !== null) {
      skimmerXRef.current = null
      scheduleDraw()
    }
  }

  const onMouseLeave = (): void => {
    if (skimmerXRef.current !== null) {
      skimmerXRef.current = null
      setSkimTarget(null)
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
