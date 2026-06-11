SUPERGOAL_PHASE_START
Phase: 1 of 11 — Scaffold shell & binaries
Task: Bootable dark 3-panel Electron app with toolchain, native binaries fetched & spawn-verified, generated test fixtures
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e
Acceptance criteria: 8
Evidence required: command outputs, fetch-binaries idempotency demo, shell screenshot
Depends on phases: none

## Why

Everything depends on a bootable, verifiable app shell with the toolchain and native binaries proven on day one.

## Work

- Scaffold with `npm create @quick-start/electron` (electron-vite, React + TS template) or equivalent current scaffold — verify the current recommended electron-vite setup via Context7 before committing to it. TypeScript `strict: true`. App/product name "Magnetic", package name `magnetic`.
- Add ESLint (typescript-eslint) + Prettier; Vitest for unit tests; Playwright with `_electron` for E2E. Scripts: `dev`, `build` (electron-vite build), `typecheck` (tsc --noEmit across main/preload/renderer), `lint`, `test` (vitest run), `test:e2e` (playwright test), `fetch-binaries`, `fixtures`.
- `src/main/index.ts`: BrowserWindow (dark titlebar, min 1280×800), minimal File/Edit/Window/Help menu. `src/preload/index.ts`: contextBridge-exposed, typed IPC API (single `api` object; add zod validation scaffolding now — every handler validates input).
- `src/renderer/`: React shell with FCP-style dark theme tokens (near-black panels ~#1d1d1f/#28282b, #0a84ff accent, 11–13px UI type) and 3-panel layout: browser (left), viewer (top-right), timeline strip (bottom, full width), inspector (right, toggleable via Cmd/Ctrl+4-style toggle button). Use CSS grid; panels are placeholder content with correct chrome (headers, toolbars) this phase.
- `scripts/fetch-binaries.mjs`: download + sha256-verify into `resources/bin/` — ffmpeg + ffprobe (gyan.dev release-essentials zip; pin exact URL + hashes after checking availability), whisper.cpp Windows x64 prebuilt (pin a release; if no usable prebuilt exists, document and build via cmake as fallback), ggml `base.en` model from HF. Idempotent: skips files whose hash already matches. Print clear progress.
- Diag IPC channel `diag:binaries`: main spawns `ffprobe -version` and whisper `--help`, returns exit codes + first stdout line. Render result in a hidden-by-default debug panel; E2E asserts both exit 0.
- `scripts/make-fixtures.mjs` → `fixtures/` (gitignored): (a) `bars-1080p30.mp4` 10 s testsrc2+sine h264/aac, (b) `red-720p25.mp4` 8 s solid-color, (c) `tone.wav` 5 s audio-only, (d) `speech.wav` — Windows SAPI TTS (PowerShell System.Speech) reading a fixed ~80-word script stored in the repo as `fixtures-script.txt`. ffprobe-verify each and print durations.
- `e2e/smoke.spec.ts`: app boots, title "Magnetic", three panels visible (data-testid), contextIsolation probe (`window.require` undefined, `window.api` defined), diag IPC exit codes 0, screenshot to `.supergoal/evidence/phase-1/shell.png`.
- Git: repo already initialized at dispatch; commit the scaffold. `README.md` with install/dev/build/fetch-binaries/fixtures steps. `.gitignore`: node_modules, dist, out, resources/bin, fixtures, playwright-report, test-results.

## Acceptance criteria (all must pass — verify each in transcript)

- `npm run dev` boots a window; E2E asserts title "Magnetic" and all three panels visible
- `scripts/fetch-binaries.mjs` downloads and sha256-verifies ffmpeg, ffprobe, whisper binary + model; second run is a no-op (idempotent), proven in transcript
- Diag IPC spawns `ffprobe -version` and whisper `--help` from main; E2E asserts both return exit 0
- `scripts/make-fixtures.mjs` produces ≥4 fixture files; ffprobe-verified durations printed
- Renderer runs with contextIsolation on, nodeIntegration off (asserted in E2E via feature probe)
- typecheck, lint, test, build, test:e2e all exit 0
- Screenshot `.supergoal/evidence/phase-1/shell.png` saved showing dark 3-panel layout
- Git repo committed; README documents install/dev/build/fetch steps

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`

## Evidence required in transcript

- All command outputs (last ~10 lines + exit codes)
- fetch-binaries run twice: first downloads, second prints skip messages
- `.supergoal/evidence/phase-1/shell.png`

## Notes

- Verify current Electron/electron-vite/Playwright-electron APIs via Context7 before scaffolding — do not trust memorized majors.
- Playwright must launch the *built* app (electron-vite preview or out/ dir) or dev build consistently; pick one and keep it stable for all later phases.
- If a pinned binary URL 404s, choose the nearest stable release, update the pin + hash, and note it in STATE.md notable events. Do not leave hashes unverified.
- E2E on E:\-less Windows runners: paths with spaces are common — quote every spawn arg now.
- Keep at least one trivial vitest unit test so `npm test` is meaningful from day one (e.g., theme token export).
