# Human + Agent Editor — Tournament Results (2026-07-12)

Ultracode tournament: 6 vision proposals, 3 judge lenses (feasibility, product, agent-native), 1 synthesis. 12 agents, ~953K tokens.

## Leaderboard (average of 3 judges)

1. **Embedded Copilot: The Timeline Never Lies** — 87/100
2. **Magnetic Protocol: LSP for Video Editing** — 77/100
3. **Rough Cut First: The Talking-Head Cleanup Wedge** — 76/100
4. **The Rough-Cut Factory** — 71/100
5. **Shared Spine** — 65/100
6. **Timeline-as-Text: The EDL Is the Pull Request** — 58/100

---

# Magnetic Copilot — Final Synthesis

*Tournament synthesizer's report. Six visions, three judge lenses, one decision.*

---

## 1. The Winning Vision

**Build the Embedded Copilot — "the agent proposes, ghost-renders on the real timeline, and only ever commits through the same undo stack the human uses" — but enter it through Rough Cut First's one-button wedge, and expose Magnetic Protocol's MCP door as a documented secondary surface.**

Two of the three judges put **Embedded Copilot (P2)** first, and the third (agent-native), which crowned **Magnetic Protocol (P1)**, said in plain text that P1 and P2 are *complementary, not contradictory* — that the winning move is "P1's protocol as the spine, with P2's ghost-diff-before-commit grafted on." All three lenses converge on the same physical system. I am not overruling the judges; I am reconciling them.

**Why Embedded Copilot is the correct anchor:**

- **It is the only trust model that lets a professional adopt an agent daily.** The agent runs its proposed edits against a *throwaway scratch Sequence*, renders the delta as translucent green ghost clips and red hatch-strikethrough on the **real** `TimelineCanvas`, and touches committed state only when the human clicks Accept — routing through the exact `applyOp` / `beginGroup` / `endGroup` path a human keystroke already uses. Diff-*before*-commit, not act-then-undo. One `Ctrl+Z` reverts a whole agent turn because it *is* one `HistoryEntry`.
- **It carries essentially zero concurrency landmines.** In-process, renderer-side execution is correct and verified: `ops.ts`, `silence/detect.ts`, and `transcript/cache.ts` already run in the renderer with zero Electron/DOM dependency. No IPC hop, no CRDT/OT, no three-way merge, no dual-path parity hazard. The feasibility judge called this "the model answer to this lens."
- **It works across *all* edit types** (trim, cut, take-selection, transitions), so daily use extends past the cleanup wedge — the ceiling is a general co-editor, not a single feature.

**Why I overrule the pure agent-native pick (P1 as #1):** Magnetic Protocol is the right *eventual* spine, but as a standalone v1 its Tier-1 atomic writes land **live with no preview**, its dual renderer-live/headless execution paths must be kept behaviorally identical forever (the `withAdoptedFps` / selection-resolution divergence is a standing correctness hazard), and — decisively for this product — its daily user is *a developer running Claude Code next to the editor*. Magnetic's audience is solo creators who have never run an MCP stdio server. The protocol is a power-user multiplier, not the front door. It ships, but late, and behind a visible toggle.

**Why the wedge fixes the one real weakness:** Embedded Copilot's honest flaw is a weak Phase-1 ship (a chatbot with mutating tools disabled) and typed-prompt friction for the universal 80% case. **Rough Cut First (P6)** has the sharpest wedge argument in the field and a *verified* one-week build: talking-head silence + filler cleanup is the only workflow every solo creator does on every video, it is mechanical and deterministic (it never erodes trust by guessing at a subjective "good hook"), and it is buildable almost entirely from code that already ships. So the week-one deliverable is **one button**, not a chatbot — and the conversational Copilot arrives on top of a feature that already earns its place.

---

## 2. Grafts — What I Took, and From Whom

| Graft | Source | What it does in the merged system |
|---|---|---|
| **Ghost-diff-before-commit** (scratch Sequence → green ghost + red hatch on real `TimelineCanvas`, commit only via `applyOp`/`beginGroup`) | **P2 Embedded Copilot** | The core trust surface. The single most important element; every write flows through it. |
| **One-button Rough Cut entry** (silence + filler, one click, not a prompt) | **P6 Rough Cut First** | The zero-friction front door for the universal 80% case. Fixes P2's weak Phase 1. |
| **Spell-checker-style per-cut reject scrub** ("it cut a joke I wanted" → click the AI badge → Reject, other 39 stay) | **P6 Rough Cut First** | The most relatable trust moment in the tournament. Grafted into the change-list. |
| **Ephemeral provenance** (agent-authored edit-point ids as a `Set` in the store, **never** in the serializable `Sequence`) | **P6 Rough Cut First** | Keeps kernel purity/invariants intact while giving a visible per-cut "AI" diff. |
| **Split-screen A/B video review via two `PlaybackEngine.renderStill` instances** | **P3 Timeline-as-Text** | Lets the human scrub the *actual* before/after of a change, not just hatched clips. (Flagged as an unverified two-instance assumption — see Risk 2.) |
| **Voice cleanup denoise job** (`jobs/denoise.ts`, bundled ffmpeg `afftdn`/`arnndn`) | **P6 / owner's backlog** | Rounds out the talking-head wedge; it's on the owner's actual roadmap. |
| **Flow-score self-check** as an explicit tool the agent runs on its *own* output + clickable ruler flag markers | **P4 Rough-Cut Factory** | Agent verifies its edits before presenting them; jump-to-problem review surface. |
| **Hard "agent can never call Export" capability boundary** | **P4 Rough-Cut Factory** | Only a human action ships anything. Non-negotiable safety frame. |
| **MCP door** (env-gated `agent-sidecar.ts` cloned from `media-server.ts`, standalone `magnetic-mcp` stdio package) + **Agent Access panel** (toggle, token, revoke) + **Activity rail** (per-turn Undo, Pause) | **P1 Magnetic Protocol** | The "any harness" power-user surface, kept off the creator's critical path but real and visible. Satisfies human-experience rule 5. |
| **`validateSequence` promoted out of `invariants.test.ts`** into an exported guard; **zod schemas from `shared/ipc.ts` reused verbatim** as tool input schemas | **P1 (consensus of P1/P3/P5)** | Do it once, early. Runtime "is this sequence legal" gate for every agent write. |
| **`isInteracting` gesture-queue** (defer agent ops during an active human drag) — **NOT** a soft-lock | **P1, inverting P2's flaw** | The agent-native judge's explicit correction: *do not disable human editing during review.* Queue, never block. |
| **Per-clip attribution color tag + hover history** ("agent vs you touched this") | **P5 Shared Spine** | Near-free trust surface via the kernel's structural-sharing reference-diff. |
| **Optional multimodal filmstrip perception** (reuse `cache/filmstrips/` over `mfile://` as image blocks, opt-in for visually ambiguous asks only) | **P2 Embedded Copilot** | Real vision when — and only when — an edit decision needs pixels. |
| **Optional batch auto-import Queue mode** (fire on import, cards of ready drafts) | **P4 Rough-Cut Factory** | The same engine serving a hands-off ingest lane, layered on top of the interactive copilot. |

**Deliberately dropped:** P3's three-way structural merge and P5's cross-actor rebase-veto — the two "novel reconciliation engine dressed as free reuse" features the feasibility judge exists to punish. See §5.

---

## 3. Unified Architecture

The whole system is additive. It sits in the two seams the codebase already exposes: the **pure kernel** and the **renderer's panel-per-feature + `beginGroup`/`endGroup` composition** pattern.

### Reused as-is (zero or near-zero change)

- **`src/shared/timeline/ops.ts`** — every op (`append`, `insertAt`, `blade`, `trimRipple`, `rippleDeleteRange`, `trimConnected`, `setClipFx`, `addTransition`, …) becomes an agent tool verbatim. `ok()`'s built-in `resolveLaneCollisions` / `pruneTransitions` / `validateClipInput` mean a tool call **cannot** produce an illegal sequence.
- **`src/shared/timeline/undo.ts`** — `UndoStack.beginGroup/apply/endGroup`. One agent turn = one undo entry. Same primitive `timeline-store.ts` already uses for paste / loop-to-fill / multi-range delete.
- **`src/shared/timeline/{model,magnetic,fx-eval,clipboard,smart-render}.ts`** — imported directly, Electron/DOM-free.
- **`src/renderer/silence/detect.ts`** — `detectSilence()` powers the silence half of Rough Cut, unchanged.
- **`src/renderer/transcript/cache.ts`** — `ensureTranscripts()` feeds filler detection and Copilot perception, verbatim.
- **`src/main/jobs/transcribe.ts`** + **`audio-envelope.ts`** on **`JobQueue(2)`** (`app-state.ts`) — word-level whisper.cpp timestamps and RMS envelopes already exist; the denoise job clones this pattern.
- **`src/renderer/playback/engine.ts`** — `renderStill(sequence, snapshot, timeFlicks)` already takes an *arbitrary* Sequence, so two instances back the A/B split preview.
- **`src/renderer/state/timeline-store.ts`** — `applyOp` + `syncFromStack`: the exact commit path agent-accepted ops execute through, giving free re-render / autosave / undo-menu update.
- **`src/main/media-server.ts`** (loopback HTTP + per-session random token) and **`src/main/ipc.ts`** `isTestMode()`/`MAGNETIC_TEST` gating — structural templates for the MCP sidecar.
- **`src/shared/ipc.ts`** zod schemas — reused as MCP/tool input validation, not duplicated.
- **`TranscriptPanel.tsx` / `SilencePanel.tsx`** — docking + settings-slider-plus-list convention every new panel mirrors.
- **`settingsGet`/`settingsSet` IPC** — Anthropic API key stored server-side, never `localStorage`.

### New modules

- **`src/renderer/agent/roughcut.ts`** — pure `planRoughCut(sequence, transcript, envelopes, options): RoughCutPlan` = `detectSilence` + new `detectFillers(transcript, lexicon)` (~40 lines, mirrors `detect.ts`), with min-gap merge. Unit-tested with fast-check like `invariants.test.ts`.
- **`src/renderer/agent/RoughCutPanel.tsx`** — the one-button wedge UI (aggressiveness slider, filler toggle, smoothing toggle).
- **`src/renderer/copilot/tools.ts`** — `ops.ts` → LLM tool wrappers; typed `OpError` surface for retry, zero new validation.
- **`src/renderer/copilot/agent-runtime.ts`** — Claude tool-calling loop (Anthropic SDK, streaming, per the `claude-api` skill), `buildContext()` perception (transcript + silence + optional filmstrip vision). Executes each `tool_use` against the **scratch Sequence**, appends to `opLog[]`.
- **`src/renderer/copilot/CopilotPanel.tsx`** + **`useCopilotStore.ts`** — chat + plain-English change list; zustand store mirroring `timeline-store.ts` (`messages[]`, `pendingProposal {base, proposed, opLog}`, streaming flag, agent-playhead position).
- **Ghost-overlay draw pass** — one additional pass in `TimelineCanvas.tsx`'s existing draw loop, computed from an id-diff of `proposed.spine/connected` vs `base`, throttled like the existing 250ms autosave debounce. Plus an agent-playhead marker reusing the existing ruler-playhead render path.
- **`src/shared/timeline/validate.ts`** — `validateSequence(seq): OpError[]`, promoted from `invariants.test.ts`'s `checkInvariants`.
- **`src/main/jobs/denoise.ts`** — ffmpeg `afftdn`/`arnndn` → `cache/denoised/<assetId>.wav`; one new zod-validated IPC pair (`mediaDenoise` / push `denoiseProgress`).
- **`src/main/agent-sidecar.ts`** + **`magnetic-mcp`** (standalone Node stdio package) — env-gated `MAGNETIC_AGENT=1`; the "any harness" door. Ships last.
- **Settings › Agent Access panel** + **Agent Activity rail** — visible on/off, token reveal/rotate, connected-session revoke, per-turn Undo, global Pause.

### How agent and human surfaces coexist

```
                       ┌─────────────────────────────────────────────┐
   Human keystroke ───►│  timeline-store.applyOp / beginGroup / endGroup │──► real UndoStack
                       └─────────────────────────────────────────────┘        │
                                        ▲  (Accept commits here)               ▼
  ┌──────────────┐   ops   ┌──────────────────────┐   id-diff   ┌───────────────────┐
  │ RoughCutPanel│────────►│  scratch Sequence     │───────────►│ TimelineCanvas     │
  │  Copilot loop│         │  (throwaway, no store)│  ghost/hatch│ ghost overlay pass │
  └──────────────┘         └──────────────────────┘             └───────────────────┘
        ▲                                                                 │
        │ perception: ensureTranscripts, detectSilence, filmstrips        │ per-cut Reject / partial accept
   MCP sidecar (env-gated, last) ─── validateSequence gate ── isInteracting gesture-queue
```

Nothing the agent proposes mutates committed state. The human's own editing is **never disabled** during review (gesture-queue, not soft-lock). Agent provenance lives as an ephemeral `Set` in the store, not in the persisted `Sequence`.

---

## 4. Phased Roadmap

Each phase is independently shippable with a concrete verify step. Week-one quick win is first.

### Phase 1 — One-button Rough Cut *(week one)*
`detectFillers()` + `planRoughCut()` merge silence + filler ranges; executor wraps `rippleDeleteRange` calls in one `beginGroup`/`endGroup`; a single **Rough Cut** button in `RoughCutPanel` (reuses `SilencePanel`'s slider). Applied live as one undo group, with AI provenance badges at each edit point and a per-cut next/reject scrub.
**Verify:** Drop a raw 12-min talking-head clip → click Rough Cut → timeline tightens to ~4 min → click one AI badge → Reject restores that single cut, others stay → `Ctrl+Z` reverts the whole pass in one step. No new kernel op, no new IPC.

### Phase 2 — Ghost-diff-before-commit
Introduce the scratch Sequence + the ghost/hatch id-diff overlay pass in `TimelineCanvas.tsx`. Rough Cut now **previews** (green ghost / red hatch) before applying; Accept-All / Discard route through `applyOp`. Promote `validateSequence` and gate every proposed sequence through it.
**Verify:** Rough Cut shows hatched deletions on the real timeline *before* anything commits; Discard leaves **zero** history entries; Accept lands as one undo step; a deliberately corrupted proposal is rejected by `validateSequence` with a typed `OpError`.

### Phase 3 — Conversational Copilot (read-only advisor)
`CopilotPanel` + `agent-runtime` wired to Claude with mutating tools **disabled**. `buildContext()` reads transcript + silence + sequence; the agent answers and *suggests* in plain text only.
**Verify:** Ask "what happens in the first 30 seconds of this cut?" → accurate structured answer (clip names, timecodes, transcript excerpts, silence gaps) with zero kernel/undo risk. Ships as a real feature on its own.

### Phase 4 — Copilot write via ghost-diff
Enable the full `ops.ts`→tool map. A turn produces a batched `opLog` against the scratch Sequence, renders the whole-timeline ghost diff, and a plain-English change list; Accept replays the batch through `beginGroup`/`endGroup`. Agent-playhead marker sweeps the ruler as the agent reads.
**Verify:** "Tighten this interview, keep the story beats" → hatch-diff sweeps ~8 min of filler live → Accept snaps to the new cut as **one** undo step → `Ctrl+Z` restores the full length in one keystroke.

### Phase 5 — Partial accept + A/B video review + attribution
Per-op checkboxes with id-dependency detection (scan args for ids introduced earlier in the `opLog`; force dependent ops into the same decision — **no** general dependency resolution). Atomic re-validation at commit (any replay error fails the whole accept transactionally). Split-screen before/after via two `renderStill` instances. Per-clip attribution color tags + hover history.
**Verify:** Uncheck 2 independent cuts from a 17-op batch → Accept lands only the 15 → A/B scrub shows real before/after video across the changed range → a clip's hover popover shows "Copilot trimmed head 2 min ago."

### Phase 6 — Voice cleanup + self-check
`jobs/denoise.ts` (ffmpeg `afftdn`/`arnndn`) on `JobQueue`, surfaced as a "Clean up audio" checkbox and an asset context-menu action. `flow-score` self-check the agent runs on its own output, surfaced as clickable ruler flag markers (dead air, jump cut, caption overflow).
**Verify:** One-click denoise produces a `cache/denoised/` sidecar the player prefers over raw; a generated cut shows a color-coded score + "3 flags"; clicking a flag seeks the playhead to the flagged moment.

### Phase 7 — MCP door (power-user, secondary surface)
`agent-sidecar.ts` (loopback + token, gated `MAGNETIC_AGENT=1`), standalone `magnetic-mcp` stdio package (Tier-1 atomic tools + Tier-2 intent verbs with mandatory `dryRun`). Settings › Agent Access (toggle, token reveal/rotate, session revoke) + Agent Activity rail (per-turn Undo, Pause). **All external writes flow through the same scratch-Sequence ghost-diff/apply path — never live Tier-1 writes.**
**Verify:** Connect Claude Code over MCP to a running project → it accurately answers questions about the open timeline and proposes an edit that renders as a ghost diff a human approves → flipping the Settings toggle off severs it instantly.

### Phase 8 — Hardening + batch mode
`isInteracting` gesture-queue (defer agent ops during an active human drag, surfaced as "N pending"). Opt-in multimodal filmstrip perception for visually ambiguous asks. Optional auto-fire-on-import Queue of ready draft cards (P4 batch lane, its own project slot + open-project mutex).
**Verify:** Agent op issued mid-drag queues and applies cleanly after the drag ends without the timeline jumping; "keep the take where she's smiling" triggers a filmstrip vision call only when needed; dragging 5 raw clips into the library populates draft cards hands-off.

---

## 5. What NOT to Build, and Top Risks

### Explicitly out of scope
- **Three-way structural merge (P3 Phase 5)** — the reconciliation engine the thesis claims to avoid; self-disclosed highest-risk, liable to slip. Turn-taking + gesture-queue removes the need.
- **Full multiplayer: actor rails, scope claims, trust tiers, cross-actor rebase-veto (P5)** — heavy machinery to coordinate a single-JS-thread reality for a solo-creator market. Keep only the near-free per-clip attribution tag.
- **Timeline-as-Text YAML DSL as the primary agent contract (P3)** — hand-authoring internally-consistent documents of integer FLICK values is strictly worse than typed ops with built-in magnetic reflow. (Text *export* is fine later; the *contract* is `ops.ts`.)
- **OTIO adoption** — Python/C++ interchange cost, no canonical diff, no keyframe/magnetic/smart-render concept. Build over `model.ts`.
- **Vertical/aspect reframe for shorts** — a real playback-engine feature, not a trim. Defer.
- **Opaque preference-learning ML model** — if a learning loop is ever added, weights stay small, inspectable, resettable, shown in plain language.
- **A soft-lock that disables human editing during review (P2's own flaw)** — inverted per the agent-native judge: queue agent ops, never block the human.
- **A fully out-of-process agent opening its own `LibraryStore.open(root)`** — reopens the unaddressed file-locking gap. The MCP path is an in-process sidecar sharing the one event loop, only.

### Top 5 risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Filler-word false positives** ("like" used meaningfully) cut real content — first-run trust killer. | Conservative default lexicon + min-confidence/duration threshold; **ghost-diff-before-commit from Phase 2** so nothing lands unseen; per-cut Reject scrub; review-before-export always on for the first pass, auto-apply only after explicit opt-in. |
| 2 | **Two live `PlaybackEngine.renderStill` instances** for A/B preview are *assumed*, not verified — `renderStill` binds a single `this.compositor` and bails during `playing`/`exporting`; two instances contending for WebCodecs decoders on multi-GB files may wedge. | Spike a two-instance prototype **before** Phase 5 commits to split-screen; fallback is a single-instance toggle (flip base/candidate on one canvas) if shared-decoder contention appears. Treat as a verified extension, not free reuse. |
| 3 | **Partial-accept id-dependency chains** (blade tails, ripple splits) — general resolution is genuinely hard. | v1 allows partial accept **only among independent ops**; scan args for ids introduced earlier in the `opLog` and force dependents into the same decision; atomic re-validation at commit fails the whole accept transactionally rather than partially. Disclose the limit in the UI. |
| 4 | **In-renderer Anthropic API-key handling** — leak risk. | Route through existing `settingsGet`/`settingsSet` (server-side), **never** `localStorage`; never log the key; the offline heuristic Rough Cut path (Phases 1–2) needs no network at all, preserving the "fully local" framing as the default. |
| 5 | **Ghost-diff redraw storm** on long sequences (1000s of clips) — an id-diff over spine+connected on every streamed tool call. | Throttle the overlay pass exactly like the existing 250ms autosave debounce; diff is O(n) reference-inequality (structural sharing), not deep compare; batch per-turn, not per-token. |

---

## 6. The 60-Second Killer Demo

> **[0:00]** Magnetic is open, a raw **12-minute** unscripted talking-head recording loaded on the real timeline. The presenter says: *"I recorded way more than I can edit."*
>
> **[0:08]** Click one button — **Rough Cut**. A progress toast walks *transcribe → plan → preview* (whisper.cpp runs locally). Within seconds, **red hatch-strikethrough sweeps across ~40 spans of silence and filler** on the actual timeline, and translucent green ghost clips show the tightened result underneath. Nothing has committed yet.
>
> **[0:22]** *"See it before I accept it."* Click **Accept** — the timeline snaps to a tight **~4-minute** cut in one visible transition, short dissolves smoothing each jump cut. A change-list on the left reads *"Removed 38 silences and fillers, added 12 dissolves."*
>
> **[0:34]** *"It cut a joke I wanted."* Click the colored **AI badge** on that one edit point → **Reject**. That single cut restores; the other 37 stay. No modal, no diff dump — one click.
>
> **[0:42]** Open the split-screen review on a lower-third the Copilot added: **left = the original, right = the new cut, both real video** rendered by the actual playback engine, scrubbing across exactly the changed range.
>
> **[0:50]** Pick up the **blade tool** and manually tighten one more transition by hand — same timeline, same tools. Then hit the existing **Export** button. Point out: *the agent could generate and self-check, but it could never ship — only I can.*
>
> **[0:58]** Press **`Ctrl+Z`**. The entire agent rough-cut pass vanishes in **one keystroke** and the full 20 minutes returns — because it always was one undo entry. *"Same file, same undo stack, no cloud upload, no black box. The agent and I were editing the same timeline the whole time."*

*Total human time: ~90 seconds of judgment instead of 20 minutes of logging raw tape.*

---

*Synthesis complete. Anchor: Embedded Copilot's ghost-diff trust core. Front door: Rough Cut First's one-button wedge. Spine for later: Magnetic Protocol's MCP door. The kernel that makes all three cheap — `src/shared/timeline/`'s pure, typed-inverse, groupable ops — already ships.*

---

## Appendix: the six original proposals

### Magnetic Protocol: LSP for Video Editing
*Any agent, any harness, one undo stack — agent edits are just human edits that happen to arrive over MCP.*

**Week-one quick win:** By end of week 1 (Phase 1): open a real .mglib project in Magnetic, connect Claude Code to it via MCP, and ask "what happens in the first 30 seconds of this cut?" — get back an accurate structured answer (clip names, timecodes, transcript excerpts, any silence gaps) computed live from the actually-open Sequence, with zero video decoding and a visible Agent Access toggle in Settings proving the surface exists and can be switched off.

### Embedded Copilot: The Timeline Never Lies
*Cursor-for-video: the agent proposes, ghost-renders on the real timeline, and only ever commits through the same undo stack the human uses.*

**Week-one quick win:** Phase 1 (read-only advisor) is fully demoable within a week: it's a chat panel + existing transcript/silence context + the claude-api skill's tool-calling pattern, with zero kernel or UndoStack changes — no risk of a bad agent edit ever reaching the sequence, because it can't call mutating tools yet.

### Timeline-as-Text: The EDL Is the Pull Request
*Every edit is a diff. Every diff has a face.*

**Week-one quick win:** Phase 1 alone, shippable in the first week: a new 'Text' tab that renders the live sequence as canonical, human-readable YAML (clip names, timecodes, fx, keyframes, transitions, captions all visible) that updates as you edit in the GUI, plus Export/Import EDL menu items — provable with a round-trip test suite and a rendered panel, no agent or merge logic required yet.

### The Rough-Cut Factory
*Drop raw footage in. Get a polish-ready cut out. Same Sequence, same Timeline, same undo stack — the agent's draft and the human's edit are literally the same file.*

**Week-one quick win:** Phase 1 alone, buildable in the first week because it's almost entirely composition of things that already ship: transcription, silence/envelope detection, ops.ts, captions, and the Panel/Splitter shell. Demo: drop 2-3 raw clips, right-click -> Generate Rough Cut, a card appears in a new Queue tab, click Open, and a real editable Magnetic project loads with silence and rambling trimmed, clips in story order, and burned captions — built entirely from existing pipelines wired to a ~600-line new pure story module.

### Shared Spine
*One timeline, many hands — every cut remembers who made it, every actor knows their lane.*

**Week-one quick win:** Phase 1 alone, buildable in the first week: colored per-clip attribution tags and a hover history popover, backed by AttributedLog wrapping the existing UndoStack unmodified. Zero kernel changes, zero agent required yet, fully demoable, and it's the exact plumbing every later phase depends on — the human can already see "who (well, which past self) touched this clip and when" before a single AI agent exists.

### Rough Cut First: The Talking-Head Cleanup Wedge
*Record more than you can edit. Let the agent make the first cut, on your real timeline.*

**Week-one quick win:** Phase 1 alone, buildable in the first week: detectFillers() is ~40 lines modeled directly on detect.ts's existing detectSilence(); the executor is a copy of timeline-store.ts's existing beginGroup/rippleDelete/endGroup pattern with rippleDeleteRange substituted in; the button and slider reuse SilencePanel.tsx's existing layout. No new IPC, no new kernel op, no new job — everything routes through code that already exists and already works.
