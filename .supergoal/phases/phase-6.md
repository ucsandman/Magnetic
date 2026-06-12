SUPERGOAL_PHASE_START
Phase: 6 of 7 — Timeline minimap + follow-playhead
Task: Draw an 18px whole-sequence minimap strip in TimelineCanvas with click/drag panning, plus playback paging when the playhead exits the viewport.
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npx playwright test e2e/ux-controls.spec.ts e2e/timeline.spec.ts
Acceptance criteria: 7
Evidence required: minimap math unit test output; E2E output for drag-pans-scrollX, paging during playback, and no-fight-while-paused
Depends on phases: none

## Work

Spec section: "6. Timeline minimap + follow-playhead".

- src/renderer/timeline/minimap.ts: pure math —
  `minimapLayout({contentWidthPx, canvasWidthPx, scrollX})` returning
  `null` when contentWidthPx <= canvasWidthPx, else the strip rect
  (height 18), the viewport rect within it, and
  `timeAtMinimapX(x)` / `scrollXForCenterTime(...)` mapping helpers.
  Unit tests in src/renderer/timeline/minimap.test.ts.
- render.ts: draw the strip across the top of the canvas as part of the
  normal render pass when layout is non-null: background, spine clip blocks,
  thin connected-clip row, playhead tick, bordered viewport rect. Reuse the
  existing colors/tokens from render.ts.
- TimelineCanvas.tsx: pointerdown inside the strip claims the gesture BEFORE
  clip/playhead hit-testing (memory: state-derived hit rects, no DOM
  overlay). Down/drag centers the viewport on the pointed time → updates
  scrollXRef + redraw. Expose enough state through the existing
  __magneticTimeline hook for E2E (scrollX is already exposed; add
  `minimapVisible: boolean` and the strip rect).
- Follow-playhead paging: during sequence playback only, when the playhead's
  x exceeds the right edge, page scrollX forward so the playhead lands near
  the left edge (small margin). Never adjust scrollX while paused.
- E2E (ux-controls.spec.ts; mouse.move/down/up only — NO synthetic
  pointermove, per electron-canvas-e2e-gotchas): long sequence zoomed past
  one screen → minimapVisible true; drag inside the strip → scrollX changes;
  short sequence → minimapVisible false; play across the right edge →
  scrollX pages forward; paused manual pan stays put for ≥1 s.

## Acceptance criteria

1. minimap.ts unit tests pass: hidden when content fits; strip/viewport rect math; time↔x mapping round-trips.
2. Minimap renders only when content is wider than the canvas (E2E via minimapVisible in the state hook, both directions).
3. Dragging inside the strip changes scrollX in the state hook (E2E with mouse.down/move/up).
4. A click in the strip centers the viewport on the clicked time (unit on scrollXForCenterTime + E2E scrollX assertion).
5. During playback, the playhead crossing the right edge pages scrollX forward (E2E).
6. While paused, a manual wheel pan is never auto-adjusted (E2E: pan, wait ≥1 s, scrollX unchanged).
7. Existing timeline E2E stays green; all 5 mandatory commands exit 0.

## Cleanliness

No console.log/debugger in added lines; no new lint warnings.

[Agent prints SUPERGOAL_PHASE_VERIFY and SUPERGOAL_PHASE_DONE here during execution]

## Mandatory commands

- npm run typecheck
- npm run lint
- npm run test
- npm run build
- npx playwright test e2e/ux-controls.spec.ts e2e/timeline.spec.ts

## Evidence required

- minimap math unit test output; E2E output for drag-pans-scrollX, paging during playback, and no-fight-while-paused
