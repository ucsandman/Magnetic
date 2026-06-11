SUPERGOAL_PHASE_START
Phase: 9 of 11 — Export
Task: WYSIWYG export — headless compositor replay piped as rawvideo to ffmpeg with OfflineAudioContext mixdown, presets, progress, cancel
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 8
Evidence required: command outputs, ffprobe output of exported file, WYSIWYG diff number, screenshot
Depends on phases: 7, 8

## Why

An NLE that can't deliver a file isn't an NLE; WYSIWYG export proves the whole pipeline end to end.

## Work

- `src/renderer/playback/offline.ts`: deterministic replay — for frame i of N at sequence fps, set virtual clock to i·frameFlicks, drive scheduler synchronously (await decode of exact frame, no real-time queue), composite (full pipeline: transforms, transitions, color, titles), `readPixels` RGBA → transferable buffer → IPC to main. Backpressure: renderer awaits main's "need next" pull so ffmpeg stdin never floods memory.
- Audio mixdown: rebuild the sequence audio graph inside an `OfflineAudioContext` (same code path as live via a context-injection seam), `startRendering()` → AudioBuffer → 16-bit WAV bytes → temp file.
- `src/main/export/`: spawn ffmpeg with `-f rawvideo -pix_fmt rgba -s WxH -r fps -i pipe:0 -i mix.wav -map 0:v -map 1:a -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac out.mp4`; write frames to stdin; parse `-progress pipe:2` (or frame count) → progress IPC. Cancel: kill ffmpeg, delete the in-progress temp output (export writes to `out.mp4.part`, atomic-renamed on success). Errors (nonzero exit, locked destination) → structured error IPC.
- Presets: 1080p / 720p (scale in compositor render size) / Source (sequence size); fps follows sequence. Destination via save dialog.
- `src/renderer/export/`: File→Export (Ctrl+E) dialog — preset picker, destination, duration estimate, progress bar with frames done/total + cancel button; success toast with "Reveal in Explorer".
- WYSIWYG test: render live-preview frame at t=2 s via compositor readPixels; export; ffmpeg-extract the exported frame at t=2 s; compare mean absolute per-channel diff ≤ 8/255 (codec loss tolerance), print the number.
- `e2e/export.spec.ts` per criteria (volumedetect for audio presence; progress monotonicity collected from IPC events; cancel test asserts no `.part` and no destination file).

## Acceptance criteria (all must pass — verify each in transcript)

- E2E exports a 5 s sequence (3 clips + dissolve + title); ffprobe asserts duration ±1 frame, h264+aac streams, requested resolution and fps
- WYSIWYG: frame extracted from the export at t=2 s matches the live-preview frame at t=2 s within a stated pixel-diff tolerance (numeric result in transcript)
- Audio present and non-silent in output (ffmpeg volumedetect mean_volume > -70 dB)
- Progress events are monotonic 0→100 (E2E)
- Cancel mid-export terminates ffmpeg and leaves no partial file in the destination (E2E)
- Export errors (e.g., destination locked) surface a readable dialog, not a crash (E2E)
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-9/export.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; full ffprobe JSON of the exported file; WYSIWYG diff number; `.supergoal/evidence/phase-9/export.png`

## Notes

- rawvideo rows: WebGL readPixels is bottom-up vs ffmpeg top-down — flip with `-vf vflip` or flip in the read loop; the WYSIWYG test will catch it if forgotten.
- The deterministic scheduler seam ("give me exactly frame i") is the design keystone — build it as a mode of the P7 scheduler, not a fork, or preview and export will drift apart.
- OfflineAudioContext sampleRate fixed at 48000.
- Export at 5 s × 30 fps = 150 frames; keep the E2E budget < 2 min (preset `veryfast` under MAGNETIC_TEST is acceptable — tolerance already absorbs codec loss; note it in the test).
