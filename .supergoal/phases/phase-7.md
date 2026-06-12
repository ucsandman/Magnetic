SUPERGOAL_PHASE_START
Phase: 7 of 7 — Polish & Harden
Task: Docs, shortcut table regen, evidence screenshots, full-suite green in one run, cleanliness vs baseline.
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npm run test:e2e
Acceptance criteria: 8
Evidence required: full-suite output (one run) with totals; grep results for README/GUIDE updates; screenshot file listing; repo-state added-lines cleanliness grep output
Depends on phases: 1,2,3,4,5,6

## Work

Spec sections: "Docs" + the overall gates.

- README.md: add loop, typed timecode, range play, audio meter, fullscreen,
  minimap to the feature list. Regenerate the shortcut table with
  `node scripts/dump-shortcuts.mjs` (must include ctrl+l, /, shift+f).
- docs/GUIDE.md: update the playback/review workflow section to cover the
  six features (concise, match existing voice).
- Evidence screenshots into .supergoal/evidence/ux2/: loop button pressed,
  meter during playback, minimap on a long sequence (reuse the
  final-screens.spec.ts capture pattern or a small dedicated script).
- Run ALL gates in one pass: typecheck, lint, test, build, full test:e2e.
  Surface totals (unit count, E2E count) into the transcript.
- Cleanliness vs baseline:
  `bash .supergoal/repo-state.sh added-lines 422994f82ae70027e31b203c5580525ae0332b7a`
  grepped for `console\.log|debugger|TODO\(|FIXME` — zero hits in added
  app-code lines (test fixtures excluded if any legitimately match).
- Check the Shift+? overlay row count grew by exactly the number of new
  registered shortcuts (ctrl+l, /, shift+f — timecode input is not a
  shortcut), and the hardening.spec.ts overlay-row assertion (28 rows at
  baseline) is updated accordingly rather than deleted.

## Acceptance criteria

1. README feature list names all six features (grep).
2. README shortcut table regenerated and includes ctrl+l, /, shift+f (grep).
3. docs/GUIDE.md playback/review section covers the new controls (grep).
4. Three evidence screenshots exist under .supergoal/evidence/ux2/ (ls).
5. Full suite green in ONE run: typecheck, lint, test, build, test:e2e all exit 0, totals printed.
6. Cleanliness grep over added lines vs 422994f is clean.
7. Overlay row assertion in hardening.spec.ts updated to the new exact count and green.
8. No regressions: every pre-existing E2E spec passes in the full run.

[Agent prints SUPERGOAL_PHASE_VERIFY and SUPERGOAL_PHASE_DONE here during execution]

## Mandatory commands

- npm run typecheck
- npm run lint
- npm run test
- npm run build
- npm run test:e2e

## Evidence required

- full-suite output (one run) with totals; grep results for README/GUIDE updates; screenshot file listing; repo-state added-lines cleanliness grep output
