SUPERGOAL_PHASE_START
Phase: 4 of 7 — Audio meter
Task: Render a mono RMS meter in the sequence transport driven by playbackEngine.audioRms().
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npx playwright test e2e/ux-controls.spec.ts
Acceptance criteria: 5
Evidence required: meter-scale unit test output; E2E output showing non-zero aria-valuenow during tone playback and decay after pause
Depends on phases: none

## Work

Spec section: "4. Audio meter (sequence transport)".

- src/renderer/viewer/meter-scale.ts: pure
  `rmsToMeter(rms: number): { fraction: number; zone: 'green'|'yellow'|'red'; db: number }`
  — dB = 20·log10(rms) floored at −60; fraction maps [−60, 0] → [0, 1];
  zone breaks at −12 dB (yellow) and −6 dB (red). rms ≤ 0 → floor.
- src/renderer/viewer/AudioMeter.tsx: slim horizontal bar in the
  SequencePlayer transport bar. rAF loop reads `playbackEngine.audioRms()`
  only while the sequence is playing; instant attack, ~300 ms release decay;
  idle renders zero. `data-testid="sequence-meter"`, `role="meter"`,
  `aria-valuenow` = current dB (rounded). Zone color via CSS class.
- Unit tests: src/renderer/viewer/meter-scale.test.ts — floor, both zone
  boundaries, 0 dB → fraction 1, monotonicity.
- E2E (ux-controls.spec.ts): build a sequence from the tone fixture, play,
  poll `sequence-meter`'s aria-valuenow > −60; pause, poll until it returns
  to the floor.

## Acceptance criteria

1. `rmsToMeter` unit tests pass: floor at −60 dB, zone boundaries at −12/−6 dB, rms=1 → fraction 1.
2. `sequence-meter` renders inside the sequence transport bar with role="meter" and aria-valuenow (E2E presence check).
3. During tone-fixture playback, aria-valuenow rises above the −60 floor (E2E).
4. After pause, the meter decays back to the floor (E2E poll, ≤ ~2 s).
5. Idle/no-engine state renders a zero bar with no console errors; all 5 mandatory commands exit 0.

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

- meter-scale unit test output; E2E output showing non-zero aria-valuenow during tone playback and decay after pause
