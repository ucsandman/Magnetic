# Thinking: Magnetic — FCP-style NLE for Windows

_2026-06-11 · greenfield + ui · Electron + React · signature-replica scope_

## Goals

1. Faithful replica of Final Cut Pro's **signature experience** on Windows: magnetic timeline (spine + connected clips), 3-panel dark UI, skimming, libraries/events/projects, FCP keyboard grammar (Q/W/E/D, A/B/T, JKL, I/O, N), real import → edit → export.
2. One differentiating improvement FCP lacks: **edit-by-transcript** (local Whisper, delete-text-to-cut, filler-word removal).
3. Portfolio-grade polish: golden path is flawless at 1080p; error/empty/loading states handled; ships as a Windows installer.

## Constraints

- Windows 11, local-only app. No auth, billing, cloud, or secrets (`.env.example` deliberately omitted — nothing to put in it).
- "Zero missing features" re-scoped (user-approved) to: zero missing features **from the feature matrix in ROADMAP.md**.
- Apple trademarks: app ships as "Magnetic"; README credits FCP as the design reference.
- npm as package manager; commands uniform across phases: `typecheck`, `lint`, `test`, `build`, `test:e2e` (+ `package` in final phase).

## Architecture decisions

- **Timeline kernel is pure TS** (`src/shared/timeline/`), zero DOM imports, exhaustively unit/property tested. UI is a thin canvas view over it. This is where magnetic correctness lives.
- **Time math in flicks** (1/705,600,000 s, integer) — exact for 23.976/24/25/30/50/59.94/60 fps. No float-seconds drift.
- **Viewer playback v1 = `<video>` element** (single source clip → trivial AV sync). **Sequence playback = WebCodecs decode (mp4box.js demux) + WebGL2 compositor + Web Audio mixdown.** A WebCodecs spike lands in phase 3 to de-risk phase 7 early.
- **Export = headless deterministic replay of the same compositor**, rawvideo piped to ffmpeg stdin + OfflineAudioContext mixdown. One render codebase ⇒ WYSIWYG export.
- **Native binaries** (ffmpeg/ffprobe from gyan.dev, whisper.cpp prebuilt + base.en model) fetched by `scripts/fetch-binaries.mjs` with pinned URLs + sha256, into gitignored `resources/bin/`. Spawned from Electron main only; renderer has contextIsolation on, nodeIntegration off, zod-validated IPC.
- **Test fixtures are generated, not shipped**: ffmpeg testsrc/sine clips + Windows SAPI TTS speech wav (`scripts/make-fixtures.mjs`) → deterministic, no copyright issues.

## Top 3 risks

1. **WebCodecs multi-clip sequence playback (P7)** — decode scheduling, A/V sync, codec gaps. *Mitigation:* P3 spike proves decode path on day one; documented fallback (`<video>`-seek stills for scrubbing, per-clip preview proxy via ffmpeg for playback); explicit drift-measurement criterion.
2. **Native binary wrangling on Windows** — download, paths-with-spaces, spawn, antivirus. *Mitigation:* P1 smoke-tests both binaries via diag IPC inside E2E; pinned URLs + checksums; idempotent fetch script.
3. **Magnetic semantics edge cases** — ripple vs connected clips, lane collisions, blade-at-boundary. *Mitigation:* kernel-first phase (P4) with property-based invariant tests gates all UI work.

## Dependencies (non-obvious ordering)

- Kernel (P4) only needs scaffold (P1) — it runs parallel-in-spirit to media work and gates timeline UI (P5).
- Sequence playback (P7) needs viewer engine learnings (P3) and timeline UI (P5); it unblocks transitions (P8) and export (P9) — the weakest link in the chain, hence the early spike.
- Transcript editing (P10) needs ripple ops (P6) and media/audio extraction (P2/P3).

## Memory hits applied

- claude-mem obs 24089 (project goal) — confirms fresh greenfield; nothing else inherited.

## Tools/skills relied on

- Context7 for Electron/WebCodecs/electron-vite/Playwright API verification during phases (planned against training-cutoff knowledge; executor must verify current APIs in P1/P3/P7).
- Playwright `_electron` for all E2E + screenshot evidence (subagent pattern per global CLAUDE.md where DOM dumps are big).
- superpowers TDD skill for kernel phase; frontend-design/impeccable for shell + polish phases.

## Best practices applied

- TDD on the kernel before UI; characterization-by-fixture for media pipeline; WYSIWYG export via single render path; integer time math; contextIsolation + validated IPC; evidence screenshots per UI phase under `.supergoal/evidence/phase-N/`.
