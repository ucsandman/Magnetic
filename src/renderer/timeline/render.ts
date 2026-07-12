import { FLICKS_PER_SECOND, flicksToTimecode } from '../../shared/timecode'
import { sequenceDuration, type Sequence } from '../../shared/timeline/model'
import { MINIMAP_H, minimapLayout } from './minimap'
import { keyframeMarkerTimes } from '../../shared/timeline/fx-eval'
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
  /** Source duration of a LOOPED connected clip — drives the seam tick marks. */
  loopSourceFlicks?: number
}

export interface DragGhost {
  kind: 'move' | 'trim' | 'slip'
  /** Caret/edge x position in CSS px. */
  x: number
  clipId: string
  /** Frame-delta tooltip, e.g. "-12f". */
  label?: string
  /** Caret vertical extent; defaults to the spine row (connected trims pass their lane). */
  y?: number
  h?: number
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
  /** Candidate dead-air ranges previewed as translucent bands (SilencePanel). */
  silenceRanges: { fromFlicks: number; toFlicks: number }[] | null
  /** Applied rough-cut edit points — AI provenance badges under the ruler. */
  roughCutCuts: { flicks: number }[] | null
  /**
   * Pending ghost-diff proposal: to-be-deleted ranges hatched over the real
   * clips (base time), and the proposed result as a green ghost strip above
   * the minimap zone (proposed time, same scale — clips visibly shift left).
   */
  proposal: {
    deletions: { fromFlicks: number; toFlicks: number }[]
    ghostClips: { fromFlicks: number; toFlicks: number }[]
  } | null
  /** Where the copilot last touched the timeline (marker in the ruler). */
  agentPlayheadFlicks: number | null
  /** Clips an accepted AI pass touched this session (corner provenance dot). */
  attributedClipIds: ReadonlySet<string> | null
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
  waveform: '#9fe3bd',
  keyframe: '#e8e8ee'
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
    const rect: ClipRect = {
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
    }
    if (cc.loop === true) rect.loopSourceFlicks = cc.sourceDurationFlicks
    rects.push(rect)
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

/** Clips narrower than this skip keyframe markers (cheap hot-path guard). */
const KF_MIN_CLIP_PX = 20
const KF_DIAMOND_R = 3

/** Keyframe media-times per animated clip; null when nothing is keyframed. */
function keyframeTimesByClip(sequence: Sequence): Map<string, number[]> | null {
  let map: Map<string, number[]> | null = null
  for (const item of sequence.spine) {
    if (item.kind !== 'clip') continue
    const times = keyframeMarkerTimes(item.fx)
    if (times.length > 0) (map ??= new Map()).set(item.id, times)
  }
  for (const cc of sequence.connected) {
    const times = keyframeMarkerTimes(cc.fx)
    if (times.length > 0) (map ??= new Map()).set(cc.id, times)
  }
  return map
}

/** Small diamonds along the bottom edge of keyframed clips (display-only in v1). */
function drawKeyframeDiamonds(
  ctx: CanvasRenderingContext2D,
  state: RenderState,
  rects: ClipRect[]
): void {
  const byClip = keyframeTimesByClip(state.sequence)
  if (byClip === null) return
  ctx.fillStyle = COLORS.keyframe
  ctx.strokeStyle = COLORS.clipBorder
  ctx.lineWidth = 1
  for (const rect of rects) {
    if (rect.isGap || rect.w < KF_MIN_CLIP_PX) continue
    const times = byClip.get(rect.id)
    if (times === undefined) continue
    const y = rect.y + rect.h - KF_DIAMOND_R - 2
    for (const at of times) {
      const x = rect.x + ((at - rect.mediaInFlicks) / FLICKS_PER_SECOND) * state.zoomPxPerSec
      if (x < rect.x + KF_DIAMOND_R || x > rect.x + rect.w - KF_DIAMOND_R) continue
      ctx.beginPath()
      ctx.moveTo(x, y - KF_DIAMOND_R)
      ctx.lineTo(x + KF_DIAMOND_R, y)
      ctx.lineTo(x, y + KF_DIAMOND_R)
      ctx.lineTo(x - KF_DIAMOND_R, y)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
  }
}

/** Clips narrower than this skip loop seam ticks (same guard as keyframes). */
const LOOP_TICK_MIN_CLIP_PX = 20
const LOOP_TICK_H = 6

/**
 * Small tick at every loop seam of a looped clip: the media wraps where one
 * source iteration ends and the next begins (first seam at source − mediaIn,
 * then every source length — mirrors pushLoopIterations in audio-graph.ts).
 */
function drawLoopSeams(ctx: CanvasRenderingContext2D, state: RenderState, rects: ClipRect[]): void {
  ctx.strokeStyle = COLORS.clipText
  ctx.lineWidth = 1
  for (const rect of rects) {
    const source = rect.loopSourceFlicks
    if (source === undefined || source <= 0 || rect.w < LOOP_TICK_MIN_CLIP_PX) continue
    // zoomed far out the seams would smear into noise (and cost thousands of
    // strokes on an hours-long bed) — skip below 3px of spacing
    if ((source / FLICKS_PER_SECOND) * state.zoomPxPerSec < 3) continue
    const firstSeam = source - (rect.mediaInFlicks % source)
    for (let seam = firstSeam; seam < rect.durationFlicks; seam += source) {
      const x = Math.round(rect.x + (seam / FLICKS_PER_SECOND) * state.zoomPxPerSec) + 0.5
      if (x <= rect.x + 1 || x >= rect.x + rect.w - 1) continue
      ctx.beginPath()
      ctx.moveTo(x, rect.y + 1)
      ctx.lineTo(x, rect.y + 1 + LOOP_TICK_H)
      ctx.stroke()
    }
  }
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

  drawKeyframeDiamonds(ctx, state, rects)

  drawLoopSeams(ctx, state, rects)

  // session provenance: a small dot on every clip an accepted AI pass touched
  if (state.attributedClipIds !== null && state.attributedClipIds.size > 0) {
    ctx.fillStyle = '#0a84ff'
    for (const rect of rects) {
      if (!state.attributedClipIds.has(rect.id)) continue
      ctx.beginPath()
      ctx.arc(rect.x + rect.w - 7, rect.y + 7, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  drawTransitionBadges(ctx, state)

  // selection time-range band (transcript word selection)
  if (state.selection.range !== null) {
    const x1 = timeToX(state, state.selection.range.startFlicks)
    const x2 = timeToX(state, state.selection.range.endFlicks)
    ctx.fillStyle = '#ffd60a26'
    ctx.fillRect(x1, RULER_H, Math.max(1, x2 - x1), state.height - RULER_H)
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = 1
    ctx.strokeRect(x1 + 0.5, RULER_H + 0.5, Math.max(1, x2 - x1), state.height - RULER_H - 1)
  }

  // silence-removal candidate bands (same band math as the selection range)
  if (state.silenceRanges !== null) {
    for (const range of state.silenceRanges) {
      const x1 = timeToX(state, range.fromFlicks)
      const x2 = timeToX(state, range.toFlicks)
      if (x2 < 0 || x1 > state.width) continue
      ctx.fillStyle = '#ff453a2b'
      ctx.fillRect(x1, RULER_H, Math.max(1, x2 - x1), state.height - RULER_H)
      ctx.strokeStyle = '#ff453a99'
      ctx.lineWidth = 1
      ctx.strokeRect(x1 + 0.5, RULER_H + 0.5, Math.max(1, x2 - x1), state.height - RULER_H - 1)
    }
  }

  // ghost-diff proposal: hatched strikethrough over the to-be-deleted ranges,
  // and the proposed result as a green ghost strip anchored above the minimap
  // zone — nothing here is committed until the human accepts
  if (state.proposal !== null) {
    for (const range of state.proposal.deletions) {
      const x1 = timeToX(state, range.fromFlicks)
      const x2 = timeToX(state, range.toFlicks)
      if (x2 < 0 || x1 > state.width) continue
      const w = Math.max(1, x2 - x1)
      ctx.fillStyle = '#ff453a22'
      ctx.fillRect(x1, RULER_H, w, state.height - RULER_H)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x1, RULER_H, w, state.height - RULER_H)
      ctx.clip()
      ctx.strokeStyle = '#ff453a88'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = x1 - state.height; x < x2; x += 7) {
        ctx.moveTo(x, state.height)
        ctx.lineTo(x + state.height, RULER_H)
      }
      ctx.stroke()
      ctx.restore()
      ctx.strokeStyle = '#ff453a99'
      ctx.strokeRect(x1 + 0.5, RULER_H + 0.5, w, state.height - RULER_H - 1)
    }
    const stripH = 12
    const stripY = state.height - MINIMAP_H - stripH - 4
    ctx.font = '8px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#30d158'
    ctx.fillText('PREVIEW', 4, stripY - 6)
    for (const ghost of state.proposal.ghostClips) {
      const x1 = timeToX(state, ghost.fromFlicks)
      const x2 = timeToX(state, ghost.toFlicks)
      if (x2 < 0 || x1 > state.width) continue
      roundedRectPath(ctx, x1, stripY, Math.max(2, x2 - x1 - 1), stripH, 2)
      ctx.fillStyle = '#30d15833'
      ctx.fill()
      ctx.strokeStyle = '#30d158aa'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

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
      const caretY = state.ghost.y ?? layout.spineY - 4
      const caretH = state.ghost.h ?? SPINE_H + 8
      ctx.moveTo(state.ghost.x + 0.5, caretY)
      ctx.lineTo(state.ghost.x + 0.5, caretY + caretH)
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

  // AI provenance badges in the ruler: one per rough-cut edit point while the
  // pass is the top of history (cleared the moment anything else edits) —
  // after drawRuler so the ruler background doesn't paint over them
  if (state.roughCutCuts !== null) {
    ctx.font = '8px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    for (const cut of state.roughCutCuts) {
      const x = timeToX(state, cut.flicks)
      if (x < -8 || x > state.width + 8) continue
      roundedRectPath(ctx, x - 7, RULER_H - 12, 14, 10, 3)
      ctx.fillStyle = '#0a84ff'
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText('AI', x, RULER_H - 7 + 1)
    }
    ctx.textAlign = 'left'
  }

  // agent playhead: where the copilot is currently working (streaming turns)
  if (state.agentPlayheadFlicks !== null) {
    const x = timeToX(state, state.agentPlayheadFlicks)
    if (x >= -8 && x <= state.width + 8) {
      ctx.strokeStyle = '#bf5af2'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + 0.5, RULER_H - 4)
      ctx.lineTo(x + 0.5, state.height)
      ctx.stroke()
      ctx.fillStyle = '#bf5af2'
      ctx.beginPath()
      ctx.moveTo(x - 5, RULER_H - 12)
      ctx.lineTo(x + 5, RULER_H - 12)
      ctx.lineTo(x, RULER_H - 4)
      ctx.closePath()
      ctx.fill()
    }
  }

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

  drawMinimap(ctx, state)

  return rects
}

/**
 * Bottom-anchored minimap: the whole sequence scaled to the canvas width,
 * with spine/connected blocks, the playhead tick, and the viewport rect.
 * Only drawn while the content is wider than the canvas (layout non-null).
 */
function drawMinimap(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const minimap = minimapLayout({
    durationFlicks: sequenceDuration(state.sequence),
    zoomPxPerSec: state.zoomPxPerSec,
    scrollX: state.scrollX,
    width: state.width,
    height: state.height
  })
  if (minimap === null) return

  ctx.fillStyle = COLORS.rulerBg
  ctx.fillRect(0, minimap.y, state.width, minimap.h)
  ctx.strokeStyle = COLORS.rulerTick
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, minimap.y + 0.5)
  ctx.lineTo(state.width, minimap.y + 0.5)
  ctx.stroke()

  // spine blocks (gaps stay background-colored)
  let position = 0
  for (const item of state.sequence.spine) {
    const w = (item.durationFlicks / FLICKS_PER_SECOND) * minimap.pxPerSec
    if (item.kind === 'clip') {
      ctx.fillStyle = COLORS.videoClip
      ctx.fillRect(
        (position / FLICKS_PER_SECOND) * minimap.pxPerSec,
        minimap.y + 9,
        Math.max(1, w - 0.5),
        6
      )
    }
    position += item.durationFlicks
  }

  // connected clips: a thin upper band (video lanes blue, audio lanes green)
  const startOf = spineStartIndex(state.sequence.spine)
  for (const cc of state.sequence.connected) {
    const parentStart = startOf.get(cc.parentClipId)
    if (parentStart === undefined) continue
    const start = parentStart + cc.offsetFlicks
    const w = (cc.durationFlicks / FLICKS_PER_SECOND) * minimap.pxPerSec
    ctx.fillStyle = cc.lane > 0 ? COLORS.videoClip : COLORS.audioClip
    ctx.fillRect((start / FLICKS_PER_SECOND) * minimap.pxPerSec, minimap.y + 4, Math.max(1, w), 3)
  }

  // playhead tick
  const playheadStripX = (state.playheadFlicks / FLICKS_PER_SECOND) * minimap.pxPerSec
  ctx.strokeStyle = COLORS.playhead
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(playheadStripX + 0.5, minimap.y + 1)
  ctx.lineTo(playheadStripX + 0.5, minimap.y + minimap.h)
  ctx.stroke()

  // viewport rect
  ctx.fillStyle = '#ffffff14'
  ctx.fillRect(minimap.viewportX, minimap.y + 1, minimap.viewportW, minimap.h - 1)
  ctx.strokeStyle = COLORS.rulerText
  ctx.strokeRect(minimap.viewportX + 0.5, minimap.y + 1.5, minimap.viewportW - 1, minimap.h - 2)
}
