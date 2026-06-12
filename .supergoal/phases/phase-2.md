SUPERGOAL_PHASE_START
Phase: 2 of 7 — Timecode click-to-type seeking
Task: Add parseTimecode to shared/timecode.ts and make both transport timecodes click-to-edit inputs that seek on Enter.
Mandatory commands: npm run typecheck; npm run lint; npm run test; npm run build; npx playwright test e2e/ux-controls.spec.ts
Acceptance criteria: 7
Evidence required: parseTimecode unit test output; E2E output for seek-by-typing, cancel, and invalid-input cases
Depends on phases: none

## Work

Spec section: "2. Timecode click-to-type seeking".

- src/shared/timecode.ts: add `parseTimecode(text: string, fps: number): number | null`
  returning flicks. Accepted forms:
  - colon-separated fields read right-to-left as FF, SS, MM, HH
    ("00:01:02:12", "1:02:12", "02:12", "12")? NO — a single bare token is
    digits-run form below; colon forms need ≥2 fields.
  - bare digit runs parsed as right-to-left pairs into FF,SS,MM,HH
    ("1234" → 12s 34f; "90" → 90f).
  - Overflow normalizes via frame math (90f @ 30fps → 3s 0f).
  - Whitespace trimmed; anything else (letters, negative, empty) → null.
  Keep it pure; clamping to [0, duration] happens at call sites.
- ViewerPanel + SequencePlayer: clicking the timecode swaps it for a
  monospace `<input data-testid="timecode-input">` prefilled with the current
  timecode, text selected. Enter → parse; valid → seek (source: media seek
  path; sequence: seekSequence) and close. Escape or blur → close, no seek.
  Invalid → input stays open with an error style (red flash/shake class),
  no seek.
- The existing shortcuts.ts focus guard (HTMLInputElement) already suppresses
  single-key shortcuts while the input is focused — add an E2E assertion, not
  new code, unless a gap is found.
- Unit tests: src/shared/timecode.test.ts (or extend existing) enumerating
  every accepted form, overflow, garbage → null.
- E2E (ux-controls.spec.ts): type a known timecode into the sequence
  transport, assert playhead timecode reads it back; Escape cancels; garbage
  leaves playhead unmoved; typing 'l' inside the input does NOT start
  playback.

## Acceptance criteria

1. `parseTimecode` exists in src/shared/timecode.ts and unit tests cover: full HH:MM:SS:FF, short colon forms (right-to-left field order), bare digit pairs, overflow normalization, garbage/empty/negative → null. All pass.
2. Clicking the sequence timecode opens `timecode-input` prefilled + selected (E2E).
3. Enter with a valid timecode seeks the sequence playhead to it (E2E reads the displayed timecode back).
4. Escape closes the input without seeking (E2E).
5. Invalid input keeps the input open with error styling and the playhead unmoved (E2E).
6. Single-key shortcuts are suppressed while the input is focused (E2E: 'l' typed in the input does not change playing state).
7. Source viewer timecode behaves the same for media seeking (E2E), and all 5 mandatory commands exit 0.

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

- parseTimecode unit test output; E2E output for seek-by-typing, cancel, and invalid-input cases
