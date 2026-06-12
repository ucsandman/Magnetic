SUPERGOAL_PHASE_START
Phase: 4 of 11 — Magnetic timeline kernel
Task: Pure-TS spine/connected-clip model with all edit ops, magnetic semantics, undo — property-tested, zero DOM
Type: greenfield
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 9
Evidence required: test count + coverage output, property-test run proof, grep output for DOM-free check
Depends on phases: 1

## Why

The magnetic timeline is FCP's soul; correctness must be proven in a pure, UI-free library before any pixels are drawn.

## Work

- `src/shared/timeline/model.ts`: `Sequence { id, fps: Rational, spine: SpineItem[], connected: ConnectedClip[] }`; `SpineItem = Clip | GapClip`; `Clip { id, assetId, mediaInFlicks, durationFlicks }` (timeline position of spine items is DERIVED by summation — single source of truth prevents gap/overlap bugs by construction); `ConnectedClip { id, assetId|titleData, parentClipId, offsetFlicks (from parent start), lane (1+ video above, -1- audio below), mediaIn, duration }`; `Transition` placeholder type (filled in P8). Derived index helpers: `spineStartOf(clipId)`, `clipAtTime(flicks)`, `sequenceDuration()`.
- `src/shared/timeline/ops.ts` — every op is `(seq, args) → { next: Sequence, inverse: Op }` (pure, structural sharing via immer or hand-rolled): `append`, `insertAt(timeFlicks)` (splits clip if mid-clip, ripples), `overwriteAt`, `connectAt(timeFlicks, lane?)`, `rippleDelete(ids)`, `liftDelete(ids)` (→ GapClip), `blade(clipId, timeFlicks)`, `trimRipple(clipId, edge: 'head'|'tail', deltaFlicks)` (clamped to media bounds + min 1 frame), `roll(editPointIndex, delta)`, `slip(clipId, delta)`, `move(clipId, toIndex)` (rearrange).
- `src/shared/timeline/magnetic.ts`: connected clips keep `parentClipId` through every spine op — if parent is rippled/moved, they move with it; if parent is deleted, connected clips re-attach to the clip now under their absolute time (FCP behavior) or delete if none. Lane collision: when two connected clips on the same lane would overlap in absolute time, the later-added bumps up a lane (video) / down (audio). Deterministic.
- `src/shared/timeline/undo.ts`: `UndoStack { apply(op), undo(), redo() }` storing inverses; coalescing group API (`beginGroup/endGroup`) for multi-op commands (used by P10 filler removal).
- `src/shared/timeline/select.ts`: selection model (clip ids + ranges), pure.
- Tests (`*.test.ts`, fast-check for property tests):
  - invariant suite: after ANY randomly generated op sequence (≥200 runs × ≥20 ops): durations all ≥1 frame, media bounds respected, connected parents exist, lane overlaps absent, derived positions strictly increasing.
  - undo property: apply N random ops, undo N → deep-equal initial; redo N → deep-equal final.
  - directed cases: blade at boundary no-op; blade sums exact; ripple delete keeps connected attached; roll preserves total duration; slip keeps bounds; trim clamps at media end; insert mid-clip splits correctly; move closes and reopens magnetically.

## Acceptance criteria (all must pass — verify each in transcript)

- ≥80 kernel tests pass, including property test: any random sequence of ops preserves spine invariants (contiguous, no overlap, no implicit gaps)
- Property test: undo after any op restores deep-equal prior state; redo re-applies
- Ripple delete shifts downstream clips AND keeps connected clips attached to their parents (explicit tests)
- Blade at clip boundary is a no-op; blade mid-clip yields two clips whose durations sum exactly (flicks)
- Roll preserves total duration; slip preserves clip bounds while changing media in-point (tests)
- Connected-clip collision bumps to next lane, never overlaps (property test)
- Kernel has zero DOM/Electron imports (grep criterion: no `document`, `window`, `electron` in `src/shared/timeline/`)
- Kernel line coverage ≥90% (vitest --coverage output in transcript)
- All mandatory commands exit 0

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Test count + coverage summary; one property-test run log; `grep -rn "document\|window\|electron" src/shared/timeline/ || echo CLEAN` output

## Notes

- Use the superpowers TDD skill here: write the directed cases red-first for each op.
- Positions derived, never stored, is the key design decision — do not "optimize" it away; memoize the prefix-sum index instead if profiling demands.
- fast-check shrinking will find brutal edge cases (0-duration after trim, double-blade same point); fix the op clamps, don't weaken the invariants.
- Keep ops total-function: invalid args (unknown id, out-of-range time) return `{ next: seq, inverse: noop }` + typed error in a result field — never throw mid-edit.
