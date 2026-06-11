# Magnetic

A Final Cut Pro-style non-linear video editor for Windows, built with Electron, React, and TypeScript. Features a magnetic timeline, WebCodecs/WebGL2 playback, ffmpeg-powered import/export, and whisper.cpp-powered edit-by-transcript.

> Portfolio project. Not affiliated with Apple; "Magnetic" is an original product name.

## Requirements

- Windows 10/11 x64
- Node.js 24+, npm 10+

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Fetch native binaries (ffmpeg, ffprobe, whisper.cpp, base.en model)
#    into resources/bin/ — pinned URLs, sha256-verified, idempotent
npm run fetch-binaries

# 3. Generate test media into fixtures/ (uses the fetched ffmpeg + Windows SAPI TTS)
npm run fixtures
```

## Development

```bash
npm run dev          # start electron-vite dev server + app (HMR)
```

## Build & test

```bash
npm run typecheck    # tsc across main, preload, renderer, shared, e2e
npm run lint         # eslint
npm test             # vitest unit tests
npm run build        # electron-vite production build -> out/
npm run test:e2e     # Playwright Electron E2E (requires `npm run build` first)
```

## Scripts

| Script           | What it does                                                                |
| ---------------- | --------------------------------------------------------------------------- |
| `dev`            | Run the app in development with HMR                                         |
| `build`          | Production build to `out/`                                                  |
| `typecheck`      | Typecheck node (main/preload/shared/e2e) and web (renderer) projects        |
| `lint`           | ESLint over the repo                                                        |
| `test`           | Vitest unit tests (`src/**/*.test.ts`)                                      |
| `test:e2e`       | Playwright `_electron` smoke test against the built app                     |
| `fetch-binaries` | Download + sha256-verify ffmpeg/ffprobe/whisper/model into `resources/bin/` |
| `fixtures`       | Generate deterministic test media into `fixtures/`                          |
| `format`         | Prettier write                                                              |

## Architecture

- `src/main/` — Electron main process: window, menu, IPC (all handlers zod-validated)
- `src/preload/` — contextBridge bridge exposing the typed `window.api`
- `src/renderer/` — React UI: dark FCP-style 3-panel shell (browser / viewer / timeline, toggleable inspector via Ctrl+4)
- `src/shared/` — IPC channel names, zod schemas, shared types
- `scripts/` — binary fetcher and fixture generator
- `e2e/` — Playwright Electron tests
- `resources/bin/` — fetched native binaries (gitignored)
- `fixtures/` — generated test media (gitignored)

Renderer security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP set in `index.html`.

### Debug panel

Ctrl+Shift+D toggles a diagnostics overlay that spawn-verifies the bundled binaries (`ffprobe -version`, `whisper-cli --help`).
