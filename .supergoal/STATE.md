# State: Magnetic — FCP-style NLE for Windows

**Status:** RUNNING
**Current phase:** 7
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
| 7 | Sequence playback engine | pending | — | — | — |
| 8 | Transitions, titles, color, audio | pending | — | — | — |
| 9 | Export | pending | — | — | — |
| 10 | Edit-by-transcript | pending | — | — | — |
| 11 | Polish & Harden | pending | — | — | — |

## Engineering check status

Updated by each phase as it runs. Cleared at the start of the next phase, so this always reflects the **most recent** engineering check.

- Build: pass (phase 6)
- Typecheck: pass (phase 6)
- Lint: pass (phase 6)
- Tests: pass (phase 6 — 128 unit, 6 E2E)

## Notable events

Append-only log of anything noteworthy that happened during execution (assumption corrected mid-run, retry, manual intervention, etc.). Each phase writes a line here.

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
