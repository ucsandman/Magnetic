/**
 * Test probe for canvas-local view state (scrollX lives in a ref inside
 * TimelineCanvas, not the store). Mirrors the perf.ts driver pattern; the
 * MAGNETIC_TEST hook exposes it as __magneticTimeline.view().
 */

export interface TimelineViewState {
  scrollX: number
  minimap: { y: number; viewportX: number; viewportW: number } | null
}

type ViewProbe = () => TimelineViewState

let probe: ViewProbe | null = null

export function registerViewProbe(fn: ViewProbe | null): void {
  probe = fn
}

export function timelineView(): TimelineViewState {
  if (probe === null) throw new Error('timeline canvas is not mounted')
  return probe()
}
