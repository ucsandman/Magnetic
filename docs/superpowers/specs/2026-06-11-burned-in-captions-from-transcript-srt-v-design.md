# Burned-in captions from transcript + SRT/VTT export

_Tournament-selected 2026-06-11. Effort ~6 engineer-days._

## Spec

Add an optional sequence-level `captions?: CaptionSettings` field to `Sequence` in src/shared/timeline/model.ts ({ enabled, preset: 'pop-in' | 'karaoke' | 'block', font, sizePx, color, highlightColor, position: 'bottom' | 'middle' | 'top' }), mutated through a new pure kernel op `setCaptionSettings` in src/shared/timeline/ops.ts so toggling/styling is undoable via the existing UndoStack and persists automatically through the debounced `saveSequence` IPC (library.ts stores the sequence JSON verbatim, so no migration is needed — the field is optional). Captions are never stored as clips: a new pure module src/renderer/captions/cues.ts groups the output of the existing `projectTranscript(sequence, transcripts)` (src/renderer/transcript/projection.ts) into cues (break on >0.6 s word gap or ~32-char line budget), so every blade/trim/ripple/edit-by-transcript edit re-derives cues for free — the exact composition guarantee TranscriptPanel already relies on. The transcript fetch logic currently inlined in TranscriptPanel.tsx (fetch `asset.transcriptUrl`, cache by assetId) is extracted into src/renderer/transcript/cache.ts and shared by the panel and the playback engine. Rendering piggybacks on the title pipeline: a new `renderCaption(cue, settings, activeWordIndex)` in src/renderer/captions/render.ts mirrors `renderTitle` (offscreen 2D canvas at 2x, full 1920x1080 frame with transparency); karaoke draws the word containing tSec in highlightColor, pop-in draws only words up to tSec, block draws the whole cue. In PlaybackEngine (src/renderer/playback/engine.ts), `play`, `renderStill`, and `exportReplay` (all already async) await the transcript cache when `sequence.captions?.enabled`, precompute the cue list once, and `assembleLayers` appends one extra `CompositedLayer { slot: '__captions__', frame: null, image: canvas }` painted last — the same canvas-texture upload path `titleLayer` uses, cached by `cueIndex:activeWordIndex` with the existing uploadedHash pattern. Because `exportReplay` shares `assembleLayers`, burn-in export is WYSIWYG by construction with zero export-specific rendering code. UI surface: InspectorPanel gains a 'Captions' tab (enable checkbox, style preset, font/size/color/highlight/position fields) calling a new `setCaptions` store action in timeline-store.ts, mirroring the existing `TitleFields` pattern; the viewer updates immediately since stills re-render on sequence change. Sidecar export: pure serializers `toSrt(cues)` / `toVtt(cues)` in src/renderer/captions/format.ts (flicks→HH:MM:SS,mmm math, vitest-tested exactly), and ExportDialog.tsx adds a 'Captions sidecar: None/.srt/.vtt' select; after `exportFinish` the renderer serializes and calls a new `captions:writeSidecar` IPC (channels.ts → ipc.ts handler doing fs.writeFile next to the mp4 → preload), the only main-process change. Unit tests follow ops.test.ts/projection.test.ts conventions for the op, cue grouping, and both serializers; a new e2e/captions.spec.ts follows transcript.spec.ts conventions.

## Surfaces

- src/shared/timeline/model.ts
- src/shared/timeline/ops.ts
- src/shared/timeline/ops.test.ts
- src/renderer/captions/cues.ts (new)
- src/renderer/captions/cues.test.ts (new)
- src/renderer/captions/format.ts (new)
- src/renderer/captions/format.test.ts (new)
- src/renderer/captions/render.ts (new)
- src/renderer/transcript/cache.ts (new, extracted from TranscriptPanel)
- src/renderer/transcript/TranscriptPanel.tsx
- src/renderer/playback/engine.ts
- src/renderer/state/timeline-store.ts
- src/renderer/layout/InspectorPanel.tsx
- src/renderer/export/ExportDialog.tsx
- src/shared/channels.ts
- src/shared/ipc.ts
- src/main/ipc.ts
- src/preload/index.ts
- e2e/captions.spec.ts (new)
- docs/GUIDE.md

## E2E plan

New e2e/captions.spec.ts using the established transcript.spec.ts harness: launch the built app with MAGNETIC_TEST=1 and a temp .mglib, import fixtures/speech.wav via window.api.__test.importPaths, waitForFunction until the asset's transcriptUrl appears (whisper job done) and __magneticState().sequence is loaded. (1) Enable captions via the Inspector Captions tab (data-testid clicks), seek the playhead to a known word's seqStartFlicks read from the transcript-word DOM data-start attribute, then prove burn-in pixels with the existing __magneticTimeline.playback.readPixels hook: sample the caption band (bottom-center rows of the 1920x1080 framebuffer) and assert non-background pixels appear with captions enabled and disappear when disabled — the exact pixel-proof pattern playback.spec.ts uses. (2) Ripple test: select and Delete the first words in the transcript panel, then assert via __magneticState that the remaining words' data-start values shifted left and the caption pixel test still passes at the new time — proving cues re-projected through the edit. (3) Sidecar test: open Export (Ctrl+E), set destination in a temp dir, pick '.srt' sidecar, run the export to completion (export.spec.ts already does full exports against fixtures), then read the written .srt with fs and assert exact cue text and HH:MM:SS,mmm timestamps computed from the same fixture word timings; repeat the assertion shape for .vtt (WEBVTT header, dot separator). Serializer and cue-grouping correctness is additionally pinned by pure vitest tests so the e2e only has to prove wiring.

## Risks

(1) Engine now depends on transcript JSON fetches: play()/renderStill() must not block first frame on a cache miss — mitigate by prefetching on project load and rendering captions only once cached (they pop in, video never stalls). (2) Karaoke re-rasterizes a full-frame 2x canvas on every word change (~3/sec) and re-uploads an ~8 MB texture; the titleLayer path shows this is fine, but verify no dropped frames in the drift report during the e2e; fallback is rendering at cue granularity with a two-pass highlight. (3) projectTranscript drops words not fully inside a clip's media window, so captions silently omit words straddling cuts — same known behavior as the transcript panel, should be documented in GUIDE.md. (4) Cue-grouping heuristics (gap/line-length) are subjective; keep them simple and pin them with unit tests so they are at least deterministic. (5) The whisper-dependent e2e is slow (transcript.spec.ts already sets a 300 s timeout) — reuse its single-app-launch structure to keep CI time bounded. (6) Captions paint above connected title lanes (slot painted last); if a user wants titles above captions there is no ordering control in v1 — acceptable, note it.
