import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import {
  MINIMAP_H,
  PAGE_MARGIN_PX,
  maxScrollX,
  minimapLayout,
  pagedScrollX,
  scrollXForMinimapX,
  type MinimapView
} from './minimap'

const F = FLICKS_PER_SECOND

/** 30 s sequence at 100 px/s in an 800x280 canvas → 3000 px content. */
const wide: MinimapView = {
  durationFlicks: 30 * F,
  zoomPxPerSec: 100,
  scrollX: 0,
  width: 800,
  height: 280
}

describe('minimapLayout', () => {
  it('hides when the content fits the canvas', () => {
    expect(minimapLayout({ ...wide, zoomPxPerSec: 10 })).toBeNull() // 300 px < 800
    expect(minimapLayout({ ...wide, durationFlicks: 0 })).toBeNull()
    expect(minimapLayout({ ...wide, width: 0 })).toBeNull()
  })

  it('anchors to the bottom and scales the sequence to the canvas width', () => {
    const layout = minimapLayout(wide)!
    expect(layout.y).toBe(280 - MINIMAP_H)
    expect(layout.pxPerSec).toBeCloseTo(800 / 30)
    expect(layout.viewportX).toBe(0)
    // viewport covers width/content of the strip
    expect(layout.viewportW).toBeCloseTo((800 / 3000) * 800)
  })

  it('moves the viewport rect proportionally to scrollX', () => {
    const scrolled = minimapLayout({ ...wide, scrollX: 1100 })!
    expect(scrolled.viewportX).toBeCloseTo((1100 / 3000) * 800)
  })
})

describe('scrollXForMinimapX', () => {
  it('centers the viewport on the pointed time, clamped to the scroll range', () => {
    // middle of the strip = 15 s = 1500 px absolute; center → 1500 - 400
    expect(scrollXForMinimapX(wide, 400)).toBeCloseTo(1100)
    // far left clamps to 0, far right clamps to maxScrollX
    expect(scrollXForMinimapX(wide, 0)).toBe(0)
    expect(scrollXForMinimapX(wide, 800)).toBe(maxScrollX(wide)) // 2200
  })
})

describe('pagedScrollX (follow-playhead)', () => {
  it('leaves the view alone while the playhead is visible', () => {
    expect(pagedScrollX(wide, 1 * F)).toBeNull() // 100 px, inside 0..792
    expect(pagedScrollX({ ...wide, scrollX: 500 }, 6 * F)).toBeNull() // 100 px into view
  })

  it('pages forward when the playhead crosses the right edge', () => {
    // 8 s = 800 px = beyond width-8 → park at 800 - margin
    expect(pagedScrollX(wide, 8 * F)).toBe(800 - PAGE_MARGIN_PX)
  })

  it('pages back when the playhead is left of the view (loop wrap)', () => {
    expect(pagedScrollX({ ...wide, scrollX: 2000 }, 0)).toBe(0)
  })

  it('clamps to the scroll range at the sequence tail', () => {
    expect(pagedScrollX(wide, 30 * F)).toBe(maxScrollX(wide))
  })

  it('never pages when the content fits (max scroll 0)', () => {
    const fits = { ...wide, zoomPxPerSec: 10 } // 300 px content
    expect(pagedScrollX(fits, 29 * F)).toBeNull()
  })
})
