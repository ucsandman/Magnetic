# Auto silence removal (dead-air cutter / one-click jump-cut)

_Tournament-selected 2026-06-11. Effort ~3 engineer-days._

## Spec

A new main-process job `generateAudioEnvelope` (src/main/jobs/audio-envelope.ts, mirroring generateWaveform's spawn-ffmpeg decodePcm at 8 kHz mono) computes RMS in fixed 50 ms windows and writes cache/envelope/<assetId>.json ({ windowMs: 50, rmsDb: number[] }, ~500 KB/hour); it is enqueued in app-state.ts enqueueDerivatives alongside the waveform job when asset.audio exists, MediaAsset gains envelope?: { envelopePath: string } and AssetView gains envelopeUrl (same mfile:// mapping as waveform.url in library.ts). Doing one decode up front means threshold tuning never re-runs ffmpeg — the renderer re-thresholds the cached envelope instantly. A pure renderer module src/renderer/silence/detect.ts exports detectSilence(sequence, envelopes, { thresholdDb (default -34 dB), minDurationFlicks (default 0.5 s), padFlicks (default 100 ms) }): TimeRange[] — it reuses the clipWindows projection from transcript/projection.ts (export it) to walk each clip's [mediaIn, mediaIn+duration] slice of its asset envelope, finds runs below threshold lasting ≥ minDuration, insets each run by padFlicks on both ends (padding only shrinks, so speech onsets are never clipped), and emits sequence-time ranges sorted ascending; vitest-covered like projection.test.ts. UI: a SilencePanel (src/renderer/silence/SilencePanel.tsx) hosted next to TranscriptPanel with threshold/min-gap/padding sliders, a reviewable list of detected gaps (start, duration, per-row checkbox to exclude, click row → setPlayhead seek, exactly the transcript word-click pattern), and a "Cut N gaps" button. While the panel is open, candidate ranges are pushed to a new silenceRanges: TimeRange[] | null field in timeline-store and drawn as translucent bands in render.ts using the same timeToX band code as the existing selection.range at line 466. The cut button calls the existing useTimelineStore deleteRanges(ranges) verbatim — beginGroup → rippleDeleteRange per range back-to-front → endGroup — so one Ctrl+Z restores everything, byte-identical to the shipped Remove-fillers UX; connected clips reattach via rippleDeleteRange's existing reattachByTime. Detection only runs over clip windows whose asset has an envelope (titles, gaps, and silent-import assets are skipped). No IPC additions needed beyond the asset field: the envelope arrives through the existing library snapshot broadcast and is fetched by URL the same way TranscriptPanel fetches transcriptUrl.

## Surfaces

- src/main/jobs/audio-envelope.ts (new, mirrors src/main/jobs/waveform.ts)
- src/main/app-state.ts (enqueue envelope job next to waveform at line ~184)
- src/shared/types.ts (EnvelopeInfo on MediaAsset, envelopeUrl on AssetView)
- src/main/project-io/library.ts (AssetView mfile:// URL mapping for envelope)
- src/renderer/silence/detect.ts + detect.test.ts (new, pure detection)
- src/renderer/transcript/projection.ts (export clipWindows)
- src/renderer/silence/SilencePanel.tsx (new review panel)
- src/renderer/state/timeline-store.ts (silenceRanges field + setter; deleteRanges reused as-is)
- src/renderer/timeline/render.ts (draw candidate gap bands, same path as selection.range at line 466)
- renderer panel host where TranscriptPanel mounts + src/renderer/styles/global.css
- e2e/silence.spec.ts (new) + ffmpeg-generated fixture

## E2E plan

Mirror e2e/transcript.spec.ts conventions exactly: generate a deterministic fixture in test setup via the bundled ffmpeg (sine tone 2 s + true silence 1.5 s + tone 2 s, lavfi concat), launch with MAGNETIC_TEST=1 and a temp .mglib, importPaths the fixture, append with 'e', then page.waitForFunction until getLibrary() shows envelopeUrl on the asset. Open the silence panel, expect the detected-gap list to show exactly 1 row and the store's silenceRanges (via __magneticState) to span ~1.5 s minus 2×100 ms padding. Record totalDuration (sum of spine durationFlicks), click "Cut 1 gap", assert duration shrank by the listed range span ±1 frame (FRAME_FLICKS tolerance, same as the transcript delete assertion), then press Ctrl+Z once and assert totalDuration is byte-equal to the before value — proving single-group undo. Bonus assertions: drag the threshold slider to -90 dB and expect 0 rows (tunability), and re-open the panel after the cut to expect no remaining gaps.

## Risks

1) Envelope granularity: 50 ms RMS windows can disagree with ffmpeg silencedetect near fades — acceptable for jump-cuts, and the threshold slider absorbs it; document the heuristic like markFillers does. 2) Many tiny ranges: deleteRanges runs rippleDeleteRange once per range (each O(spine)); hundreds of gaps in a long talk is fine, but pathological thresholds could yield thousands — clamp by enforcing minDuration ≥ 0.25 s in the UI. 3) Transitions/connected clips overlapping a cut: rippleDeleteRange's ensureBoundary + reattachByTime already handle this (same exposure as shipped filler removal), but the e2e fixture should not exercise transitions in v1. 4) Stale candidates: silenceRanges must be cleared on any sequence edit (subscribe to sequence changes) or the overlay/list can reference dead time — easy but forgettable. 5) Envelope job adds one more ffmpeg decode per imported asset (queue concurrency 2); negligible for short media, ~seconds for hour-long files, runs in background like waveform. 6) Authored spine gaps (kind 'gap') are intentionally skipped — users may expect them detected; note in the panel copy.
