import { FLICKS_PER_SECOND } from '../../shared/timecode'

/**
 * Minimap + follow-playhead math, pure so it unit-tests without the canvas.
 * The strip sits at the BOTTOM of the timeline canvas (the ruler owns the
 * top edge for playhead scrubbing) and only exists while the sequence's
 * content is wider than the visible canvas.
 */

export const MINIMAP_H = 18
/** Margin the playhead lands at after a follow-playhead page. */
export const PAGE_MARGIN_PX = 24

export interface MinimapView {
  durationFlicks: number
  zoomPxPerSec: number
  scrollX: number
  width: number
  height: number
}

export interface MinimapLayout {
  /** Strip top, canvas CSS px (full canvas width, bottom-anchored). */
  y: number
  h: number
  /** Strip px per second of sequence time (whole sequence → canvas width). */
  pxPerSec: number
  /** Visible-viewport rectangle inside the strip. */
  viewportX: number
  viewportW: number
}

export function contentWidthPx(view: MinimapView): number {
  return (view.durationFlicks / FLICKS_PER_SECOND) * view.zoomPxPerSec
}

export function maxScrollX(view: MinimapView): number {
  return Math.max(0, contentWidthPx(view) - view.width)
}

export function minimapLayout(view: MinimapView): MinimapLayout | null {
  if (view.durationFlicks <= 0 || view.width <= 0) return null
  const content = contentWidthPx(view)
  if (content <= view.width) return null
  const durationSec = view.durationFlicks / FLICKS_PER_SECOND
  return {
    y: view.height - MINIMAP_H,
    h: MINIMAP_H,
    pxPerSec: view.width / durationSec,
    viewportX: (view.scrollX / content) * view.width,
    viewportW: Math.max(8, (view.width / content) * view.width)
  }
}

/** scrollX that centers the viewport on the sequence time under strip x. */
export function scrollXForMinimapX(view: MinimapView, x: number): number {
  const clampedX = Math.max(0, Math.min(view.width, x))
  const timeSec = (clampedX / view.width) * (view.durationFlicks / FLICKS_PER_SECOND)
  return Math.max(0, Math.min(maxScrollX(view), timeSec * view.zoomPxPerSec - view.width / 2))
}

/**
 * Follow-playhead paging (playback only): when the playhead leaves the
 * viewport — past the right edge, or behind the left edge after a loop
 * wrap — return the scrollX that parks it near the left edge. Null = the
 * playhead is visible, leave the view alone.
 */
export function pagedScrollX(view: MinimapView, playheadFlicks: number): number | null {
  const playheadAbs = (playheadFlicks / FLICKS_PER_SECOND) * view.zoomPxPerSec
  const px = playheadAbs - view.scrollX
  if (px >= 0 && px <= view.width - 8) return null
  return Math.max(0, Math.min(maxScrollX(view), playheadAbs - PAGE_MARGIN_PX))
}
