SUPERGOAL_PHASE_START
Phase: 6 of 11 — Edit tools & trimming
Task: A/B/T tool palette, ripple/roll/slip trimming, magnetic drag-rearrange, full undo/redo wiring
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 9
Evidence required: command outputs, trim/roll/slip E2E numeric proofs, undo-storm proof, screenshot
Depends on phases: 5

## Why

Professional trimming (blade/ripple/roll/slip) plus magnetic drag-rearrange completes the editing grammar.

## Work

- `src/renderer/timeline/tools/`: tool state machine — Select (A), Blade (B), Trim (T). Cursor changes per tool + hover zone (clip body vs edge vs edit point). Toolbar buttons mirror shortcuts with tooltips showing key.
- Blade tool: click on clip → kernel `blade` at that time (snapped). Cmd/Ctrl+B blades at playhead across spine (selected clip(s) only if selection exists).
- Trim (works in Select near edges too, FCP-style): drag clip head/tail → `trimRipple` live-preview (ghost rect + delta tooltip in frames), commit on mouseup as ONE undo step (use undo group). Edge highlight: yellow bracket on hoverable edges.
- Roll: drag exactly on an edit point (between two clips) with T tool → `roll`. Slip: Alt-drag (or T tool drag on clip middle) → `slip` with filmstrip preview shifting inside the clip rect.
- Drag-rearrange (Select tool, drag clip body horizontally): kernel `move` preview — other clips animate (or jump) aside magnetically; drop commits; Esc cancels. Connected clips travel with parent visually during preview.
- Undo/redo: Ctrl+Z / Ctrl+Shift+Z wired through kernel UndoStack for ALL ops (edits from P5 included); Edit menu items with enablement state.
- `e2e/tools.spec.ts`: numeric asserts via `window.__magneticState` (durations in flicks before/after each op), plus the 50-op undo storm: script applies 50 randomized ops via test hook, then 50 undos, deep-equal initial state.

## Acceptance criteria (all must pass — verify each in transcript)

- Blade at playhead splits: clip count +1, durations sum unchanged (E2E)
- Ripple trim shortens a clip and shifts all downstream clips left by the same amount (E2E numeric assert)
- Roll moves an edit point without changing total duration (E2E)
- Slip changes a clip's media in/out without moving its timeline position (E2E via exposed state)
- Drag-rearrange reorders the spine; magnetic close-up leaves no gap or overlap (E2E)
- 50 random edit operations then 50 undos restore the exact initial kernel state (deep-equal, automated)
- Tool shortcuts A/B/T switch cursor + behavior (E2E)
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-6/trimming.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; trim/roll/slip numeric proofs; undo-storm deep-equal proof; `.supergoal/evidence/phase-6/trimming.png`

## Notes

- Live trim preview must NOT mutate the kernel until commit — render from a `previewOp` overlay state so Esc-cancel is free.
- Pointer math: all px↔flicks conversions through one helper; off-by-one frame bugs cluster here.
- The undo storm test is the phase's real gate — if it flakes, the kernel inverse of some UI-path op is wrong; fix the op, never loosen the test.
- Trim delta tooltip shows frames (e.g. "-12f"), matching FCP.
