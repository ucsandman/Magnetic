# Long-form pipeline: stream everything, re-encode nothing

_Approved 2026-06-12. Target workload: 6-hour OBS H.264 recordings edited into
full-length VODs with a looped lofi music bed. Foundation already shipped: the
streaming WebCodecs demuxer (4087695), streamed audio envelopes, loopback HTTP
media serving with Range support._

## Pillar 1 — Windowed audio playback (required: 6h currently cannot play)

`audio-graph.ts` (and `offline.ts`) fetch the entire PCM wav and
`decodeAudioData` it in one call — ~2 GB for 6 hours; allocation fails. Wav PCM
is random-access by construction: byte offset = header + sampleIndex ×
blockAlign.

- New `src/renderer/playback/pcm-source.ts`: parse the wav header once via a
  small Range fetch (fmt chunk → sampleRate/channels/bitsPerSample; locate the
  `data` chunk offset/length), then `windowBuffer(fromSec, durSec)` Range-
  fetches exactly those PCM bytes and builds an AudioBuffer directly (no
  decodeAudioData). Cache the header per URL.
- Audio graph: clips whose scheduled span exceeds ~120 s switch from the
  current one-buffer path to just-in-time windows (~10 s, double-buffered
  ahead of the AudioContext clock, scheduled with the same start-time math).
  Short clips keep the existing single-buffer path (zero risk to current
  behavior, which all existing tests pin).
- Same treatment for the export/offline audio path (see pillar 2 — it renders
  in chunks anyway).
- Verification: existing playback drift + audible-RMS E2E stay green; real
  10 GB library clip plays with audio, renderer RSS bounded (diag harness).

## Pillar 2 — Smart-render export (video passthrough)

Full-VOD exports re-encode 648k frames the user never touched. When the video
track is "the source, possibly trimmed", stream-copy it.

- Pure eligibility detector `src/shared/timeline/smart-render.ts`:
  `smartRenderPlan(sequence): { assetId, mediaInFlicks, durationFlicks } | null`.
  Eligible iff: spine clips all from ONE asset, in order, media-contiguous
  (equivalent to a single trim), no gaps/transitions/titles/connected VIDEO
  clips, captions disabled, every video/color fx identity (and no kf), spine
  audio may be disabled/detached. Connected AUDIO clips (music) are fine.
  Unit-test the matrix.
- Export flow (main + renderer):
  1. Renderer renders the MIXED audio in OfflineAudioContext chunks (~60 s,
     sequential, reusing collectAudioJobs semantics incl. loop tiling), writes
     Int16 PCM chunks over IPC to main, which writes a temp wav
     (`cache/export-mix.wav`, ~2.5 GB for 6 h — disk, not memory).
  2. Main runs one ffmpeg: `-ss <in> -t <dur> -i source -i mix.wav
     -map 0:v -c:v copy -map 1:a -c:a aac -movflags +faststart out.mp4`.
     `-ss` before `-i` snaps to keyframes for copy — acceptable (±1 s of GOP
     slack at the head for v1; document it).
  3. ExportDialog shows a "Smart render — video passthrough" note when the
     plan is non-null; anything else falls back to the existing WYSIWYG
     pipeline automatically. Progress = audio-render fraction then ffmpeg
     `-progress` time.
- E2E: eligible sequence from a fixture exports via passthrough (ffprobe:
  video stream parameters identical to source, audio present, duration
  correct); adding a keyframed fx makes the plan null and the normal pipeline
  runs (existing export spec already covers it).

## Pillar 3 — Music bed: loop-to-fill

- `ConnectedClip.loop?: boolean` (model + zod schema — remember: z.object
  strips undeclared keys on saveSequence). New kernel op `setConnectedLoop`
  (total function, undoable) plus duration stretch via existing trimConnected.
- Context menu on a connected audio clip: "Loop to End of Spine" — one undo
  group: set loop + tail-trim duration to reach spine end (trimConnected clamp
  vs sourceDuration must be bypassed for loop clips: trimConnected allows
  duration > source when loop is set).
- Audio graph + offline/export mix: looped clips tile their source (media time
  = offset modulo sourceDuration), gain/fades apply to the whole span.
- `clipWindows` (transcript/silence projection) SKIPS loop clips — music is
  not speech and its media math would wrap.
- Timeline render: subtle repeat tick at each loop seam on the clip.
- E2E: loop a short fixture across a longer spine, assert audible RMS in a
  window beyond the source duration; silence panel unaffected.

## Pillar 4 — Scale guards

- Auto-transcribe skips assets longer than 30 min (whisper on 6 h = hours of
  CPU); the per-asset Transcribe action still works and logs an honest
  estimate. Sidebar checkbox label notes the cutoff.
- Import hardlinks instead of copies when source and library share a volume
  (`linkSync`, fall back to `copyFileSync` on any error — cross-volume,
  permissions, FAT). Delete keeps working: rm on a hardlink leaves the
  original untouched.
- GUIDE.md: long-form section (what scales, PCM cache size note, smart-render
  conditions).

## Out of scope (deliberate)

Segment-level smart render (re-encode only edited spans + concat), audio
ducking, retiming. Each is a clean follow-on.

## Build order

1 (audio windows) → 2 (smart render) → 3 (loop) → 4 (guards) → UI polish pass
(impeccable + polish skills, Apple-finish detail).
