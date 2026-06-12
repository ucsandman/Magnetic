# ROADMAP — UX round 2: loop, timecode entry, range play, meter, fullscreen, minimap

Spec: docs/superpowers/specs/2026-06-12-ux-improvements-design.md (committed 422994f)
Baseline ref: 422994f82ae70027e31b203c5580525ae0332b7a
Phases: 7 · Mode: brownfield · Date: 2026-06-12

Per-phase mandatory commands are `npm run typecheck`, `npm run lint`,
`npm run test`, `npm run build`, plus a targeted Playwright run of the specs
the phase touches. Phase 7 runs the FULL `npm run test:e2e` in one pass.

---

## Phase 1 — Loop playback toggle

**Why:** Round 1's deferred item; every surveyed NLE ships it (FCP ⌘L).

**Deliverables:**
- src/shared/timeline/* or src/renderer/state: `loopPlayback` flag in the timeline store with `setLoopPlayback`, persisted to localStorage["magnetic.playback.v1"]
- src/renderer/playback/transport.ts: loop-aware sequence end behavior (pure, unit-tested wrap decision)
- Loop button (aria-pressed) in SequencePlayer and ViewerPanel transport bars
- `ctrl+l` registered via registerShortcut (appears in Shift+? overlay)
- Source viewer `<video>.loop` mirrors the flag
- Unit tests in src/renderer/playback/transport.test.ts (or colocated)
- E2E coverage in e2e/ux-controls.spec.ts

**Acceptance criteria:** 8 (see phases/phase-1.md)
**Depends on:** none

## Phase 2 — Timecode click-to-type seeking

**Deliverables:**
- src/shared/timecode.ts: `parseTimecode(text, fps): number | null` + unit tests in src/shared/timecode.test.ts
- Click-to-edit timecode input in SequencePlayer and ViewerPanel (data-testid="timecode-input"), Enter seeks / Escape cancels / invalid rejects visibly
- E2E coverage in e2e/ux-controls.spec.ts

**Acceptance criteria:** 7 (see phases/phase-2.md)
**Depends on:** none

## Phase 3 — Play marked range (/)

**Deliverables:**
- `/` shortcut in ViewerPanel: plays markIn→markOut, pauses at out; loop on = wraps
- Overlay row for `/`
- E2E coverage in e2e/ux-controls.spec.ts

**Acceptance criteria:** 5 (see phases/phase-3.md)
**Depends on:** 1

## Phase 4 — Audio meter

**Deliverables:**
- src/renderer/viewer/meter-scale.ts: `rmsToMeter(rms)` pure helper + src/renderer/viewer/meter-scale.test.ts
- src/renderer/viewer/AudioMeter.tsx rendered in the sequence transport (data-testid="sequence-meter", aria-valuenow in dB)
- E2E coverage in e2e/ux-controls.spec.ts (tone fixture)

**Acceptance criteria:** 5 (see phases/phase-4.md)
**Depends on:** none

## Phase 5 — Viewer fullscreen

**Deliverables:**
- ⛶ button on both transports (data-testid="viewer-fullscreen") + `shift+f` shortcut
- :fullscreen CSS keeping the transport visible
- Catch on requestFullscreen rejection (no-op, no crash)
- E2E coverage in e2e/ux-controls.spec.ts

**Acceptance criteria:** 6 (see phases/phase-5.md)
**Depends on:** none

## Phase 6 — Timeline minimap + follow-playhead

**Deliverables:**
- Pure minimap math helper (viewport rect + visibility) in src/renderer/timeline/minimap.ts + src/renderer/timeline/minimap.test.ts
- Minimap strip drawn in src/renderer/timeline/render.ts; pointer interaction (click/drag pans scrollX) in TimelineCanvas.tsx via state-derived hit rect
- Follow-playhead paging during sequence playback only
- E2E coverage in e2e/ux-controls.spec.ts (scrollX via __magneticTimeline)

**Acceptance criteria:** 7 (see phases/phase-6.md)
**Depends on:** none

## Phase 7 — Polish & Harden

**Deliverables:**
- README.md: feature list updated; shortcut table regenerated via scripts/dump-shortcuts.mjs (includes ctrl+l, /, shift+f)
- docs/GUIDE.md: playback/review workflow section updated
- .supergoal/evidence/ux2/ screenshots: loop button on, meter live, minimap visible
- Full suite green in ONE run (all 5 gates incl. full test:e2e)
- Cleanliness pass vs baseline 422994f (repo-state.sh added-lines: no console.log/debugger/session-TODO)

**Acceptance criteria:** 8 (see phases/phase-7.md)
**Depends on:** 1,2,3,4,5,6
