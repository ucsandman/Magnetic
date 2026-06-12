SUPERGOAL_PHASE_START
Phase: 1 of 7 — Loop playback toggle
Task: Add a persisted loop-playback flag driving sequence end-wrap, source viewer looping, transport buttons on both viewers, and Ctrl+L.
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npx playwright test e2e/ux-controls.spec.ts e2e/playback.spec.ts
Acceptance criteria: 8
Evidence required: unit test output for wrap decision; E2E output for loop wrap + button toggle; grep showing ctrl+l registration
Depends on phases: none

## Work

Spec section: "1. Loop playback" in docs/superpowers/specs/2026-06-12-ux-improvements-design.md.

- Add `loopPlayback: boolean` (default false) + `setLoopPlayback(on)` to the
  timeline store (src/renderer/timeline/timeline-store.ts). Persist to
  localStorage["magnetic.playback.v1"] as JSON `{loop}`; rehydrate at store
  creation. Do NOT put it in undoable document state — it is a view setting.
- transport.ts: make sequence end behavior loop-aware. Implement the decision
  as a pure exported function (e.g. `endOfSequenceAction(loop): 'wrap'|'stop'`
  or equivalent) so it unit-tests without the engine; wire the engine's
  end-of-playback path (engine stop at endSec → if loop on, play(0)).
  Stop+play(0) is acceptable per spec.
- Loop button on BOTH transports (SequencePlayer.tsx and ViewerPanel.tsx
  source transport): `data-testid="loop-toggle"`, `aria-pressed` mirrors the
  flag, pressed-state styling consistent with the existing transport buttons.
- Register `ctrl+l` ONCE globally (App.tsx, like ctrl+e) via registerShortcut
  with a description; it must appear in the Shift+? overlay automatically.
- Source viewer: the `<video>` element's `loop` property mirrors the flag
  while no marked range is set (range-wrap arrives in phase 3).
- Unit tests for the wrap decision + persistence round-trip (vitest, colocated
  test file).
- E2E (extend e2e/ux-controls.spec.ts): enable loop via the button, play near
  the sequence end, assert `sequence-playing` remains true after crossing the
  end AND the playhead value wrapped below its pre-wrap value; toggle via
  Ctrl+L reflected in aria-pressed.

## Acceptance criteria

1. Timeline store exposes `loopPlayback` (default false) and `setLoopPlayback`; toggling persists to localStorage["magnetic.playback.v1"] and rehydrates on reload (test or E2E evidence).
2. `ctrl+l` is registered through registerShortcut and listed by listShortcuts() (grep + overlay row visible in E2E).
3. Both transports render the loop button with `data-testid="loop-toggle"` and `aria-pressed` reflecting the flag; clicking toggles it.
4. Sequence playback with loop ON: crossing sequence end keeps `sequence-playing` true and the playhead wraps (E2E).
5. Sequence playback with loop OFF: stops at end exactly as before (existing playback E2E stays green).
6. Source viewer `<video>.loop` mirrors the flag (E2E via evaluate or unit).
7. New unit tests pass; no existing unit test broken (`npm run test` green).
8. `npm run typecheck`, `lint`, `build`, and the targeted Playwright run all exit 0.

## Cleanliness

No console.log/debugger in added lines; no new lint warnings.

[Agent prints SUPERGOAL_PHASE_VERIFY and SUPERGOAL_PHASE_DONE here during execution]

## Mandatory commands

- npm run typecheck
- npm run lint
- npm run test
- npm run build
- npx playwright test e2e/ux-controls.spec.ts e2e/playback.spec.ts

## Evidence required

- unit test output for wrap decision; E2E output for loop wrap + button toggle; grep showing ctrl+l registration
