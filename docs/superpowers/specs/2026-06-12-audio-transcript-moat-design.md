# Audio/transcript moat: natural silence cuts, transcript search, no transcribe cap — design

Date: 2026-06-12
Status: approved (brainstormed with user; research-backed)

## Problem

Market research (June 2026, two web-research passes over Descript, Gling,
Recut, Timebolt, CapCut, Resolve, Premiere, FCP user sentiment) shows
Magnetic's strongest position is its local, unmetered audio/transcript
pipeline. Three documented user pains in this exact area remain:

1. **Robotic silence removal.** The #1 complaint about automated dead-air
   cutters is over-aggressive hard joins that "mess with natural cadence."
   The respected fix is sensitivity controls (we have them), keeping short
   natural pauses, and restoring individual cuts before applying (we have
   neither). Our `paddingMs` control already preserves room tone, but it is
   indirect (per-side inset) and there is no per-cut opt-out.
2. **"Find where I said X."** VOD and podcast editors name moment-finding in
   hours of footage as a core pain. The browser search matches `fileName`
   only; transcripts are already on disk per asset but unsearchable outside
   the current sequence's transcript panel.
3. **Auto-transcribe skips assets over 30 minutes** — backwards for a product
   whose pitch is long-form. The cap exists to protect the shared 2-slot job
   queue from hour-long whisper runs, not because long files can't transcribe.

## Assumptions

- "Natural pause" is achieved by keeping the speaker's *real* recorded room
  tone (shrinking the deletion range), not by synthesizing room tone — no
  playback-engine or export changes.
- Per-cut exclusions reset when detection parameters change (the ranges they
  referenced no longer exist).
- Transcript search is event-scoped, matching the existing browser model;
  a library-wide palette was considered and deferred.
- Whisper memory (~1.4 GB peak for a 6-hour file) and the temp WAV (~700 MB)
  are acceptable for a background lane and get documented, not engineered
  around.

## Design

### 1. Silence removal: keep-pause + per-range exclude

**Keep-pause control** (`src/renderer/silence/SilencePanel.tsx`,
`src/renderer/silence/detect.ts`):

- Replace the "Padding" control with **"Keep pause"**: the total silence
  retained at each cut. Range 0–1000 ms, default 250 ms; 0 ms reproduces a
  hard join.
- Internally maps to the existing inset math: each detected range is shrunk
  by `keepPauseMs / 2` per side before becoming a deletion range. Ranges
  whose duration is ≤ `keepPauseMs` are dropped (nothing to delete).
- Detection algorithm, preview bands, `rippleDeleteRange` batch apply, and
  the single undo step are unchanged.

**Per-range exclude** (`timeline-store.ts`, `timeline/render.ts`,
`SilencePanel.tsx`):

- Detected ranges get stable ids (index within a detection run) and an
  `excluded: boolean` in the store's silence-preview state.
- Clicking a preview band on the timeline toggles exclusion; excluded bands
  render dimmed.
- The panel summarizes "N cuts · M excluded"; Apply deletes only included
  ranges. Parameter changes re-run detection and clear all exclusions.

### 2. Browser search matches transcripts

(`src/renderer/browser/BrowserPanel.tsx`, `src/renderer/transcript/cache.ts`)

- When the event search query is active (≥ 2 chars), transcripts for the
  event's assets load lazily through the existing `ensureTranscripts()`
  cache. Per asset, words flatten once into a memoized lowercase searchable
  string plus a char-offset → word-index map.
- Match = case-insensitive substring across word boundaries, debounced
  ~200 ms. An asset matches if its `fileName` or its transcript matches
  (fileName behavior unchanged).
- Matched assets stay in the filmstrip grid; beneath each, up to 3 **snippet
  chips** show the hit in context with the word's source timecode.
- Clicking a chip opens the asset in the source viewer seeked to the word's
  `startFlicks` (reuses the transcript panel's word-seek path).
- Assets with no transcript, or a failed one, silently fall back to
  fileName-only matching.

### 3. Lift the 30-minute auto-transcribe cap + dedicated job lane

(`src/main/app-state.ts`, `src/main/jobs/`)

- Delete the `AUTO_TRANSCRIBE_MAX_FLICKS` check in `enqueueAssetJobs()`:
  every audio-bearing import auto-transcribes when the setting is on.
- Add a second `JobQueue` instance with concurrency 1 used **only** for
  transcription; filmstrip/waveform/envelope/proxy stay on the existing
  2-slot queue. Manual `transcribe:run` routes to the same lane. A 4-hour
  whisper run (~20–30 min CPU) no longer starves thumbnail generation.
- Existing per-asset processing badge covers progress; transcribe failures
  already persist an error on the asset.

### 4. Docs

- README: remove the 30-minute known-limitation line; replace with the
  whisper memory note for very long files. Feature list gains keep-pause,
  per-cut exclude, and transcript search in the browser.
- `docs/GUIDE.md`: update the silence-removal and search workflow sections.

## Error handling

- Keep-pause never produces negative-length deletions (ranges ≤ keep-pause
  are dropped before apply).
- Transcript fetch failures during search degrade to fileName matching; no
  error UI beyond the existing transcript error states.
- Transcription job failures behave exactly as today (persisted
  `transcriptError`, badge in browser), regardless of duration.

## Testing

- **Unit** (vitest): keep-pause shrink math (normal, exactly-equal, shorter
  ranges); exclusion filtering of the apply set; search index construction
  and char-offset → word mapping; enqueue decision no longer caps on
  duration.
- **E2E** (Playwright): silence panel — detect, click one band to exclude,
  apply, verify the excluded gap survives and one undo restores everything;
  browser — search a transcript word from fixtures, click the snippet,
  verify the source viewer opens at the expected timecode.
- **Gates**: `npm run typecheck`, `lint`, `test`, `build`, `test:e2e` green.

## Out of scope (this round)

- Room-tone synthesis; playback that auditions cuts by skipping ranges.
- Library-wide search palette across events.
- Voice cleanup / studio-sound (next round's flagship; needs a new native
  model dependency).
- Chunked/streaming whisper for memory reduction on 6-hour-plus files.
