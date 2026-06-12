SUPERGOAL_PHASE_START
Phase: 5 of 7 — Viewer fullscreen
Task: Add a fullscreen button + Shift+F that fullscreens the viewer panel via the Fullscreen API, transport visible.
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npx playwright test e2e/ux-controls.spec.ts
Acceptance criteria: 6
Evidence required: E2E output for enter/exit fullscreen (or the documented no-op path if the harness denies it); grep showing the rejection catch
Depends on phases: none

## Work

Spec section: "5. Viewer fullscreen (Shift+F + ⛶ button)".

- ⛶ button (`data-testid="viewer-fullscreen"`) on the source and sequence
  transports; `shift+f` registered once (description for the overlay).
  Both call `requestFullscreen()` on the viewer panel container element;
  the returned promise's rejection is caught and ignored (documented no-op).
  If already fullscreen, the button/shortcut exits (`document.exitFullscreen()`).
- `:fullscreen` CSS on the viewer container: video/canvas fills the screen,
  transport bar remains visible at the bottom (no auto-hide).
- NOT rendered in grid mode (GridPlayer binds Escape to close-grid, which
  collides with native fullscreen-exit; spec assumption).
- E2E (ux-controls.spec.ts): click ⛶, poll `document.fullscreenElement` set
  to the container; press Escape, poll it cleared; transport bar visible
  while fullscreen. If the harness denies fullscreen (promise rejects),
  assert the documented no-op instead: no crash, no console error, button
  still present — and print which path ran.

## Acceptance criteria

1. `viewer-fullscreen` button renders on both source and sequence transports, and NOT in grid mode (E2E).
2. `shift+f` is registered and listed in the overlay (E2E or grep).
3. Activating fullscreen sets `document.fullscreenElement` to the viewer container (E2E; or the documented denial no-op path asserted and labeled).
4. Escape exits fullscreen (E2E, same conditional).
5. The transport bar is visible while fullscreen (E2E, same conditional).
6. requestFullscreen rejection is caught (grep shows .catch on the call path); all 5 mandatory commands exit 0.

## Cleanliness

No console.log/debugger in added lines; no new lint warnings.

[Agent prints SUPERGOAL_PHASE_VERIFY and SUPERGOAL_PHASE_DONE here during execution]

## Mandatory commands

- npm run typecheck
- npm run lint
- npm run test
- npm run build
- npx playwright test e2e/ux-controls.spec.ts

## Evidence required

- E2E output for enter/exit fullscreen (or the documented no-op path if the harness denies it); grep showing the rejection catch
