SUPERGOAL_PHASE_START
Phase: 3 of 7 — Play marked range (/)
Task: Make / play markIn→markOut in the source viewer, pausing at out (or wrapping when loop is on).
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npx playwright test e2e/ux-controls.spec.ts e2e/viewer.spec.ts
Acceptance criteria: 5
Evidence required: E2E output showing pause within one frame of markOut and loop-wrap behavior
Depends on phases: 1

## Work

Spec section: "3. Play marked range (/, source viewer)".

- Register `/` in ViewerPanel (source mode), active only when both markIn and
  markOut are set: seek to markIn, play, and pause exactly at markOut via a
  boundary check in the existing rAF timecode loop (no setTimeout).
- With loopPlayback ON (phase 1 flag): wrap markOut → markIn instead of
  pausing. This is also the moment to honor the phase-1 note: when a marked
  range is set and loop is on, plain playback wraps at markOut too (the
  `<video>.loop` native flag only covers the no-range case).
- No new button; the shortcut gets a description so the Shift+? overlay lists
  it.
- E2E (ux-controls.spec.ts): set i/o marks on a clip, press `/`, poll until
  paused, assert |currentTime − markOut| ≤ one frame; enable loop, press `/`,
  assert playback continues past markOut with currentTime wrapped into the
  range.

## Acceptance criteria

1. `/` with both marks set seeks to markIn and plays (E2E).
2. Playback pauses within one frame of markOut when loop is off (E2E).
3. With loop on, playback wraps markOut → markIn and keeps playing (E2E).
4. `/` with fewer than two marks set is a no-op (E2E or unit on the guard).
5. `/` appears in the shortcut overlay; all 5 mandatory commands exit 0.

## Cleanliness

No console.log/debugger in added lines; no new lint warnings.

[Agent prints SUPERGOAL_PHASE_VERIFY and SUPERGOAL_PHASE_DONE here during execution]

## Mandatory commands

- npm run typecheck
- npm run lint
- npm run test
- npm run build
- npx playwright test e2e/ux-controls.spec.ts e2e/viewer.spec.ts

## Evidence required

- E2E output showing pause within one frame of markOut and loop-wrap behavior
