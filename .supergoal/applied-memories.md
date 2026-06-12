# Applied memories — run 2026-06-12 (UX round 2)

- magnetic-run-progress — engine surfaces (playback/engine.ts buildItems/tick/renderStill, transport.ts, audio-graph rms), test-state hook `__magneticTimeline`, full-suite-green discipline; phases of prior run NOT to be redone.
- electron-canvas-e2e-gotchas — no synthetic pointermove in Electron (use mouse.move/down/up); state-derived hit rects for canvas interactions (minimap MUST follow this); layout-shift races; worker 0xC0000409 = re-run.
- electron-protocol-media-seek-bug — media must be served over loopback HTTP (already the case via asset.mediaUrl); never switch <video> to protocol.handle URLs.
- electron-vite-sandbox-gotchas — sandboxed preload constraints; not expected to matter (renderer-only round).
- magnetic-improvement-backlog-2026-06 — this round = backlog item 3 (editor UX) minus retiming (build alone) minus transcript surfaces (moat round owns them).
- magnetic-feature-slate-2026-06 — invariants for existing features (keyframes/captions/silence) must not regress; full e2e suite is the guard.
