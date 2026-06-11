import { FLICKS_PER_SECOND, flicksToTimecode } from '../../shared/timecode'
import type { Sequence } from '../../shared/timeline/model'
import { spineStartIndex } from '../../shared/timeline/magnetic'
import { editPointIndexOfCut, transitionsOf } from '../../shared/timeline/transitions'
import type { Selection } from '../../shared/timeline/select'
import type { LibrarySnapshot } from '../../shared/types'
import { peaksFor, stripImageFor } from './media-cache'

/**
 * Pure-ish canvas draw pass for the magnetic timeline. Produces hit rects as
 * a side product so pointer handling never reads pixels. Painted in layer
 * order: ruler, lanes, spine, clip bodies, selection, guides, skimmer,
 * playhead.
 */

export const RULER_H = 26
export const LANE_H = 32
export const SPINE_H = 48
export const GUTTER = 4
export const EDGE_HIT_PX = 7

export interface ClipRect {
  id: string
  kind: 'spine' | 'connected'
  x: number
  y: number
  w: number
  h: number
  label: string
  assetId: string | null
  mediaInFlicks: number
  durationFlicks: number
  isGap: boolean
}

export interface DragGhost {
  kind: 'move' | 'trim' | 'slip'
  /** Caret/edge x position in CSS px. */
  x: number
  clipId: string
  /** Frame-delta tooltip, e.g. "-12f". */
  label?: string
}

export interface HoverEdge {
  x: number
  y: number
  h: number
  edge: 'head' | 'tail' | 'point'
}

export interface SlipPreview {
  clipId: string
  deltaFlicks: number
}

export interface RenderState {
  sequence: Sequence
  selection: Selection
  snapshot: LibrarySnapshot | null
  playheadFlicks: number
  zoomPxPerSec: number
  scrollX: number
  skimmerX: number | null
  snapGuideX: number | null
  ghost: DragGhost | null
  hoverEdge: HoverEdge | null
  slipPreview: SlipPreview | null
  width: number
  height: number
}

export function timeToX(state: RenderState, flicks: number): number {
  return (flicks / FLICKS_PER_SECOND) * state.zoomPxPerSec - state.scrollX
}

export function xToTime(state: RenderState, x: number): number {
  return Math.max(0, Math.round(((x + state.scrollX) / state.zoomPxPerSec) * FLICKS_PER_SECOND))
}

export function pxToFlicks(state: RenderState, px: number): number {
  return Math.round((px / state.zoomPxPerSec) * FLICKS_PER_SECOND)
}

export interface RowLayout {
  videoLanes: number
  audioLanes: number
  spineY: number
  laneY(lane: number): number
  totalH: number
}

export function rowLayout(sequence: Sequence): RowLayout {
  let maxVideo = 1 // always reserve one upper lane as the connect drop zone
  let maxAudio = 0
  for (const cc of sequence.connected) {
    if (cc.lane > maxVideo) maxVideo = cc.lane
    if (-cc.lane > maxAudio) maxAudio = -cc.lane
  }
  const spineY = RULER_H + GUTTER + maxVideo * (LANE_H + GUTTER)
  const laneY = (lane: number): number =>
    lane > 0
      ? RULER_H + GUTTER + (maxVideo - lane) * (LANE_H + GUTTER)
      : spineY + SPINE_H + GUTTER + (-lane - 1) * (LANE_H + GUTTER)
  return {
    videoLanes: maxVideo,
    audioLanes: maxAudio,
    spineY,
    laneY,
    totalH: spineY + SPINE_H + GUTTER + maxAudio * (LANE_H + GUTTER)
  }
}

const COLORS = {
  bg: '#161618',
  rulerBg: '#1d1d20',
  rulerTick: '#5a5a60',
  rulerText: '#9a9aa2',
  laneBg: '#1a1a1d',
  spineBg: '#202024',
  videoClip: '#2f4f6f',
  audioClip: '#2f5f46',
  clipBorder: '#11111388',
  gapFill: '#222226',
  gapHatch: '#2e2e34',
  clipText: '#e8e8ee',
  selection: '#ffd60a',
  snapGuide: '#ffd60a',
  skimmer: '#ff453a',
  playhead: '#f2f2f4',
  waveform: '#9fe3bd'
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  // sub-pixel rects (1-frame clips at low zoom) must not produce a negative radius
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function pickTickSeconds(zoomPxPerSec: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
  for (const seconds of candidates) {
    if (seconds * zoomPxPerSec >= 70) return seconds
  }
  return 600
}

function drawRuler(ctx: CanvasRenderingContext2D, state: RenderState): void {
  ctx.fillStyle = COLORS.rulerBg
  ctx.fillRect(0, 0, state.width, RULER_H)
  const tickSeconds = pickTickSeconds(state.zoomPxPerSec)
  const tickFlicks = tickSeconds * FLICKS_PER_SECOND
  const firstTick = Math.floor(xToTime(state, 0) / tickFlicks) * tickFlicks
  ctx.strokeStyle = COLORS.rulerTick
  ctx.fillStyle = COLORS.rulerText
  ctx.font = '10px Consolas, monospace'
  ctx.textBaseline = 'top'
  for (let t = firstTick; ; t += tickFlicks) {
    const x = timeToX(state, t)
    if (x > state.width) break
    ctx.beginPath()
    ctx.moveTo(x + 0.5, RULER_H - 8)
    ctx.lineTo(x + 0.5, RULER_H)
    ctx.stroke()
    ctx.fillText(flicksToTimecode(t, state.sequence.fps), x + 3, 4)
  }
}

function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  state: RenderState,
  rect: ClipRect,
  assetId: string,
  mediaInFlicks: number
): void {
  const asset = state.snapshot?.assets[assetId]
  const strip = asset?.filmstrip
  if (asset === undefined || strip === undefined) return
  const image = stripImageFor(assetId, strip.url)
  if (image === null) return
  const drawH = rect.h
  const drawW = Math.max(8, strip.frameW * (drawH / strip.frameH))
  for (let x = rect.x; x < rect.x + rect.w; x += drawW) {
    const mediaFlicks = mediaInFlicks + pxToFlicks(state, x - rect.x)
    const frame = Math.max(
      0,
      Math.min(strip.frameCount - 1, Math.floor(mediaFlicks / strip.intervalFlicks))
    )
    ctx.drawImage(
      image,
      frame * strip.frameW,
      0,
      strip.frameW,
      strip.frameH,
      x,
      rect.y,
      drawW,
      drawH
    )
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  state: RenderState,
  rect: ClipRect,
  assetId: string,
  mediaInFlicks: number,
  durationFlicks: number
): void {
  const asset = state.snapshot?.assets[assetId]
  const waveform = asset?.waveform
  if (asset === undefined || waveform === undefined) return
  const data = peaksFor(assetId, waveform.url)
  if (data === null || data.buckets.length === 0) return
  const assetDuration = asset.durationFlicks
  const baseY = rect.y + rect.h * 0.78
  const amp = rect.h * 0.2
  ctx.strokeStyle = COLORS.waveform
  ctx.lineWidth = 1
  ctx.beginPath()
  const steps = Math.max(2, Math.floor(rect.w / 2))
  for (let i = 0; i <= steps; i++) {
    const mediaFlicks = mediaInFlicks + (durationFlicks * i) / steps
    const bucket =
      data.buckets[
        Math.max(
          0,
          Math.min(
            data.buckets.length - 1,
            Math.floor((mediaFlicks / assetDuration) * data.buckets.length)
          )
        )
      ]
    const y = baseY - Math.abs(bucket[1]) * amp
    const x = rect.x + (rect.w * i) / steps
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

function drawClipBody(
  ctx: CanvasRenderingContext2D,
  state: RenderState,
  rect: ClipRect,
  label: string,
  assetId: string | null,
  mediaInFlicks: number,
  durationFlicks: number,
  isGap: boolean
): void {
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 4)
  if (isGap) {
    ctx.fillStyle = COLORS.gapFill
    ctx.fill()
    ctx.save()
    ctx.clip()
    ctx.strokeStyle = COLORS.gapHatch
    ctx.lineWidth = 1
    for (let x = rect.x - rect.h; x < rect.x + rect.w; x += 8) {
      ctx.beginPath()
      ctx.moveTo(x, rect.y + rect.h)
      ctx.lineTo(x + rect.h, rect.y)
      ctx.stroke()
    }
    ctx.restore()
    return
  }
  const asset = assetId !== null ? state.snapshot?.assets[assetId] : undefined
  const isAudioOnly = asset !== undefined && asset.video === undefined
  ctx.fillStyle = isAudioOnly ? COLORS.audioClip : COLORS.videoClip
  ctx.fill()
  ctx.save()
  ctx.clip()
  if (assetId !== null && !isAudioOnly) drawFilmstrip(ctx, state, rect, assetId, mediaInFlicks)
  if (assetId !== null) drawWaveform(ctx, state, rect, assetId, mediaInFlicks, durationFlicks)
  ctx.fillStyle = COLORS.clipText
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.shadowColor = '#000000aa'
  ctx.shadowBlur = 3
  ctx.fillText(label, rect.x + 5, rect.y + 4, Math.max(10, rect.w - 10))
  ctx.restore()
  ctx.strokeStyle = COLORS.clipBorder
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawSelection(ctx: CanvasRenderingContext2D, rect: ClipRect): void {
  roundedRectPath(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 4)
  ctx.strokeStyle = COLORS.selection
  ctx.lineWidth = 2
  ctx.stroke()
}

/**
 * Geometry of every visible clip at the current zoom/scroll, derived straight
 * from the sequence. Hit-testing uses this directly so pointer handling can
 * never act on a stale frame.
 */
export function computeClipRects(state: RenderState): ClipRect[] {
  const rects: ClipRect[] = []
  const layout = rowLayout(state.sequence)
  const assetName = (assetId: string): string =>
    state.snapshot?.assets[assetId]?.fileName ?? assetId
  let position = 0
  for (const item of state.sequence.spine) {
    const x = timeToX(state, position)
    const w = (item.durationFlicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
    position += item.durationFlicks
    if (x + w < 0 || x > state.width) continue
    rects.push({
      id: item.id,
      kind: 'spine',
      x,
      y: layout.spineY,
      w,
      h: SPINE_H,
      label: item.kind === 'clip' ? assetName(item.assetId) : '',
      assetId: item.kind === 'clip' ? item.assetId : null,
      mediaInFlicks: item.kind === 'clip' ? item.mediaInFlicks : 0,
      durationFlicks: item.durationFlicks,
      isGap: item.kind === 'gap'
    })
  }
  const startOf = spineStartIndex(state.sequence.spine)
  for (const cc of state.sequence.connected) {
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) continue
    const start = parentStart + cc.offsetFlicks
    const x = timeToX(state, start)
    const w = (cc.durationFlicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
    if (x + w < 0 || x > state.width) continue
    rects.push({
      id: cc.id,
      kind: 'connected',
      x,
      y: layout.laneY(cc.lane),
      w,
      h: LANE_H,
      label: assetName(cc.assetId),
      assetId: cc.assetId,
      mediaInFlicks: cc.mediaInFlicks,
      durationFlicks: cc.durationFlicks,
      isGap: false
    })
  }
  return rects
}

export interface TransitionBadgeRect {
  transitionId: string
  x: number
  y: number
  w: number
  h: number
}

/** Badge rects spanning each transition's overlap window at its cut. */
export function transitionBadgeRects(state: RenderState): TransitionBadgeRect[] {
  const layout = rowLayout(state.sequence)
  const startOf = spineStartIndex(state.sequence.spine)
  const rects: TransitionBadgeRect[] = []
  for (const transition of transitionsOf(state.sequence)) {
    const index = editPointIndexOfCut(state.sequence, transition.afterClipId)
    if (index === -1) continue
    const left = state.sequence.spine[index]
    const cut = (startOf.get(left.id) ?? 0) + left.durationFlicks
    const half = transition.durationFlicks / 2
    const x = timeToX(state, cut - half)
    const w = Math.max(10, timeToX(state, cut + half) - x)
    rects.push({ transitionId: transition.id, x, y: layout.spineY + 2, w, h: 14 })
  }
  return rects
}

const KIND_LABEL: Record<string, string> = {
  dissolve: 'X',
  wipeL: 'W◀',
  wipeR: 'W▶',
  fadeBlack: 'F'
}

function drawTransitionBadges(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const badges = transitionBadgeRects(state)
  if (badges.length === 0) return
  const kinds = new Map(transitionsOf(state.sequence).map((t) => [t.id, t.kind]))
  for (const badge of badges) {
    roundedRectPath(ctx, badge.x, badge.y, badge.w, badge.h, 3)
    ctx.fillStyle = '#1d1d20dd'
    ctx.fill()
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = COLORS.selection
    ctx.font = '9px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText(
      KIND_LABEL[kinds.get(badge.transitionId) ?? 'dissolve'],
      badge.x + badge.w / 2,
      badge.y + badge.h / 2 + 1
    )
    ctx.textAlign = 'left'
  }
}

/** Full draw pass. Returns the hit rects of everything painted. */
export function drawTimeline(ctx: CanvasRenderingContext2D, state: RenderState): ClipRect[] {
  const layout = rowLayout(state.sequence)
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, state.width, state.height)

  // lane + spine backgrounds
  for (let lane = 1; lane <= layout.videoLanes; lane++) {
    ctx.fillStyle = COLORS.laneBg
    ctx.fillRect(0, layout.laneY(lane), state.width, LANE_H)
  }
  for (let lane = 1; lane <= layout.audioLanes; lane++) {
    ctx.fillStyle = COLORS.laneBg
    ctx.fillRect(0, layout.laneY(-lane), state.width, LANE_H)
  }
  ctx.fillStyle = COLORS.spineBg
  ctx.fillRect(0, layout.spineY, state.width, SPINE_H)

  const rects = computeClipRects(state)
  for (const rect of rects) {
    // live slip preview: shift the media window inside the clip rect
    const slipDelta =
      state.slipPreview !== null && state.slipPreview.clipId === rect.id
        ? state.slipPreview.deltaFlicks
        : 0
    drawClipBody(
      ctx,
      state,
      rect,
      rect.label,
      rect.assetId,
      rect.mediaInFlicks + slipDelta,
      rect.durationFlicks,
      rect.isGap
    )
  }

  // selection highlights
  for (const rect of rects) {
    if (state.selection.clipIds.includes(rect.id)) drawSelection(ctx, rect)
  }

  drawTransitionBadges(ctx, state)

  // hovered trim edge / edit point: yellow bracket affordance
  if (state.hoverEdge !== null && state.ghost === null) {
    const { x, y, h, edge } = state.hoverEdge
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = 2
    ctx.beginPath()
    if (edge === 'point') {
      ctx.moveTo(x + 0.5, y)
      ctx.lineTo(x + 0.5, y + h)
    } else {
      const lip = edge === 'head' ? 5 : -5
      ctx.moveTo(x + lip, y + 2)
      ctx.lineTo(x, y + 2)
      ctx.lineTo(x, y + h - 2)
      ctx.lineTo(x + lip, y + h - 2)
    }
    ctx.stroke()
  }

  // drag ghost: insertion caret (move), edge preview (trim/roll), or slip tooltip
  if (state.ghost !== null) {
    if (state.ghost.kind !== 'slip') {
      ctx.strokeStyle = COLORS.selection
      ctx.lineWidth = 2
      ctx.setLineDash(state.ghost.kind === 'move' ? [] : [4, 3])
      ctx.beginPath()
      ctx.moveTo(state.ghost.x + 0.5, layout.spineY - 4)
      ctx.lineTo(state.ghost.x + 0.5, layout.spineY + SPINE_H + 4)
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (state.ghost.label !== undefined) {
      ctx.font = '11px Consolas, monospace'
      const paddedWidth = ctx.measureText(state.ghost.label).width + 10
      const labelX = Math.min(Math.max(state.ghost.x + 8, 2), state.width - paddedWidth - 2)
      const labelY = layout.spineY - 22
      ctx.fillStyle = '#000000cc'
      ctx.fillRect(labelX, labelY, paddedWidth, 16)
      ctx.fillStyle = COLORS.selection
      ctx.textBaseline = 'top'
      ctx.fillText(state.ghost.label, labelX + 5, labelY + 3)
    }
  }

  // snapping guide
  if (state.snapGuideX !== null) {
    ctx.strokeStyle = COLORS.snapGuide
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(state.snapGuideX + 0.5, RULER_H)
    ctx.lineTo(state.snapGuideX + 0.5, state.height)
    ctx.stroke()
  }

  drawRuler(ctx, state)

  // skimmer
  if (state.skimmerX !== null) {
    ctx.strokeStyle = COLORS.skimmer
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(state.skimmerX + 0.5, RULER_H)
    ctx.lineTo(state.skimmerX + 0.5, state.height)
    ctx.stroke()
  }

  // playhead across all lanes, with a triangle handle in the ruler
  const playheadX = timeToX(state, state.playheadFlicks)
  if (playheadX >= -8 && playheadX <= state.width + 8) {
    ctx.strokeStyle = COLORS.playhead
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(playheadX, RULER_H - 6)
    ctx.lineTo(playheadX, state.height)
    ctx.stroke()
    ctx.fillStyle = COLORS.playhead
    ctx.beginPath()
    ctx.moveTo(playheadX - 6, RULER_H - 14)
    ctx.lineTo(playheadX + 6, RULER_H - 14)
    ctx.lineTo(playheadX, RULER_H - 4)
    ctx.closePath()
    ctx.fill()
  }

  return rects
}
