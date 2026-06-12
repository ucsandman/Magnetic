SUPERGOAL_PHASE_START
Phase: 7 of 11 — Sequence playback engine
Task: WebCodecs decode scheduling + WebGL2 compositing + Web Audio mixdown for full-sequence playback with transforms
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 9
Evidence required: command outputs, drift measurement, pixel-assert outputs, screenshot
Depends on phases: 3, 5

## Why

Playing the edited sequence with compositing is the hardest, most load-bearing capability — it unblocks transitions and export.

## Work

- `src/renderer/playback/scheduler.ts`: given sequence + playhead, compute active clips (spine + connected) and decode-ahead windows. Per-asset decoder sessions (from P3 spike) with a bounded frame queue (≤8 frames/clip); evict behind playhead. Pre-roll the NEXT spine clip's decoder ≥0.5 s before its cut. Clock master = AudioContext.currentTime; video presents the queued frame with PTS ≤ clock each rAF.
- `src/renderer/playback/compositor/`: WebGL2 — one textured quad per visible layer, painted back-to-front: spine layer, then connected lanes ascending. Per-clip uniforms: transform (position px, scale %, rotation deg, opacity %) — anchor center, sequence-space 1920×1080 canvas (letterbox other aspect ratios). Upload via texImage2D from VideoFrame (close frames after upload). `preserveDrawingBuffer: false`; expose `compositor.readPixels(x,y,w,h)` test hook that re-renders then reads (for E2E pixel asserts and P9 export).
- `src/renderer/playback/audio/`: at import time P2 already extracts peaks; here add full PCM extraction job (16-bit wav via ffmpeg, cached in `.mglib/cache/pcm/`) lazily on first sequence play per asset. Decode to AudioBuffer once, schedule BufferSources at clip offsets (mediaIn-shifted), per-clip GainNode (volume from clip model, default 0 dB). Rebuild graph on edit or seek; master gain → destination.
- Viewer integration: when timeline has focus/playhead, viewer shows sequence playback (FCP behavior: one viewer). Space plays/pauses sequence; JKL maps too; scrub/skim = synchronous single-frame render path (decode nearest keyframe → target, render still). Timeline playhead animates during playback.
- `src/renderer/inspector/` Video tab: Position X/Y, Scale, Rotation, Opacity number scrubbers bound to selected clip (stored on clip model, kernel-adjacent `clipFx` map persisted with project; changes are undoable).
- Fallback: assets whose codec WebCodecs rejects get a one-time ffmpeg preview-proxy job (1080p H.264) and decode from the proxy; UI badge "proxy". Never crash playback.
- Drift harness: MAGNETIC_TEST hook plays 30 s loop of fixtures, samples (audioClock − presentedVideoPTS) each second, reports max |drift| ms; E2E prints series + max.
- `e2e/playback.spec.ts` per criteria; memory check via `process.memoryUsage()` IPC sampled before/after the 20× pause/seek loop.

## Acceptance criteria (all must pass — verify each in transcript)

- 3-clip sequence plays end-to-end across both cut points without exception; playhead time progresses monotonically (E2E)
- Scrub to an arbitrary time shows the correct clip's frame — verified by pixel-sampling distinct testsrc/color fixtures at known coordinates (E2E numeric RGB assert)
- Connected clip composites above the spine (pixel assert at overlay region)
- Transform: scale 50% + reposition reflected in sampled pixels (E2E)
- A/V drift < 50 ms after 30 s of playback (measured audio-clock vs video PTS, numbers in transcript)
- Pause/resume/seek 20× in a loop stays stable (no crash, memory steady ±20%, E2E)
- Unsupported-codec fixture triggers proxy fallback and still plays (E2E)
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-7/playback.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; drift series + max; RGB pixel-assert values; `.supergoal/evidence/phase-7/playback.png`

## Notes

- THIS IS THE RISK PHASE. If blocked after the protocol's retries, the documented fallback ladder is: (1) reduce decode-ahead/clip concurrency; (2) per-clip preview proxies for EVERYTHING (uniform path); (3) `<video>`-seek stills for scrub + proxy-only playback. Ship the strongest rung that passes criteria and record the rung in STATE.md.
- Generate an unsupported-codec fixture in make-fixtures (e.g. mpeg2 or prores via ffmpeg) for the fallback test.
- Frame upload is the perf hotspot: prefer `texStorage2D`+`texSubImage2D` reuse; never allocate textures per frame.
- Pixel asserts: sample 4×4 average, tolerance ±12/255 per channel — testsrc2 has stable color regions; document sampled coords in the test.
- Audio rebuild-on-seek must stop old sources (no double-audio); assert via analyser RMS that audio is silent when paused.
