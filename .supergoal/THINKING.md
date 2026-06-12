# THINKING — UX round 2 (2026-06-12)

## Goals
Ship the six features of docs/superpowers/specs/2026-06-12-ux-improvements-design.md
(loop playback, timecode click-to-type, play-marked-range, audio meter, viewer
fullscreen, timeline minimap + follow-playhead) with unit + E2E coverage, docs
updated, all five gates green in one run.

## Constraints
- Renderer-only round: no main-process changes, no new dependencies, no engine
  rewrites. Loop restart may be stop + play(0) (spec assumption).
- No overlap with the unbuilt audio/transcript moat spec (browser/transcript
  surfaces are off-limits).
- scrollX stays component-local in TimelineCanvas (scrollXRef); minimap renders
  inside the same canvas pass (render.ts) and hit-tests via state-derived rects.
- Shortcut additions go through registerShortcut (overlay auto-updates);
  README shortcut table regenerates via scripts/dump-shortcuts.mjs.
- Keys: ctrl+l, /, shift+f confirmed unbound (grep of combo: registrations).

## Risks (top 3)
1. **Fullscreen in Playwright/Electron may be denied or flaky.** Mitigation:
   catch rejection (documented no-op), E2E polls document.fullscreenElement,
   and the phase spec allows asserting the no-op path if the harness denies it.
2. **Loop wrap at sequence end races the engine's stop path** (engine stops at
   endSec; onEnded → play(0) could double-fire or leave `sequence-playing`
   false for a frame). Mitigation: implement wrap decision as a pure tested
   function in transport.ts; E2E polls across the boundary rather than
   asserting a single frame.
3. **Minimap pointer math vs. existing canvas drag handlers** (tool drags,
   trim, playhead scrub share pointer handlers). Mitigation: minimap rect gets
   first claim in the pointerdown dispatch BEFORE clip hit-testing; unit-test
   the rect math; E2E drags via mouse.down/move/up (no synthetic pointermove).

## Dependencies
- Phase 3 (range play) consumes phase 1's loop flag for range-wrap.
- Phase 7 regenerates the shortcut table after all shortcuts exist (1,2,3,5).
- Meter (4), fullscreen (5), minimap (6) are independent of 1–3.

## Open questions (assumed, surfaced in spec)
- Loop persistence key: localStorage["magnetic.playback.v1"] (JSON {loop}).
- Meter is mono; zone breaks −12/−6 dB; floor −60 dB.
- Minimap height 18 px; shown only when content wider than viewport.

## Memory hits applied
See applied-memories.md (canvas E2E gotchas are load-bearing for phase 6).

## Tools/skills relied on
Repo's own gates only. frontend-verify/Playwright MCP not needed — repo has a
mature Electron Playwright harness with __magneticTimeline state hook.

## Best practices applied
FCP conventions for keys (⌘L→Ctrl+L, /, typed timecode right-to-left fields);
NLE-standard meter ballistics (instant attack, ~300 ms release); FCP-style
playhead paging (no smooth scroll).
