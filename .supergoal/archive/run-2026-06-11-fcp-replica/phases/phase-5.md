SUPERGOAL_PHASE_START
Phase: 5 of 11 — Timeline UI & basic edits
Task: Canvas magnetic timeline with E/W/Q/D edits, ripple delete, snapping/zoom/skim, persistence
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 9
Evidence required: command outputs, E/W/Q/D E2E proof, perf numbers, screenshot
Depends on phases: 2, 4

## Why

This is where the kernel becomes the visible magnetic timeline — the single most recognizable surface of the replica.

## Work

- `src/renderer/state/`: Zustand store holding `{ project, sequence, selection, undoStack, playheadFlicks, zoomPxPerSec, snapping }`. All mutations go through kernel ops; store subscribes and persists sequence into project JSON (debounced via project-io IPC). Expose a `window.__magneticState` read-only snapshot under MAGNETIC_TEST for E2E deep-equal asserts.
- `src/renderer/timeline/`: Canvas 2D renderer on devicePixelRatio-aware canvas. Layers (painted in order): ruler (timecode ticks adaptive to zoom), audio lanes (below spine), spine row (taller), connected video lanes (above), clip bodies with rounded rects + name + filmstrip slice (from P2 strips) + waveform polyline (from peaks JSON), gap clips (dark hatch), selection highlights, snapping guides, skimmer line, playhead. Virtualize: only draw clips intersecting viewport.
- Interactions this phase: click select, shift-click range, drag from browser into timeline (append at drop or connect on upper lane drop), rubber-band optional (skip if time-tight — not in criteria). Keyboard: E append, W insert at playhead, Q connect at playhead, D overwrite at playhead (source = browser selection; use I/O range from viewer if set, else whole clip), Del ripple delete, Shift+Del lift, N snapping toggle, +/- and Ctrl+wheel zoom, S skimming toggle. Timeline skim: hover updates skimmer + viewer shows frame (static seek via existing viewer; full engine is P7).
- Playhead: click ruler to move; Home/End; renders across all lanes.
- Snapping: drag/trim operations snap to clip edges, playhead, markers when enabled (visual guide line) — implement snap-point provider in kernel-adjacent util with unit tests.
- Perf harness: `MAGNETIC_TEST` hook builds a 100-clip sequence programmatically; render loop instrumented (performance.now around draw), E2E pulls median frame time and prints it.
- `e2e/timeline.spec.ts` covering the criteria below.

## Acceptance criteria (all must pass — verify each in transcript)

- E2E builds a 3-clip spine via E/W/Q/D and asserts kernel state matches expected order/durations
- Ripple delete closes the gap (E2E asserts total duration shrinks by exactly the clip length); lift leaves a gap clip
- Connected clip (Q) renders on a lane above the spine and moves with its parent (E2E drag assert)
- Snapping on/off (N) changes drag behavior at clip edges (E2E)
- Zoom changes px-per-second; clips re-render with filmstrips + waveforms (screenshot diff non-identical)
- Relaunch restores the sequence exactly (E2E deep-equal via exposed state)
- Timeline with 100 clips renders at <33 ms median frame time (perf harness logs numbers to transcript)
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-5/timeline.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; E/W/Q/D E2E proof; perf median number; `.supergoal/evidence/phase-5/timeline.png`

## Notes

- Canvas hit-testing: maintain a parallel array of clip rects from the last draw; do not read pixels.
- Filmstrip slices: drawImage from the strip with source-rect math; cache HTMLImageElements per asset.
- Draw only on state change + rAF coalescing, not a free-running loop — perf criterion is about draw cost, idle should be 0 draws.
- FCP look targets: spine clips ~48 px tall, connected ~32 px, 4 px lane gutters, selection = amber outline, skimmer = thin red, playhead = white with triangle handle.
