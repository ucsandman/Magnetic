# Roadmap: Magnetic — FCP-style NLE for Windows

**Task:** Build a Windows desktop replica of Final Cut Pro's signature experience (magnetic timeline, 3-panel UI, import→edit→export) plus edit-by-transcript, portfolio-polished.
**Type:** greenfield, ui
**Created:** 2026-06-11
**Total phases:** 11

## Context summary

- **Stack:** Electron + React 18 + TypeScript (strict) via electron-vite; Zustand + immer; Canvas 2D timeline; WebCodecs + WebGL2 + Web Audio playback; ffmpeg/ffprobe + whisper.cpp native binaries
- **Package manager:** npm
- **Build / test / lint commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e` (all phases) · `npm run package` (phase 11 only)
- **Risky areas:** WebCodecs sequence playback (P7), native binary spawning on Windows (P1), magnetic-semantics edge cases (P4)

## Feature matrix (the approved cut-line — "zero missing features" means zero missing from THIS list)

Libraries/Events/Projects · import (copy-to-library) · filmstrip browser with hover-skim, favorite/reject, search · viewer with JKL, frame-step, I/O, timecode · magnetic timeline (spine + connected clips, lanes, gap clips, snapping, zoom, skimming) · edits: append E / insert W / connect Q / overwrite D / ripple delete / lift · tools: select A, blade B, trim T (ripple), roll, slip · drag-rearrange with magnetic collision · full undo/redo · sequence playback with compositing + transforms (position/scale/rotation/opacity) · audio mixing, per-clip volume/pan/fades · transitions: cross dissolve, wipe L/R, fade-to-black · titles: free text + 3 presets · color board: exposure/contrast/saturation/temperature · export H.264/AAC MP4 (1080p/720p/source) with progress + cancel · **edit-by-transcript: local Whisper, word-click seek, delete-text-to-cut, filler-word removal, transcript search** · missing-media relink · keyboard-shortcut overlay · NSIS installer.

Explicitly OUT (deferred, not failures): multicam, keyframe animation, color wheels/curves/scopes, proxy workflow, compound clips, 360°/HDR, plugins, Motion templates, ProRes encode, object tracking, collaboration.

## Assumptions

Non-blocking decisions recorded so we can proceed without round-trips. If any are wrong, stop the run and tell us:

- App working title **"Magnetic"** (package `magnetic`); README credits Final Cut Pro as the design reference. Apple trademarks not used in product name.
- Node ≥ 20 and git on PATH; npm is the package manager.
- Internet available during phase 1 to fetch ffmpeg (gyan.dev release build), whisper.cpp prebuilt Windows binary, and ggml `base.en` model (~250 MB total) into gitignored `resources/bin/`.
- Performance bar: smooth 1080p H.264 playback; 4K accepted at degraded fidelity (no proxy pipeline in scope).
- Whisper model `base.en`, English-only UI and filler-word list.
- No `.env`/secrets exist in this app (local-only); `.env.example` deliberately omitted.
- `electron-builder` dependency added in phase 11 for the installer (pre-approved here).
- Repo stays local (no GitHub push unless asked). Each phase ends with a git commit.
- FCP keyboard grammar mapped ⌘→Ctrl on Windows.
- Two-up trim display and audition clips are out of scope (signature tier).

## Risk top 3

1. **WebCodecs sequence playback/AV-sync (P7)** — likelihood: high, mitigation: P3 decode spike; documented `<video>`-seek + per-clip ffmpeg preview-proxy fallback; measurable drift criterion (<50 ms/30 s).
2. **Native binaries on Windows (P1)** — likelihood: medium, mitigation: pinned URLs + sha256, idempotent fetch script, spawn smoke-test asserted in E2E.
3. **Magnetic-semantics edge cases (P4)** — likelihood: medium, mitigation: pure-TS kernel with property-based invariant tests gates all timeline UI.

## Phase map

| # | Phase | Depends on | Deliverable |
|---|-------|------------|-------------|
| 1 | Scaffold shell & binaries | — | Bootable dark 3-panel Electron app; ffmpeg/whisper fetched & spawn-verified; full toolchain |
| 2 | Library, import & browser | 1 | Library/Event/Project persistence; import; filmstrip browser with skim/rate/search |
| 3 | Viewer & source playback | 2 | `<video>` viewer with JKL/frame-step/I-O/timecode; WebCodecs decode spike |
| 4 | Magnetic timeline kernel | 1 | Pure-TS spine/connected model, all edit ops, undo, property-tested |
| 5 | Timeline UI & basic edits | 2, 4 | Canvas timeline; E/W/Q/D edits; ripple delete; snapping/zoom/skim; persistence |
| 6 | Edit tools & trimming | 5 | A/B/T tools, roll/slip, magnetic drag-rearrange, full undo/redo UI |
| 7 | Sequence playback engine | 3, 5 | WebCodecs+WebGL2 compositing playback with audio mix and transforms |
| 8 | Transitions, titles, color, audio | 7 | Dissolve/wipes/fade, title system, color board, audio fades, Inspector |
| 9 | Export | 7, 8 | WYSIWYG export via headless compositor → ffmpeg; presets, progress, cancel |
| 10 | Edit-by-transcript | 3, 6 | Whisper transcription, word-sync panel, delete-text-to-cut, filler removal |
| 11 | Polish & Harden | 1–10 | Every aspect verified; states/edges/perf/a11y; installer; docs; evidence suite |

---

## Phase 1 — Scaffold shell & binaries

**Why:** Everything depends on a bootable, verifiable app shell with the toolchain and native binaries proven on day one.

**Deliverables:**
- `package.json` with scripts: dev, build, typecheck, lint, test, test:e2e, fetch-binaries, fixtures
- `electron.vite.config.ts`, `tsconfig.json`, eslint + prettier config, `playwright.config.ts`
- `src/main/index.ts` (window, menu), `src/preload/index.ts` (typed bridge), `src/renderer/` React shell
- `src/renderer/layout/` — dark FCP-style 3-panel layout (browser left, viewer top-right, timeline bottom; toggleable inspector)
- `scripts/fetch-binaries.mjs` — pinned-URL + sha256 fetch of ffmpeg/ffprobe/whisper + base.en model into `resources/bin/`
- `scripts/make-fixtures.mjs` — generated test media (testsrc 1080p30 + sine; 25fps clip; audio-only wav; SAPI TTS speech wav with known script)
- `e2e/smoke.spec.ts` — Playwright-Electron boot test
- `README.md` (run steps), `.gitignore` (node_modules, dist, out, resources/bin, fixtures)

**Acceptance criteria:**
- [ ] `npm run dev` boots a window; E2E asserts title "Magnetic" and all three panels visible
- [ ] `scripts/fetch-binaries.mjs` downloads and sha256-verifies ffmpeg, ffprobe, whisper binary + model; second run is a no-op (idempotent), proven in transcript
- [ ] Diag IPC spawns `ffprobe -version` and whisper `--help` from main; E2E asserts both return exit 0
- [ ] `scripts/make-fixtures.mjs` produces ≥4 fixture files; ffprobe-verified durations printed
- [ ] Renderer runs with contextIsolation on, nodeIntegration off (asserted in E2E via feature probe)
- [ ] typecheck, lint, test, build, test:e2e all exit 0
- [ ] Screenshot `.supergoal/evidence/phase-1/shell.png` saved showing dark 3-panel layout
- [ ] Git repo committed; README documents install/dev/build/fetch steps

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs (last ~10 lines + exit codes); fetch-binaries idempotency demo; shell screenshot

**Dependencies:** none

---

## Phase 2 — Library, import & browser

**Why:** FCP's organization model (Library→Event→Project) and the filmstrip browser are half its identity and feed every later phase.

**Deliverables:**
- `src/shared/types.ts` — Library/Event/Project/MediaAsset types
- `src/main/project-io/` — `.mglib` folder format, atomic JSON writes, autosave
- `src/main/media/` — import (copy-to-library), ffprobe metadata, background job queue producing filmstrip strips + waveform peaks via ffmpeg
- `src/renderer/browser/` — event sidebar, filmstrip grid/list, hover-skim, favorite/reject, search
- `e2e/browser.spec.ts`

**Acceptance criteria:**
- [ ] E2E imports the fixtures and asserts grid shows them with correct duration badges
- [ ] Hover-skim over a filmstrip changes the displayed frame (E2E pointer-move assertion)
- [ ] Favorite/reject and search filter the grid (E2E)
- [ ] Library persists: E2E relaunches the app and asserts assets + ratings restored
- [ ] Atomic-write unit tests pass (crash-during-save leaves valid previous JSON)
- [ ] Thumbnails/waveforms generate in background: during generation the E2E performs a rating click and asserts the UI responds (no blocking)
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-2/browser.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; import E2E output; relaunch-persistence proof; screenshot

**Dependencies:** 1

---

## Phase 3 — Viewer & source playback

**Why:** Frame-accurate source review (JKL, I/O) is core editing grammar, and the WebCodecs spike here de-risks phase 7.

**Deliverables:**
- `src/renderer/viewer/` — `<video>`-based viewer: play/pause, JKL (incl. 2x and reverse-step), ←/→ frame step, I/O points, timecode display
- `src/shared/timecode.ts` — flicks↔frames↔timecode math
- `src/renderer/playback/decoder/` — WebCodecs + mp4box.js decode spike (behind debug flag)
- `e2e/viewer.spec.ts`

**Acceptance criteria:**
- [ ] E2E opens a fixture in viewer, plays 1 s, asserts time advances and pauses cleanly
- [ ] JKL: L plays forward, K pauses, J moves time backward (reverse-step), LL doubles rate — each asserted by timecode movement in E2E
- [ ] Frame step moves exactly one frame at 30 and 25 fps fixtures (timecode assert)
- [ ] I/O points set/clear and render as range on the scrubber (E2E)
- [ ] Timecode math unit tests pass for 23.976/24/25/30/59.94/60 fps (flicks-based, zero drift over 1 h)
- [ ] WebCodecs spike decodes ≥60 frames of the H.264 fixture; test asserts frame count + dimensions
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-3/viewer.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; JKL E2E output; WebCodecs spike frame-count proof; screenshot

**Dependencies:** 2

---

## Phase 4 — Magnetic timeline kernel

**Why:** The magnetic timeline is FCP's soul; correctness must be proven in a pure, UI-free library before any pixels are drawn.

**Deliverables:**
- `src/shared/timeline/model.ts` — Sequence/Clip/ConnectedClip/Gap/Transition types; flicks time math
- `src/shared/timeline/ops.ts` — append/insert/overwrite/connectAt/rippleDelete/liftDelete/blade/trimRipple/roll/slip/move
- `src/shared/timeline/magnetic.ts` — connected-clip attachment, lane auto-stacking on collision
- `src/shared/timeline/undo.ts` — command pattern with inverse ops
- `src/shared/timeline/*.test.ts` — unit + property tests (fast-check)

**Acceptance criteria:**
- [ ] ≥80 kernel tests pass, including property test: any random sequence of ops preserves spine invariants (contiguous, no overlap, no implicit gaps)
- [ ] Property test: undo after any op restores deep-equal prior state; redo re-applies
- [ ] Ripple delete shifts downstream clips AND keeps connected clips attached to their parents (explicit tests)
- [ ] Blade at clip boundary is a no-op; blade mid-clip yields two clips whose durations sum exactly (flicks)
- [ ] Roll preserves total duration; slip preserves clip bounds while changing media in-point (tests)
- [ ] Connected-clip collision bumps to next lane, never overlaps (property test)
- [ ] Kernel has zero DOM/Electron imports (grep criterion: no `document`, `window`, `electron` in `src/shared/timeline/`)
- [ ] Kernel line coverage ≥90% (vitest --coverage output in transcript)
- [ ] All mandatory commands exit 0

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** test count + coverage output; property-test run proof; grep output for DOM-free check

**Dependencies:** 1

---

## Phase 5 — Timeline UI & basic edits

**Why:** This is where the kernel becomes the visible magnetic timeline — the single most recognizable surface of the replica.

**Deliverables:**
- `src/renderer/timeline/` — Canvas 2D renderer: spine, connected lanes, audio lanes, clip filmstrips + waveforms, ruler, playhead, zoom, scroll, snapping (N), timeline skimming
- `src/renderer/state/` — Zustand stores wrapping the kernel; sequence persisted into project JSON
- Edit wiring: append E, insert W, connect Q, overwrite D from browser selection; drag from browser to timeline; click/range select; ripple delete (Del), lift (Shift+Del)
- `e2e/timeline.spec.ts`

**Acceptance criteria:**
- [ ] E2E builds a 3-clip spine via E/W/Q/D and asserts kernel state matches expected order/durations
- [ ] Ripple delete closes the gap (E2E asserts total duration shrinks by exactly the clip length); lift leaves a gap clip
- [ ] Connected clip (Q) renders on a lane above the spine and moves with its parent (E2E drag assert)
- [ ] Snapping on/off (N) changes drag behavior at clip edges (E2E)
- [ ] Zoom changes px-per-second; clips re-render with filmstrips + waveforms (screenshot diff non-identical)
- [ ] Relaunch restores the sequence exactly (E2E deep-equal via exposed state)
- [ ] Timeline with 100 clips renders at <33 ms median frame time (perf harness logs numbers to transcript)
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-5/timeline.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; E/W/Q/D E2E proof; perf numbers; screenshot

**Dependencies:** 2, 4

---

## Phase 6 — Edit tools & trimming

**Why:** Professional trimming (blade/ripple/roll/slip) plus magnetic drag-rearrange completes the editing grammar.

**Deliverables:**
- `src/renderer/timeline/tools/` — tool palette + cursor modes: select (A), blade (B), trim (T); roll on edit points; slip on clip middle with modifier
- Magnetic drag-rearrange: clips shuffle without overlaps; connected clips follow; collision lane-bump
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z) across every operation, wired through kernel undo
- `e2e/tools.spec.ts`

**Acceptance criteria:**
- [ ] Blade at playhead splits: clip count +1, durations sum unchanged (E2E)
- [ ] Ripple trim shortens a clip and shifts all downstream clips left by the same amount (E2E numeric assert)
- [ ] Roll moves an edit point without changing total duration (E2E)
- [ ] Slip changes a clip's media in/out without moving its timeline position (E2E via exposed state)
- [ ] Drag-rearrange reorders the spine; magnetic close-up leaves no gap or overlap (E2E)
- [ ] 50 random edit operations then 50 undos restore the exact initial kernel state (deep-equal, automated)
- [ ] Tool shortcuts A/B/T switch cursor + behavior (E2E)
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-6/trimming.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; trim/roll/slip E2E numeric proofs; undo-storm proof; screenshot

**Dependencies:** 5

---

## Phase 7 — Sequence playback engine

**Why:** Playing the edited sequence with compositing is the hardest, most load-bearing capability — it unblocks transitions and export.

**Deliverables:**
- `src/renderer/playback/scheduler.ts` — lookahead WebCodecs decode of spine + connected video against an audio-master clock
- `src/renderer/playback/compositor/` — WebGL2 layer compositor (lane order, per-clip transform: position/scale/rotation/opacity)
- `src/renderer/playback/audio/` — per-clip PCM (ffmpeg-extracted) scheduled via Web Audio at clip offsets with per-clip volume
- `src/renderer/inspector/` — Video tab (transform controls) bound to selection
- Fallback path: unsupported-codec clips get an on-demand ffmpeg preview proxy (H.264) and never crash playback
- `e2e/playback.spec.ts`

**Acceptance criteria:**
- [ ] 3-clip sequence plays end-to-end across both cut points without exception; playhead time progresses monotonically (E2E)
- [ ] Scrub to an arbitrary time shows the correct clip's frame — verified by pixel-sampling distinct testsrc/color fixtures at known coordinates (E2E numeric RGB assert)
- [ ] Connected clip composites above the spine (pixel assert at overlay region)
- [ ] Transform: scale 50% + reposition reflected in sampled pixels (E2E)
- [ ] A/V drift < 50 ms after 30 s of playback (measured audio-clock vs video PTS, numbers in transcript)
- [ ] Pause/resume/seek 20× in a loop stays stable (no crash, memory steady ±20%, E2E)
- [ ] Unsupported-codec fixture triggers proxy fallback and still plays (E2E)
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-7/playback.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; drift measurement; pixel-assert outputs; screenshot

**Dependencies:** 3, 5

---

## Phase 8 — Transitions, titles, color & audio

**Why:** Dissolves, titles, and the color board take the timeline from cuts-only to a real FCP-style edit.

**Deliverables:**
- `src/shared/timeline/transitions.ts` — kernel transition objects at edit points (duration, handle clamping) + undo
- `src/renderer/playback/compositor/effects/` — GLSL: cross dissolve, wipe L/R, fade-to-black; color board uniforms (exposure/contrast/saturation/temperature)
- `src/renderer/titles/` — text clips (connected): font/size/color/position + 3 presets (Basic, Lower Third, Bumper), canvas-to-texture
- Audio: per-clip volume slider, fade in/out handles on clips, pan
- `src/renderer/inspector/` — Color, Audio, Title tabs
- `e2e/effects.spec.ts`

**Acceptance criteria:**
- [ ] Cross dissolve at a cut: mid-transition sampled pixel is a blend (neither pure clip A nor pure clip B color, numeric assert)
- [ ] Wipe and fade-to-black each verified by pixel asserts at characteristic times
- [ ] Title preset renders text over video (screenshot diff vs no-title baseline exceeds threshold)
- [ ] Exposure +1 measurably brightens a sampled pixel; saturation 0 grays it (numeric asserts)
- [ ] Audio fade-in produces a rising gain envelope (unit test on audio-graph parameters)
- [ ] Kernel transition ops (add/remove/resize/undo) unit-tested, handles clamped to available media
- [ ] Inspector tabs bind to selection and update live (E2E)
- [ ] All mandatory commands exit 0
- [ ] Screenshots `.supergoal/evidence/phase-8/` (transition mid-frame, title, inspector)

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; pixel-assert numbers; screenshots

**Dependencies:** 7

---

## Phase 9 — Export

**Why:** An NLE that can't deliver a file isn't an NLE; WYSIWYG export proves the whole pipeline end to end.

**Deliverables:**
- `src/renderer/playback/offline.ts` — deterministic headless compositor replay (frame-by-frame clock)
- `src/main/export/` — rawvideo stdin pipe → ffmpeg (H.264/AAC MP4); OfflineAudioContext mixdown as second input; presets 1080p/720p/source; progress + cancel IPC
- `src/renderer/export/` — export dialog with preset picker, progress bar, cancel
- `e2e/export.spec.ts`

**Acceptance criteria:**
- [ ] E2E exports a 5 s sequence (3 clips + dissolve + title); ffprobe asserts duration ±1 frame, h264+aac streams, requested resolution and fps
- [ ] WYSIWYG: frame extracted from the export at t=2 s matches the live-preview frame at t=2 s within a stated pixel-diff tolerance (numeric result in transcript)
- [ ] Audio present and non-silent in output (ffmpeg volumedetect mean_volume > -70 dB)
- [ ] Progress events are monotonic 0→100 (E2E)
- [ ] Cancel mid-export terminates ffmpeg and leaves no partial file in the destination (E2E)
- [ ] Export errors (e.g., destination locked) surface a readable dialog, not a crash (E2E)
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-9/export.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; ffprobe output of exported file; WYSIWYG diff number; screenshot

**Dependencies:** 7, 8

---

## Phase 10 — Edit-by-transcript

**Why:** The chosen improvement — the headline capability FCP lacks: edit video by editing text, fully local.

**Deliverables:**
- `src/main/transcribe/` — job: ffmpeg → 16 kHz WAV → whisper.cpp with word-level timestamps → transcript JSON stored per asset in the library
- `src/renderer/transcript/` — panel assembling the timeline's transcript (word times mapped through clip in/out + position): word-click seek, text-range selection ↔ timeline range, search
- Delete-text-to-cut: deleting selected words ripple-deletes the matching timeline ranges (kernel ops, single undoable command; splits at clip edges handled)
- Filler-word detection (um/uh/like/you-know list) with highlight + one-click "Remove all fillers" (single undoable command)
- `e2e/transcript.spec.ts`

**Acceptance criteria:**
- [ ] TTS fixture transcription matches the known script at ≥70% word accuracy (automated WER-style check; bump model to small.en if base.en falls short — assumption pre-approved)
- [ ] Clicking a word seeks the playhead within ±100 ms of the word's start (E2E)
- [ ] Deleting a sentence shortens the sequence by that sentence's duration ±1 frame AND removes those words from the panel (E2E numeric assert)
- [ ] One undo restores both timeline and transcript exactly after a text deletion (E2E)
- [ ] "Remove all fillers" removes every list-match in one step; undo restores all (E2E)
- [ ] Transcript search highlights matches and jumps the playhead (E2E)
- [ ] Transcription runs as a background job; UI remains interactive during it (E2E)
- [ ] All mandatory commands exit 0
- [ ] Screenshot `.supergoal/evidence/phase-10/transcript.png`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e`

**Evidence required:** command outputs; word-accuracy number; delete-to-cut numeric proof; screenshot

**Dependencies:** 3, 6

---

## Phase 11 — Polish & Harden

**Why:** Catch what earlier phases missed because they were focused on shipping behavior. This is how "every aspect is perfect" gets enforced.

**Sub-passes (each must produce evidence):**

- [ ] **UX & copy** — every visible string reads well, no debug placeholders or lorem
- [ ] **States** — empty library, importing-in-progress, missing-media relink flow (rename a file → relink dialog → relocate), unsupported-codec message; all E2E-verified
- [ ] **Edges** — zero-length selections, 500-clip timeline opens and stays interactive, unicode filenames, paths with spaces
- [ ] **Security** — contextIsolation on, nodeIntegration off, zod validation on every IPC channel (malformed payload rejected, unit-tested), CSP set, no remote content
- [ ] **A11y** — focus order sane, shortcuts don't hijack text inputs, text contrast ≥ AA, shortcut overlay (?) lists every binding
- [ ] **Perf** — startup < 3 s to interactive, timeline interaction stays < 33 ms median at 500 clips, no unbounded memory growth in a 5-min playback soak (numbers in transcript)
- [ ] **Packaging** — `npm run package` produces an NSIS installer in `dist/`; the packaged exe launches and passes the boot E2E
- [ ] **Docs** — README complete: features, full shortcut table, architecture sketch, build/run/package steps
- [ ] **Diff review** — full-tree review for stray debug logs, dead code, TODOs from this run
- [ ] **Regression sweep** — entire test + E2E suite green; final screenshot set (browser/viewer/timeline/inspector/transcript/export) in `.supergoal/evidence/phase-11/`

**Mandatory commands:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` · `npm run test:e2e` · `npm run package`

**Evidence required:** one paragraph per sub-pass (checked/found/fixed); perf numbers; installer path + packaged-app boot proof; final screenshot set; final test summary

**Dependencies:** 1–10
