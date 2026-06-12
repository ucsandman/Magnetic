# Magnetic — Feature Tournament Slate (2026-06-11)

Tournament: 7 ideation lenses, 4-judge panel, feasibility scouts on top 10, committee selection.

## Selected (build order)

1. [Keyframe animation of video parameters](2026-06-11-keyframe-animation-of-video-parameters-design.md) — ~5d
2. [Expand/detach audio + split edits (J-cuts / L-cuts)](2026-06-11-expand-detach-audio-split-edits-j-cuts-l-design.md) — ~4d
3. [Clip copy/paste, duplicate, and Paste Attributes](2026-06-11-clip-copy-paste-duplicate-and-paste-attr-design.md) — ~4d
4. [Auto silence removal (dead-air cutter / one-click jump-cut)](2026-06-11-auto-silence-removal-dead-air-cutter-one-design.md) — ~3d
5. [Burned-in captions from transcript + SRT/VTT export](2026-06-11-burned-in-captions-from-transcript-srt-v-design.md) — ~6d

## Committee rationale

Selection logic: maximize editing power per day while keeping the five buildable in sequence (~22 effort-days) with minimal shared file surface, and explicitly excluding the one finalist that conflicts with everything.

WHY THESE FIVE:
1. Keyframe animation (8.75, 5d) — top judge score and the highest power-to-risk ratio. Media-time anchoring means zero kernel changes; the new pure fx-eval.ts module plus a one-line swap in assembleLayers gives preview AND export WYSIWYG for free. Verified: ClipFx is already optional on both clip types, so persistence is free.
2. Detach audio + split edits (7.63, 4d) — J/L cuts are core NLE editing power that no other finalist provides. Small kernel surface (two total-function ops), one-line audio-graph change, and export inherits via collectAudioJobs. Its lane:-1 mechanism is plain data the other features don't touch.
3. Copy/paste + Paste Attributes (7.75, 4d) — table-stakes editing power; an editor without Ctrl+C/V isn't real. I verified the load-bearing claim: connectAt (ops.ts:270-281) genuinely drops fx, and fixing it benefits detach/keyframes interop too. Session-only clipboard = zero persistence risk.
4. Auto silence removal (7.75, 3d) — best value-per-day in the slate. Almost entirely new files (main-process envelope job + pure detect.ts + panel); the cut itself reuses the shipped deleteRanges/rippleDeleteRange path byte-identical to filler removal. Near-zero overlap with the other four.
5. Burned-in captions + SRT/VTT (8.38, 6d) — third-highest score, huge real-world value (social-video burn-in + sidecar export), and architecturally parasitic on proven systems: projectTranscript for cue derivation (edits re-derive cues for free) and the titleLayer canvas-texture path for rendering.

WHY NOT RETIMING (8.63): it is the one feature that overlaps everything — 23 files spanning kernel math (ops/transitions/invariants), all 5 media-time mapping sites in engine.ts (the exact lines keyframes touches), audio-graph/offline, render, canvas, plus a new ffmpeg atempo IPC chain. At 7d it would push the slate to ~25d and force rate-awareness into keyframe evaluation mid-push. It's the right NEXT feature, built alone on top of this slate. Range selection, gain-line, multi-project, and ducking all scored lower and either duplicate value delivered here (silence removal covers the main deleteRanges use case; keyframes covers animation) or are organization rather than editing power.

OVERLAP BETWEEN THE FIVE: pairwise file intersection is small — keyframes/captions share engine.ts (different functions: fx evaluation in assembleLayers vs an appended caption layer); detach/copy-paste share ops.ts + TimelineCanvas (disjoint ops; disjoint interaction modes); silence removal shares almost nothing. No two features edit the same function.

BUILD ORDER (foundations first):
1. Keyframes — establishes ClipFx extension pattern + the engine fx-evaluation seam everything else composes with; later clipboard copies and detached clips carry kf data for free.
2. Detach audio — kernel ops + lane:-1 audio while ops.ts context is hot; lands the negative-offset regime before clipboard snapshots connected clips.
3. Copy/paste — the connectAt fx fix now preserves keyframed fx AND detached-audio fx on paste; clipboard payload's lane field covers lane:-1 clips from step 2.
4. Silence removal — independent main-process + new-module work; a good decoupled slot while the timeline surface settles, reusing deleteRanges untouched by steps 1-3.
5. Captions — last because it has the slowest E2E (whisper, ~300s timeout) and touches engine.ts after the keyframe changes there are stable; its sidecar IPC is the only main-process IPC addition in the slate, isolated at the end.

## Full ranking

- Keyframe animation of video parameters: 8.75
- Clip retiming: speed, slow-mo, freeze frames, speed ramps: 8.63
- Burned-in captions from transcript + SRT/VTT export: 8.38
- Auto silence removal (dead-air cutter / one-click jump-cut): 7.75
- Clip copy/paste, duplicate, and Paste Attributes: 7.75
- Expand/detach audio + split edits (J-cuts / L-cuts): 7.63
- Timeline range selection + three-point editing (R tool): 7.25
- Keyframed volume automation drawn on the clip (rubber-band gain line): 7
- Multi-project and multi-event organization (project browser): 7
- Auto music ducking (transcript-driven) + music-bed workflow: 6.88
- Vertical & multi-aspect delivery (Shorts mode): 6.63
- Markers and timeline chapters: 6.38
