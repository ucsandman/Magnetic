SUPERGOAL_PHASE_START
Phase: 8 of 11 — Transitions, titles, color & audio
Task: Shader transitions (dissolve/wipes/fade), title system with presets, color board, audio fades/pan, full Inspector
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 8
Evidence required: command outputs, pixel-assert numbers, screenshots
Depends on phases: 7

## Why

Dissolves, titles, and the color board take the timeline from cuts-only to a real FCP-style edit.

## Work

- Kernel `src/shared/timeline/transitions.ts`: `Transition { id, editPointIndex, durationFlicks, kind: 'dissolve'|'wipeL'|'wipeR'|'fadeBlack' }` attached to spine edit points; duration clamped to available media handles on both sides (if either side lacks handles, clamp and report); ops add/remove/resize with inverses; render-time helper `transitionAt(timeFlicks)` returning {a, b, progress, kind}. Unit tests incl. undo + clamping.
- Compositor: during a transition window decode BOTH clips (scheduler already pre-rolls next clip); blend pass per kind in GLSL — dissolve = mix(a,b,p); wipes = step edge with 2 px smooth; fadeBlack = a→black→b. Timeline UI: transition drawn as overlap badge at edit point; add via Cmd/Ctrl+T (default 1 s dissolve on selected edit point) + right-click menu for kind; drag edges to resize; Del removes.
- Color board (per clip, stored in `clipFx`): exposure (−1..+1), contrast, saturation (0..2), temperature (−1..+1 warm/cool) applied in the clip's fragment shader (order: temp → exposure → contrast → saturation); Reset button. All undoable.
- Titles `src/renderer/titles/`: title = ConnectedClip with `titleData { text, font, sizePx, color, x, y, preset }`. Render text to offscreen 2D canvas → texture, composited like video. Presets: Basic (centered), Lower Third (left-lower, bar accent), Bumper (large centered, fade in/out baked). Browser gets a "Titles" tab; drag preset to timeline connects it.
- Audio: fade in/out handles (drag rounded handles at clip audio edges → fadeInFlicks/fadeOutFlicks on clip), gain ramps via linearRampToValueAtTime in the audio graph; pan via StereoPannerNode; volume slider (−96..+12 dB) + pan knob in Inspector Audio tab. Unit test: building the graph for a clip with fades yields the expected gain automation points.
- Inspector: tabs Video (P7) / Color / Audio / Title (when title selected), bound to selection, live updates, all changes undoable (group per drag gesture).
- `e2e/effects.spec.ts` per criteria; screenshot diff helper (pixel count above threshold) for the title test.

## Acceptance criteria (all must pass — verify each in transcript)

- Cross dissolve at a cut: mid-transition sampled pixel is a blend (neither pure clip A nor pure clip B color, numeric assert)
- Wipe and fade-to-black each verified by pixel asserts at characteristic times
- Title preset renders text over video (screenshot diff vs no-title baseline exceeds threshold)
- Exposure +1 measurably brightens a sampled pixel; saturation 0 grays it (numeric asserts)
- Audio fade-in produces a rising gain envelope (unit test on audio-graph parameters)
- Kernel transition ops (add/remove/resize/undo) unit-tested, handles clamped to available media
- Inspector tabs bind to selection and update live (E2E)
- All mandatory commands exit 0

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; pixel-assert numbers; screenshots in `.supergoal/evidence/phase-8/` (transition mid-frame, title, inspector)

## Notes

- Transition needs media handles: fixtures are trimmed-in by default in the test setup so handles exist; the clamp path gets its own test with handle-less clips.
- Saturation-0 gray assert: sampled R≈G≈B within ±6.
- Title canvas: render at 2× and downscale for crisp text; measure text to auto-wrap at 80% width.
- Keep all effect params in `clipFx` (one persisted map) so P9 export replay picks them up for free.
