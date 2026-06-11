# State: Magnetic — FCP-style NLE for Windows

**Status:** RUNNING
**Current phase:** 11
**Started:** 2026-06-11
**Last update:** 2026-06-11
**Baseline ref:** 26c22d9756e5f73e5266fb728e7a5252479870b2    <!-- HEAD sha captured at Stage 7 dispatch; the audit + cleanliness checks compare the COMPLETE working tree (committed + staged + unstaged + untracked) against it via repo-state.sh -->

## Phase progress

| # | Phase | Status | Started | Completed | Notes |
|---|-------|--------|---------|-----------|-------|
| 1 | Scaffold shell & binaries | completed | 2026-06-11 | 2026-06-11 | commit aee7c7f; all 8 criteria pass |
| 2 | Library, import & browser | completed | 2026-06-11 | 2026-06-11 | commit 7aa7d35; all 8 criteria pass |
| 3 | Viewer & source playback | completed | 2026-06-11 | 2026-06-11 | commit f3f3358; all 8 criteria pass |
| 4 | Magnetic timeline kernel | completed | 2026-06-11 | 2026-06-11 | commit 2212482; all 9 criteria pass; 95 kernel tests, 99.66% line cov |
| 5 | Timeline UI & basic edits | completed | 2026-06-11 | 2026-06-11 | commit 0b7a2ed; all 9 criteria pass; perf median <1ms vs 33ms budget |
| 6 | Edit tools & trimming | completed | 2026-06-11 | 2026-06-11 | commit d11b866; all 9 criteria pass; 72-op undo storm deep-equal |
| 7 | Sequence playback engine | completed | 2026-06-11 | 2026-06-11 | commit 0cba5d3; all 9 criteria pass; drift max 4ms; full WebCodecs path (rung 0) |
| 8 | Transitions, titles, color, audio | completed | 2026-06-11 | 2026-06-11 | commit c38aa8a; all 8 criteria pass; dissolve mid exact (A+B)/2 |
| 9 | Export | completed | 2026-06-11 | 2026-06-11 | commit b4de5b7; all 8 criteria pass; WYSIWYG diff 0.97/255 |
| 10 | Edit-by-transcript | completed | 2026-06-11 | 2026-06-11 | commit cf790be; all 9 criteria pass; 100% word accuracy; Δ0.00-frame cuts |
| 11 | Polish & Harden | completed | 2026-06-11 | 2026-06-11 | all 10 criteria pass; installer 498.9MB; soak ×0.821; full suite 164 unit + 14 E2E green in one run |

## Engineering check status

Updated by each phase as it runs. Cleared at the start of the next phase, so this always reflects the **most recent** engineering check.

- Build: pass (phase 11)
- Typecheck: pass (phase 11)
- Lint: pass (phase 11)
- Tests: pass (phase 11 — 164 unit, 14 E2E in one run incl. 5-min soak + packaged boot)
- Package: pass (phase 11 — dist/magnetic-0.1.0-setup.exe, 498.9 MB)

## Notable events

Append-only log of anything noteworthy that happened during execution (assumption corrected mid-run, retry, manual intervention, etc.). Each phase writes a line here.

- 2026-06-11 — Phase 11 done. Relink ships duration±1-frame validation; contrast criterion forced a real fix (--color-accent-fill #0a6fe0, white-on-accent 3.65→4.81:1); dead exportProbe removed; installer 498.9 MB (whisper model + ffmpeg dominate); packaged boot E2E proves resourcesPath/bin resolution. Windows gotcha: background ffmpeg jobs hold imported media open → EBUSY on rename; hardening spec waits for derivatives then retries. Soak RSS shrank (×0.821) — warmup allocations dominate.
- 2026-06-11 — Phase 10 done (cf790be). base.en delivered 100% word accuracy on the TTS fixture (no model bump). Whisper flags verified empirically: -ml 1 -sow -oj -ojf gives one-word segments with ms offsets + token p. Transcript panel is a pure projection — undo correctness fell out for free.
- 2026-06-11 — Phase 9 done (b4de5b7). WYSIWYG export shipped at full pipeline strength; engine hardened en route: VideoDecoder.flush() end-of-stream hang (raced), isExporting guard against snapshot-broadcast still-renders, decode-gate B-frame deadlock breaker, arcTo negative-radius clamp. WYSIWYG diff 0.97/255 over 15 grid points.
- 2026-06-11 — Phase 8 done (c38aa8a), resumed from WIP ef620f9. Declared deviations: transitions afterClipId-attached (ripple-safe vs spec editPointIndex); fade handles via Inspector fields (no timeline edge drags); transition resize op-only (no badge drag). wipeR shader factor was inverted — caught by pixel E2E. Effects pixel asserts use uniform-color fixtures for exact math.
- 2026-06-11 — (superseded) RUN PAUSED by user (usage limit) mid-phase-8 at WIP ef620f9. Phases 1-7 complete. DONE in 8: kernel transitions (afterClipId-attached — declared deviation from spec's editPointIndex, ripple-safe; ops addTransition/removeTransition/resizeTransition/setTransitionKind; clamp 2×min(handle); prune+clamp inside ops ok() after every edit; transitionAt(seq,t) → {kind, aClipId, bClipId, progress}); ClipFx += exposure/contrast/saturation/temperature/fadeInFlicks/fadeOutFlicks/volumeDb/pan (DEFAULT_FX updated); ConnectedClip.titleData (presets basic|lowerThird|bumper); zod schemas with defaults. REMAINING in 8 (plan in session tasks 8B-8D): (B) compositor transition GLSL program (dissolve mix / wipeL+R smoothstep 2px / fadeBlack via-black) drawing full-canvas quad sampling BOTH slot textures with per-rect UV; engine: per-item visible windows extended by transition half-widths (in/out), both-side decode at cuts (media formula mediaIn+(t-start) naturally yields handles), blend layer when transitionAt(t) active, also in renderStill; color uniforms (pipeline temp→exposure→contrast→saturation) in fragment shader; title layers = offscreen 2D canvas (2× supersample, wrap 80%) → texture via CompositedLayer.image, cache by titleData hash, bumper baked 0.5s fade via layer alpha. (C) audio-graph: gain ramps from pure fn gainAutomationFor() in src/renderer/playback/automation.ts + unit test (rising envelope), StereoPannerNode, volume dB→gain; UI: Ctrl+T = default 1s dissolve at edit point nearest playhead (store command), transition badge at cuts on canvas + right-click cycles kind, Del removes when selected(?); Browser Titles tab (3 presets, dblclick connects at playhead via connectAt+titleData, default 4s lane 1); Inspector tabs Video/Color/Audio/Title with Reset (all via setClipFx/setTitleData ops; setTitleData op NOT yet written). (D) e2e/effects.spec.ts: handles via trim (bars tail -2s, red head +2s, cut 8s); dissolve mid = |mid-(a+b)/2|<25/ch; wipeL p=0.5 left=B right=A; fadeBlack mid ≤20; title region readPixels diff-count; exposure +1 brightens bars gray center; saturation 0 → R≈G≈B±6 at a found-colorful px; inspector live; screenshots transition/title/inspector to .supergoal/evidence/phase-8/; 5 mandatory commands; VERIFY/DONE then phases 9-11.
- 2026-06-11 — Phase 7 done (0cba5d3) — THE RISK PHASE, shipped at full strength (rung 0: WebCodecs decode + WebGL2 composite + Web Audio clock; no fallback-ladder descent). Drift max 4ms over 37s. Proxies only for non-H.264 (green-prores fixture). Declared deviation: J key pauses instead of reverse-playing the sequence (reverse decode unsupported); source-clip viewer JKL unaffected. New fixture green-prores.mov added to make-fixtures.
- 2026-06-11 — Phase 6 done (d11b866). Undo storm green first run (72 ops). Gotcha for future tests: full-source clips have zero roll/extend media headroom — target blade-cut boundaries. Edit menu accelerators swallow Ctrl+Z for real input; synthetic E2E input bypasses menu and hits the renderer registry instead (one undo either way).
- 2026-06-11 — Phase 5 done (0b7a2ed). Electron fires no synthetic pointermove → timeline canvas uses mouse events + window-level drag capture; canvas-in-flex blowup fixed with absolute positioning; hit rects computed from state (stale-draw class bug); phase-3 browser.spec flake root-caused (grid reflow vs cached boundingBox) and fixed. zustand added (per phase spec).
- 2026-06-11 — Phase 4 done (2212482), resumed from WIP 30b4738. fast-check (flick-jittered, non-frame-aligned generators) shrank a real sliver bug: overwriteAt at timeFlicks=1 cut a 1-flick clip; fixed with ensureBoundary snap-to-edge. Kernel: 95 tests, 99.66% line coverage, DOM-free grep CLEAN.
- 2026-06-11 — Plan drafted, 11 phases. Scope: signature replica + edit-by-transcript (user-approved tier).
- 2026-06-11 — Pre-flight green (env-level): node v24.15.0, npm 10.9.0, git 2.52.0. npm-script baseline deferred to phase 1 by design (greenfield).
- 2026-06-11 — Dispatch ready. Baseline 26c22d9; PROTOCOL.md + repo-state.sh in place; all 11 specs validated.
- 2026-06-11 — RUN PAUSED by user (usage limit) mid-phase-4 at WIP commit 30b4738. Phases 1-3 complete. Resume: implement src/shared/timeline/ops.ts to turn ops.test.ts green, then magnetic.ts lane/reattach logic, undo.ts, select.ts, fast-check property suites (>=200 runs x >=20 ops), coverage >=90%. Op design decided: OpResult { next, inverse: {type:'restore', sequence}, error? }, total-function (invalid args -> same seq + typed error), deterministic split ids (head keeps id, tail = `${id}:${timeFlicks}`), Clip carries sourceDurationFlicks, lane bump deterministic by array order.
- 2026-06-11 — Phase 3 done (f3f3358). moov-at-end MP4s don't stream over custom schemes → imports faststart-remuxed. One transient browser-E2E failure observed then 2× green; watch for recurrence. mfile:// extended with Range support instead of adding magnetic-media:// (declared deviation).
- 2026-06-11 — Phase 2 done (7aa7d35). mfile:// protocol needs corsEnabled+ACAO for renderer fetch from file:// origin; preload index.d.ts must be named global.d.ts (index.ts shadows it in tsconfig.node). locator.hover({position}) unreliable in Electron — use page.mouse.move(abs).
- 2026-06-11 — Phase 1 done (aee7c7f). Pins: ffmpeg 8.1.1 gyan essentials, whisper.cpp v1.8.6 bin-x64 (whisper-cli.exe), ggml-base.en. Fixes en route: zod kept out of sandboxed preload (electron-vite externalizes deps); System32 bsdtar for zip extraction; bin dir resolved via __dirname not app.getAppPath().

## Failure log

If a phase hits FAILURE_PROBE, record it here:

- (none)
