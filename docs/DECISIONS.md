# Decision log


---

# Recovered decisions (claude-mem archive)

6 decisions recovered 2026-08-11 from the claude-mem store before it was pruned. Source window 2026-04-06 to 2026-06-11. Full archive with observations and session summaries: `C:\Projectsrchives\claude-mem-2026-08-11\`.

## 2026-06-11 — Windows Final Cut Pro Replica — Project Goal Established

User initiated a project to build a feature-complete Windows clone of Apple's Final Cut Pro with planned improvements.

- Target software: Apple Final Cut Pro (https://www.apple.com/final-cut-pro/) — a professional video editing application exclusive to macOS.
- Goal is a Windows-native recreation with ZERO missing features relative to the macOS original.
- Pre-build brainstorming was requested (via /brainstorming) to identify and implement at least one improvement over the original.
- User requested a copy-pasteable /goal prompt for a new session, with model and effort level recommendations to optimize tokens.
- No clarifying questions were answered yet — session was in the prompt-generation phase at observation time.

## 2026-06-11 — Final Cut Pro Windows Recreation — Project Goal Defined

User requested a Windows replica of Final Cut Pro with zero missing features plus one brainstormed improvement.

- Target product: Apple Final Cut Pro (https://www.apple.com/final-cut-pro/) — professional video editing software for macOS.
- Objective: Build a pixel-perfect Windows port with 100% feature parity and at least one brainstormed enhancement baked in.
- Pre-build step required: run /brainstorming to surface improvement candidates before any code is written.
- Deliverable from this session: a polished /goal prompt (with recommended model and effort level) for copy-paste into a new token-efficient session.
- User authorized asking clarifying questions if scope or direction is ambiguous.

## 2026-06-11 — Magnetic — FCP Windows Replica: Full Architecture and Tech Stack Defined

Project named "Magnetic"; core architecture, tech stack, risks, and 10-phase roadmap documented in THINKING.md.

- App named "Magnetic" (avoids Apple trademark); README credits Final Cut Pro as design reference.
- Stack: Electron + React, electron-vite, TypeScript, npm as package manager, Windows 11 target.
- Timeline kernel lives in `src/shared/timeline/` as pure TypeScript with zero DOM imports — all magnetic correctness tested here.
- Time math uses flicks (1/705,600,000 s, integer arithmetic) to eliminate float-seconds drift across all standard frame rates.
- Viewer playback v1 uses `<video>` element; sequence playback uses WebCodecs + mp4box.js demux + WebGL2 compositor + Web Audio mixdown.
- Export is a headless deterministic replay of the same WebGL2/Web Audio compositor piped to ffmpeg stdin — guarantees WYSIWYG export.
- Native binaries (ffmpeg/ffprobe from gyan.dev, whisper.cpp + base.en model) fetched by `scripts/fetch-binaries.mjs` with pinned URLs and sha256 checksums into gitignored `resources/bin/`.
- Test fixtures are generated at build time via ffmpeg testsrc/sine clips and Windows SAPI TTS — no copyrighted media shipped.
- Differentiating improvement over FCP: edit-by-transcript using local Whisper (delete text to cut, filler-word removal).
- Renderer runs with contextIsolation on, nodeIntegration off, and Zod-validated IPC — security-first Electron config.
- Top risk identified: WebCodecs multi-clip sequence playback (Phase 7) — mitigated by an early Phase 3 spike.
- Phase dependency chain: scaffold (P1) → kernel (P4) → timeline UI (P5) → ripple ops (P6) → sequence playback (P7) → transitions (P8) → export (P9) → transcript editing (P10).
- "Zero missing features" re-scoped to mean zero missing features from the feature matrix in ROADMAP.md.

Files: `C:\Projects\final-cut-pro\.supergoal\THINKING.md`

## 2026-06-11 — Phase 4 Spec — Magnetic Timeline Kernel: Derived Positions, Total-Function Ops, and Property Testing Strategy

Kernel design enforces derived spine positions (never stored) and total-function ops; fast-check property tests gate all UI work.

- Spine item timeline positions are DERIVED by prefix-sum summation, never stored — this prevents gap/overlap bugs by construction.
- Every op signature is `(seq, args) → { next: Sequence, inverse: Op }` — pure, no mutations, enables structural sharing and undo by design.
- Invalid op args (unknown id, out-of-range time) return `{ next: seq, inverse: noop }` plus a typed error field — ops never throw mid-edit.
- Connected clip orphan behavior on parent delete: re-attach to the clip now under the absolute time of the connected clip (matches FCP behavior), or delete if no clip exists there.
- Lane collision resolution: later-added connected clip bumps up one lane (video) or down one lane (audio) — deterministic, never overlaps.
- `UndoStack` exposes `beginGroup/endGroup` coalescing API for multi-op commands; Phase 10 filler removal relies on this.
- Property test suite: ≥200 runs × ≥20 random ops per run, asserting: all durations ≥1 frame, media bounds respected, connected parents exist, lane overlaps absent, derived positions strictly increasing.
- fast-check shrinking expected to surface edge cases like 0-duration after trim and double-blade at same point; spec instructs fixing op clamps, not weakening invariants.
- DOM-free criterion verified by grep: `grep -rn "document\|window\|electron" src/shared/timeline/ || echo CLEAN`.
- Kernel line coverage target: ≥90% via `vitest --coverage`.

Files: `C:\Projects\final-cut-pro\.supergoal\phases\phase-4.md`

## 2026-06-11 — Final Cut Pro Windows Recreation — Project Scoping Request

User requested a Windows-native recreation of Final Cut Pro with brainstormed improvements and a reusable goal prompt.

- Target software is Apple Final Cut Pro (https://www.apple.com/final-cut-pro/) — a professional, macOS-exclusive video editing application.
- Goal is a Windows-native recreation with zero missing features relative to the macOS original.
- Session tasked with brainstorming improvements before implementation and selecting the best one to include in the recreation.
- Output requested includes a copy-pasteable /goal prompt for a fresh session to conserve tokens on the actual build.
- Model and effort level recommendation was also requested alongside the generated goal prompt.
- User indicated willingness to answer clarifying questions before implementation begins.

## 2026-06-11 — Magnetic Tech Stack and Scope Decisions Finalized

Architecture and user-approved scope constraints for the Magnetic Windows NLE locked in and persisted to project memory.

- Tech stack: Electron + React + TypeScript for the shell; magnetic-timeline kernel implemented in pure TypeScript.
- Playback engine uses WebCodecs and WebGL2; ffmpeg and whisper.cpp ship as bundled binaries.
- App is named "Magnetic" for trademark safety — intentionally distinct from "Final Cut Pro".
- Scope is "signature-replica tier" — NOT a full FCP clone; the ROADMAP.md feature matrix defines the exact cut-line.
- Edit-by-transcript is the user-approved improvement feature added on top of the replica (implemented in Phase 10).
- Project purpose is portfolio — not a commercial product.
- Resume protocol: in a new session, read STATE.md first — do NOT re-plan; paste the /goal line from PROTOCOL.md to continue.
- Persistent memory file written to C:\Users\sandm\.claude\projects\C--Projects-final-cut-pro\memory\magnetic-fcp-replica-plan.md for future session recall.
- Git log at this point has two commits: 26c22d9 (plan) and dd4bbef (dispatch-ready state).

Files: `C:\Users\sandm\.claude\projects\C--Projects-final-cut-pro\memory\magnetic-fcp-replica-plan.md`

