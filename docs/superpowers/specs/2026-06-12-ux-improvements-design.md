# UX improvements round 2: loop, timecode entry, range play, meters, fullscreen, minimap — design

Date: 2026-06-12 (round 2; supersedes the round-1 text of this doc)
Status: shipped 2026-06-12 (commits 16b7e0d..3cccc21; 377 unit + 35 E2E green
in one run; minimap landed at the canvas bottom — the ruler owns the top edge)

## Round 1 (shipped in c264516)

Visible transport on every viewer surface, Space rescue for dead states,
resizable layout + Reset Layout, the 9-cell review grid, Shift+Z zoom-to-fit,
Up/Down edit-point jumps, and focused-panel indication all shipped with unit +
E2E coverage (`e2e/ux-controls.spec.ts`). This round builds on those surfaces.

## Problem

Round 1 made playback *visible*; it did not make playback *controllable* the
way every surveyed NLE does. Round 1's own deferred list plus the 2026-06
research backlog leave six concrete gaps:

1. **No loop playback.** Reviewing a cut or a trim point means re-pressing
   Space forever. Every surveyed NLE ships a loop toggle (FCP ⌘L).
2. **Timecode is display-only.** "Go to 1:02:30" requires scrubbing a 6-hour
   timeline. The product's pitch is long-form; precise navigation is table
   stakes (FCP/Premiere/Resolve all accept typed timecode).
3. **Marks exist but nothing plays them.** I/O marks (`i`/`o`) drive edits,
   but there is no "play the marked range" (FCP `/`), so checking a selection
   before inserting means manual seek + watch + stop.
4. **No audio metering.** `audio-graph.ts` already computes RMS
   (`playbackEngine.audioRms()`, used only by the E2E harness) but no meter
   renders — users can't see levels without exporting.
5. **No fullscreen review.** The viewer is locked to its panel; there is no
   distraction-free playback for client review of long-form content.
6. **Timeline navigation doesn't scale to long-form.** The canvas pans via
   `scrollXRef` (wheel only), there is no overview of where you are in a
   6-hour sequence, and during playback the playhead walks off the right edge
   and keeps going off-screen.

## Assumptions

- Loop restart may be implemented as stop + `play(0)` at sequence end — an
  audible-gap-free engine-internal wrap is **not** required for v1.
- The audio meter is mono (one bar) because `audioRms()` returns a single
  power value; stereo split is out of scope.
- Fullscreen uses the renderer-side Fullscreen API
  (`element.requestFullscreen()`), no main-process window changes. It covers
  source and sequence modes only — the grid already binds `Escape` to close,
  which would collide with native fullscreen-exit.
- The minimap renders inside the existing `TimelineCanvas` (same canvas, same
  render pass) so `scrollXRef` stays component-local — no store plumbing, and
  hit-testing follows the repo's state-derived-rect convention.
- No overlap with the (approved, unbuilt) audio/transcript moat spec: that
  round owns the browser/transcript surfaces; this round touches only
  playback, viewer, and timeline surfaces.

## Design

### 1. Loop playback (`Ctrl+L` + transport button)

- New `loopPlayback: boolean` in the timeline store (`setLoopPlayback`),
  default off, persisted to `localStorage["magnetic.playback.v1"]`. One flag
  drives every surface.
- **Transport button** `🔁` (pressed-state styling when on) added to both the
  sequence and source transport bars; `Ctrl+L` registered once globally via
  `registerShortcut` (auto-appears in the Shift+? overlay).
- **Sequence:** when playback reaches sequence end with loop on, transport
  restarts from 0 (engine `onEnded` → `play(0)`); with loop off, behavior is
  unchanged (stop at end).
- **Source viewer:** sets the `<video>` element's `loop` property; when a
  marked range is set, loop wraps at `markOut` back to `markIn` (rAF check in
  the existing timecode loop) instead of the media end.
- **Grid cells** already loop; unaffected.

### 2. Timecode click-to-type seeking

- New pure helper in `src/shared/timecode.ts`:
  `parseTimecode(text: string, fps: number): number | null` (flicks).
  Accepts `HH:MM:SS:FF`, shorter colon forms (`MM:SS`, `SS:FF` per FCP
  right-to-left field order: FF, SS, MM, HH), and bare digit runs parsed as
  right-to-left pairs (`1234` → 12s 34f). Overflow normalizes (90f @30fps →
  3s); invalid input returns null. Result clamps to `[0, duration]` at the
  call site.
- Both transport timecodes (`ViewerPanel`, `SequencePlayer`) become
  click-to-edit: click swaps the text for a monospace `<input>` pre-filled
  and selected; `Enter` parses + seeks (source: media seek; sequence:
  `seekSequence`), `Escape` or blur cancels. Invalid input shakes/red-flashes
  and stays open. Keyboard shortcuts are suppressed while the input is
  focused (the registry's existing focus guard).

### 3. Play marked range (`/`, source viewer)

- `/` (registered in `ViewerPanel`, active when both marks set): seek to
  `markIn`, play, pause exactly at `markOut` (rAF boundary check, same loop
  as feature 1's range-wrap; loop on = wrap instead of pause).
- Transport gains no new button — this is keyboard-only, listed in the
  overlay, matching FCP.

### 4. Audio meter (sequence transport)

- New pure scale helper `src/renderer/viewer/meter-scale.ts`:
  `rmsToMeter(rms: number): { fraction: number; zone: 'green'|'yellow'|'red' }`
  mapping RMS → dBFS (`20·log10`, floor −60 dB) → bar fraction; zone breaks
  at −12 dB and −6 dB.
- New `src/renderer/viewer/AudioMeter.tsx`: a slim horizontal bar in the
  sequence transport bar, rAF-driven from `playbackEngine.audioRms()` while
  `sequence-playing`, instant attack / ~300 ms release decay, idle at zero.
  `data-testid="sequence-meter"`, exposes `aria-valuenow` (dB) for tests.

### 5. Viewer fullscreen (`Shift+F` + `⛶` button)

- `⛶` button on both transports + `Shift+F`: calls
  `requestFullscreen()` on the viewer panel container; native `Escape`
  exits. `:fullscreen` CSS keeps the transport bar visible (auto-hide is out
  of scope).
- Disabled in grid mode (Escape collision, see Assumptions).

### 6. Timeline minimap + follow-playhead

- **Minimap:** an 18 px strip across the top of `TimelineCanvas`, drawn in
  `render.ts` as part of the normal render pass, shown only when the
  sequence's content width exceeds the visible canvas width. Draws the whole
  sequence scaled to canvas width: spine clips as blocks, connected clips as
  a thin upper row, the playhead tick, and the current viewport as a
  bordered rectangle (derived from `scrollX`, `zoomPxPerSec`, canvas width).
- **Interaction:** pointer-down/drag inside the strip centers the viewport
  on that time (updates `scrollXRef` + redraw); it is a state-derived hit
  rect in `TimelineCanvas`'s existing pointer handlers (no DOM overlay).
- **Follow-playhead paging:** during sequence playback only, when the
  playhead's x crosses the right edge of the viewport, page `scrollX`
  forward so the playhead lands near the left edge (FCP-style paging, no
  smooth scroll; manual pans are never fought while paused).
- `scrollX` is already exposed through the `__magneticTimeline` test-state
  hook for E2E assertions.

## Docs

- README feature list: loop, typed timecode, range play, meters, fullscreen,
  minimap. Regenerate the shortcut table (`scripts/dump-shortcuts.mjs`).
- `docs/GUIDE.md`: update the playback/review workflow section.

## Error handling

- `parseTimecode` returns null on garbage; the input rejects visibly and
  never seeks.
- Fullscreen promise rejection (platform denial) is caught and ignored — the
  button is a no-op rather than a crash.
- Meter reads `audioRms()` only while the engine reports playing; engine
  absence/idle renders a zero bar.
- Loop with an empty sequence keeps round 1's Space-rescue semantics
  (nothing to loop, no change).

## Testing

- **Unit (vitest):** `parseTimecode` (all accepted forms, overflow
  normalization, garbage → null); `rmsToMeter` (floor, zone boundaries);
  loop-wrap decision logic in `transport.ts` (end + loop → restart, end +
  no-loop → stop); minimap viewport-rect math (pure helper, content narrower
  than canvas → hidden).
- **E2E (Playwright, extend `e2e/ux-controls.spec.ts`):**
  - loop: enable via button, play near sequence end, assert
    `sequence-playing` stays true after crossing the end and the playhead
    wrapped below its pre-wrap value
  - timecode: click sequence timecode, type `00:00:02:00`, Enter → playhead
    timecode reads it back; garbage input leaves playhead unmoved
  - range play: set i/o in source viewer, press `/`, assert playback pauses
    within a frame of `markOut`
  - meter: play the tone fixture, assert `sequence-meter` reports a non-zero
    `aria-valuenow`, then zero after pause + decay
  - fullscreen: click `⛶`, poll `document.fullscreenElement` set, Escape
    clears it (if the harness denies fullscreen, assert the documented
    no-op: no crash, button remains)
  - minimap: long sequence (zoomed in past one screen) → minimap visible;
    drag in the strip changes `scrollX` in the test-state hook; play across
    the right edge → `scrollX` pages forward
- **Gates:** `npm run typecheck`, `lint`, `test`, `build`, `test:e2e` green.

## Out of scope (this round)

- Dual viewers (event viewer + sequence viewer side by side).
- Filmstrip audio skimming / FCP-style skimming (browser surface belongs to
  the transcript-moat round; full skimming is its own engine-heavy round).
- Chapters/show-notes export (transcript surface, moat round).
- Retiming (per backlog: build it alone).
- Stereo meters, peak-hold, loudness (LUFS); transport auto-hide in
  fullscreen; smooth-scroll following.
