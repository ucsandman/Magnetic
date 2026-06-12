SUPERGOAL_PHASE_START
Phase: 2 of 11 — Library, import & browser
Task: Library/Event/Project persistence, media import with metadata + filmstrips + waveforms, FCP-style browser with skim/rate/search
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 8
Evidence required: command outputs, import E2E output, relaunch-persistence proof, screenshot
Depends on phases: 1

## Why

FCP's organization model (Library→Event→Project) and the filmstrip browser are half its identity and feed every later phase.

## Work

- `src/shared/types.ts`: `Library { id, name, path, events[] }`, `Event { id, name, assetIds[], projectIds[] }`, `Project { id, name, sequence }` (sequence fleshed out in P4 — stub type now), `MediaAsset { id, fileName, libraryRelPath, contentHash, video?: {codec,w,h,fps,durationFlicks}, audio?: {codec,channels,sampleRate}, rating: 'none'|'favorite'|'rejected', filmstrip?: {stripPath,frameW,frameCount,intervalFlicks}, waveform?: {peaksPath} }`.
- `src/main/project-io/`: library is a folder `<name>.mglib/` containing `library.json`, `events/*.json`, `projects/*.json`, `media/` (imported copies), `cache/` (filmstrips, peaks, transcripts later). Atomic writes: write temp + rename. Autosave debounced. On launch: reopen last library (path in electron `userData` settings.json) or create default at `~/Videos/Magnetic.mglib`.
- Import: File→Import (and drag-drop onto browser) → copy files into `media/`, sha1 contentHash, ffprobe metadata (`-print_format json -show_streams -show_format`), create MediaAsset. Reject unreadable files with a per-file error toast listing the reason.
- Background job queue in main (`src/main/jobs/`): simple FIFO with concurrency 2, progress events over IPC. Jobs: (a) filmstrip — single horizontal strip JPEG via ffmpeg `select`/fps filter, ~1 frame per N sec scaled to 60 px tall; (b) waveform peaks — ffmpeg PCM → min/max peak pairs JSON (~1000 buckets). Browser shows placeholder shimmer until ready.
- `src/renderer/browser/`: left sidebar (library > events tree), main area filmstrip **grid** + **list** toggle. Each cell: filmstrip image, name, duration badge, rating mark. Hover-skim: pointer x within cell maps to strip frame (background-position) AND shows that frame; favorite (F), reject (Del→ marks rejected, hidden by filter), unrate (U). Search box filters by name. Filter dropdown: All / Favorites / Hide Rejected.
- Selection model: single + range (shift). Selected asset shows in viewer placeholder (wired for P3).
- `e2e/browser.spec.ts`: import fixtures via IPC test hook (expose `api.__test.importPaths(paths)` guarded by env flag), assert grid population, skim, rate, search, relaunch persistence (electronApp.close() then relaunch, assert state).

## Acceptance criteria (all must pass — verify each in transcript)

- E2E imports the fixtures and asserts grid shows them with correct duration badges
- Hover-skim over a filmstrip changes the displayed frame (E2E pointer-move assertion)
- Favorite/reject and search filter the grid (E2E)
- Library persists: E2E relaunches the app and asserts assets + ratings restored
- Atomic-write unit tests pass (crash-during-save leaves valid previous JSON)
- Thumbnails/waveforms generate in background: during generation the E2E performs a rating click and asserts the UI responds (no blocking)
- All mandatory commands exit 0
- Screenshot `.supergoal/evidence/phase-2/browser.png`

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- Command outputs; import E2E output; relaunch-persistence proof; `.supergoal/evidence/phase-2/browser.png`

## Notes

- Durations everywhere in flicks (int) from the start — convert from ffprobe seconds once at import. Helper lives in `src/shared/timecode.ts` (created here or P3, whichever comes first — keep one source of truth).
- ffprobe fps: parse `r_frame_rate` rational (e.g. 30000/1001), never floats.
- Filmstrip strip width caps at 4096 px to stay GPU-texture-safe later.
- The `__test` IPC surface must be disabled unless `MAGNETIC_TEST=1` — assert that in a unit test.
