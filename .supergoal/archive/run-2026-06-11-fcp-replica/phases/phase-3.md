SUPERGOAL_PHASE_START
Phase: 3 of 11 — Viewer & source playback
Task: <video>-based viewer with JKL/frame-step/I-O/timecode plus a WebCodecs decode spike that de-risks phase 7
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 8
Evidence required: command outputs, JKL E2E output, WebCodecs spike frame-count proof, screenshot
Depends on phases: 2

## Why

Frame-accurate source review (JKL, I/O) is core editing grammar, and the WebCodecs spike here de-risks phase 7.

## Work

- `src/shared/timecode.ts`: flicks constants (705,600,000/s), `flicksPerFrame(fpsRational)`, flicks↔frame↔`HH:MM:SS:FF` conversions (drop-frame NOT required — non-drop display, note in UI). Exhaustive unit tests at 23.976/24/25/30/59.94/60: frame→flicks→frame round-trips exactly for 1 hour of frames (loop test, integer equality).
- `src/renderer/viewer/`: video element fed by `magnetic-media://` custom protocol (register in main, streams from library media dir — needed because renderer is sandboxed). Controls: transport bar (play/pause, prev/next frame, I/O buttons), scrubber with skim, timecode readout (current / duration), I→mark in, O→mark out rendered as a range highlight, X clears.
- JKL: L=play 1x, LL=2x (playbackRate), K=pause, J=reverse — implement reverse as paused stepping at rate (requestAnimationFrame seek stepping; smoothness not required, correctness is), Space toggles. ←/→ frame step via currentTime = frameIndex±1 mapped through timecode math; Shift+←/→ = 10 frames.
- Selecting a browser clip loads it in viewer (double-click or Enter). Esc returns focus to browser.
- WebCodecs spike `src/renderer/playback/decoder/`: mp4box.js demux → VideoDecoder; API: `openSample(assetPath) → { config, decodeRange(fromFlicks, frameCount): AsyncIterable<VideoFrame> }`. Spike harness page behind `MAGNETIC_TEST` flag; E2E (or vitest in electron renderer env) decodes ≥60 frames of `bars-1080p30.mp4`, asserts count and codedWidth/Height, closes frames properly (no GC warnings).
- Keyboard map module `src/renderer/shortcuts.ts` started: central registry (used by all later phases), ignores events when focus is in text inputs.

## Acceptance criteria (all must pass — verify each in transcript)

- E2E opens a fixture in viewer, plays 1 s, asserts time advances and pauses cleanly
- JKL: L plays forward, K pauses, J moves time backward (reverse-step), LL doubles rate — each asserted by timecode movement in E2E
- Frame step moves exactly one frame at 30 and 25 fps fixtures (timecode assert)
- I/O points set/clear and render as range on the scrubber (E2E)
- Timecode math unit tests pass for 23.976/24/25/30/59.94/60 fps (flicks-based, zero drift over 1 h)
- WebCodecs spike decodes ≥60 frames of the H.264 fixture; test asserts frame count + dimensions
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-3/viewer.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; JKL E2E output; WebCodecs spike frame-count proof; `.supergoal/evidence/phase-3/viewer.png`

## Notes

- Custom protocol must set proper range-request support for `<video>` seeking (implement `protocol.handle` with Range header support) — verify current Electron protocol API via Context7.
- `VideoFrame.close()` discipline matters: the spike should also assert no more than N frames alive at once (backpressure), since P7 reuses this.
- If 23.976 fixture is needed for tests, extend make-fixtures rather than shipping media.
- Frame-step assert: read timecode element text, not float currentTime, to avoid rounding flake.
