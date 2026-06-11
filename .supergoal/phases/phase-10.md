SUPERGOAL_PHASE_START
Phase: 10 of 11 — Edit-by-transcript
Task: Local Whisper transcription with word timestamps; transcript panel; delete-text-to-cut; filler-word removal; search
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 9
Evidence required: command outputs, word-accuracy number, delete-to-cut numeric proof, screenshot
Depends on phases: 3, 6

## Why

The chosen improvement — the headline capability FCP lacks: edit video by editing text, fully local.

## Work

- `src/main/transcribe/`: job (background queue from P2): ffmpeg → mono 16 kHz WAV → whisper.cpp CLI with word-level timestamps (use the JSON output mode; verify the current flag set of the pinned whisper build — e.g. `-ojf`/`--output-json-full` — at implementation time) → normalize to `Transcript { words: [{ text, startFlicks, endFlicks, p }] }` stored in `.mglib/cache/transcripts/<assetId>.json` + referenced from MediaAsset. Trigger: automatic on import for assets with audio (toggleable in a small settings pane), plus right-click → Transcribe.
- `src/renderer/transcript/`: panel (toggle Ctrl+Shift+T, docked left below browser or as browser tab). Shows the TIMELINE transcript: for each spine/connected clip with a transcript, map word times through (mediaIn, duration, derived position) into sequence time; concatenated with clip boundary markers. Current word highlights during playback; click word → seek playhead to word start.
- Text selection ↔ timeline: selecting words shows the corresponding range on the timeline (reuse range selection rendering); inverse: timeline range selection highlights words.
- Delete-text-to-cut: Delete/Backspace on a word selection → compute the sequence-time ranges (merge adjacent, split at clip boundaries) → kernel `rippleDelete`-by-range inside ONE undo group (this needs a `rippleDeleteRange(fromFlicks, toFlicks)` kernel op — add it with unit tests: blades at both ends then ripple-deletes the middle clips). Transcript panel re-derives automatically from the new sequence (it is a projection, never a second source of truth).
- Filler words: detector flags list matches (`um, uh, er, ah, like, you know, sort of, kind of` — standalone-word match, case-insensitive; `like` only when p < threshold OR surrounded by pauses ≥200 ms to cut false positives... keep simple heuristic, document it); rendered dimmed-orange. "Remove all fillers" button → one undo group of rippleDeleteRange ops processed back-to-front (so earlier ranges stay valid).
- Search: input filters/highlights matches, Enter cycles + seeks playhead.
- Accuracy harness (vitest, tagged integration): transcribe `speech.wav` (TTS fixture with known `fixtures-script.txt`), compute word-level accuracy = 1 − WER (normalize case/punctuation); assert ≥0.70. If base.en < 0.70, switch pinned model to small.en (pre-approved) and note in STATE.md.
- `e2e/transcript.spec.ts` per criteria (build a small sequence from speech.wav segments first).

## Acceptance criteria (all must pass — verify each in transcript)

- TTS fixture transcription matches the known script at ≥70% word accuracy (automated WER-style check; bump model to small.en if base.en falls short — assumption pre-approved)
- Clicking a word seeks the playhead within ±100 ms of the word's start (E2E)
- Deleting a sentence shortens the sequence by that sentence's duration ±1 frame AND removes those words from the panel (E2E numeric assert)
- One undo restores both timeline and transcript exactly after a text deletion (E2E)
- "Remove all fillers" removes every list-match in one step; undo restores all (E2E)
- Transcript search highlights matches and jumps the playhead (E2E)
- Transcription runs as a background job; UI remains interactive during it (E2E)
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-10/transcript.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; accuracy number; before/after sequence durations for delete-to-cut; `.supergoal/evidence/phase-10/transcript.png`

## Notes

- The TTS script should avoid proper nouns and include 3+ deliberate fillers ("um", "uh", "you know") so the filler test has real targets — write `fixtures-script.txt` accordingly in P1 (already specced there; if it lacks fillers, amend it here and regenerate).
- Whisper timestamps are seconds-floats — convert to flicks once at normalize time.
- Word→sequence-time mapping must respect clips whose mediaIn cuts mid-word: drop words not fully inside the clip's media range.
- rippleDeleteRange back-to-front processing is load-bearing for "remove all fillers"; property-test it (random ranges, invariants hold).
- Run whisper at `--threads max(2, cores-2)` to keep UI responsive; it's a background job either way.
