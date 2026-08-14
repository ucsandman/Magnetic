# Copilot on a Claude Subscription — Design

**Date:** 2026-08-14
**Status:** Approved direction (approach A), spec for implementation planning.
**Feature:** Let the in-app Copilot run on a user's Claude subscription (Pro/Max) through their locally installed Claude Code CLI, instead of requiring an Anthropic API key. The API-key path stays as a fallback.

## Problem

The Copilot (phases 3-8 of the agent-copilot roadmap) talks to the Anthropic API directly from the renderer with `@anthropic-ai/sdk` and a user-pasted API key. Most people do not have API keys; they have monthly subscription plans. Today those users cannot use the Copilot at all.

## Decision

Drive the user's own installed Claude Code CLI headlessly from the Electron main process. The CLI carries the user's claude.ai login, so usage bills to their subscription under their own agent — the policy-clean pattern. Magnetic's edit tools are served to the CLI over MCP through the existing Phase 7 agent-sidecar bridge.

Rejected alternatives:

- **Embedded Claude Agent SDK** — heavyweight dependency; a third-party app leaning on subscription credentials through an embedded SDK is a policy gray zone.
- **Paste an OAuth token from `claude setup-token`** — those tokens are for Claude Code clients only; using them against the raw API from a third-party app is unsupported.

## Mechanism proof (spike, 2026-08-14)

Ran on this machine before design approval:

- `claude -p` with `--output-format stream-json --include-partial-messages --strict-mcp-config --mcp-config <toy>` against a minimal stdio MCP server: **exit 0, 42 partial-stream events, tool round-trip confirmed** (`pong:` result came back through the model's reply).
- The final `result` event carries `session_id`, `stop_reason`, and usage — enables `--resume` chat continuity.
- **Finding:** `ANTHROPIC_API_KEY` in the environment silently overrides the claude.ai login (CLI warns on stderr). The app MUST strip it from the child env.
- Claude Code 2.1.232 installed; version detection via `claude --version` works.

Untested corner: image content blocks in MCP tool results (the `view_filmstrip` tool). Flagged as a risk with a degrade path, not a blocker.

## Architecture

### 1. Transport — `src/main/copilot-cli.ts` (new)

One child process per chat turn:

```
claude -p <prompt>
  --output-format stream-json --include-partial-messages --verbose
  --strict-mcp-config --mcp-config <generated per-turn config>
  --allowedTools "mcp__magnetic__*"
  --max-turns 12
  --append-system-prompt <existing SYSTEM_PROMPT from agent-runtime.ts>
  [--resume <session_id>]          # turns after the first
```

- **Env:** inherit, minus `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- **Binary resolution:** resolve `claude` on PATH at status-check time (Windows: handle `.cmd` shim). `MAGNETIC_CLAUDE_BIN` env override wins — this is also the E2E seam.
- **Session continuity:** store the `session_id` from each turn's `result` event in the chat store; pass `--resume` on the next turn. New chat = new session. The renderer stops resending full history on this transport.
- **Lifecycle:** abort signal and a 5-minute turn timeout both kill the child. Killed or failed turn produces no proposal.
- **Stream parsing:** newline-delimited JSON events. `stream_event` text deltas → `onDelta`; `result` event → turn completion metadata. Parser is a pure function, unit-tested against fixture lines captured from the spike.

### 2. Tool bridge — reuse Phase 7 plumbing

- `scripts/magnetic-mcp.mjs` gains a **copilot role** (env-selected, e.g. `MAGNETIC_MCP_ROLE=copilot` plus the loopback token/port as today).
- In copilot role the shim does not serve the gateway tools. At startup it **fetches its tool list from the app** over the loopback bridge: the fine-grained `EDIT_TOOLS` + `read_timeline` + `check_flow`, plus `view_filmstrip` only when the panel's vision toggle is on. Dynamic fetch means the toggle needs no shim changes.
- Tool calls travel: CLI → shim (stdio MCP) → loopback+token HTTP → main → correlated IPC → renderer. The renderer executes `executeEditTool` against the **same scratch sequence** as the API path, collects the same `CopilotOpEntry[]`, emits the same agent-playhead updates.
- Turn end: renderer builds the same `pendingProposal` ghost-diff; Accept/Discard unchanged. **The trust model does not change:** scratch-only edits, one undo entry per accepted turn, no export tool, provenance stays ephemeral.
- `view_filmstrip` returns an MCP image content block. If the CLI rejects image tool results, the tool returns text: "vision unavailable on subscription transport" (degrade, not block).

### 3. Settings and UX

- Settings schema: `copilotProvider: 'subscription' | 'apiKey'`. Default resolution at panel load: `subscription` when the CLI is detected, else `apiKey`. Existing `apiKey` setting untouched.
- CopilotPanel settings area becomes a provider picker with two cards:
  - **Claude subscription** — live status line ("Claude Code 2.1.232 found" / "Not found"), install+login guidance when missing, and a **Check again** button. No terminal steps required beyond the one-time Claude Code install/login, which is external by nature.
  - **API key** — the existing card, unchanged.
- New IPC `copilot:cliStatus` → `{ found: boolean, version?: string }` (runs `claude --version`, never a model call). Zod-validated like every channel (ipc.test.ts contract).

### 4. Runtime integration

- `agent-runtime.ts`: `streamCopilotTurn` becomes a transport switch. `provider: 'apiKey'` → existing SDK loop, byte-for-byte unchanged. `provider: 'subscription'` → IPC to main's `copilot-cli`, deltas streamed back over IPC push, tool execution stays renderer-side via the bridge (section 2).
- The `__magneticFakeAdvisor` test transport keeps working for the API path; the subscription path gets its own process-level fake (section 6).

### 5. Error handling

- Friendly chat lines, mapped next to `advisorErrorMessage`:
  - CLI not found → "Claude Code is not installed — install it and sign in once, then hit Check again."
  - Auth/login failure (stderr/exit mapping) → "Not signed in — open a terminal, run `claude`, and sign in once."
  - Timeout/kill → "The turn was stopped."
  - Nonzero exit otherwise → short stderr excerpt, never env vars, never tokens.
- Structured: child stderr captured to a ring buffer for the excerpt; nothing logged raw.

### 6. Testing

- **Unit:** stream-json parser (spike fixtures), arg builder (resume, allowedTools, append-system-prompt), env stripping (asserts the key vars are absent), error mapping.
- **E2E (`e2e/copilot-subscription.spec.ts`):** a fake `claude` Node script injected via `MAGNETIC_CLAUDE_BIN`. It emits scripted stream-json AND really connects to the MCP shim and calls edit tools — proving shim, loopback, IPC, scratch execution, ghost proposal, and Accept end to end with zero network. Cases: plain reply; tool-using turn → proposal → accept; CLI missing → status card guidance; abort mid-turn.
- **Live check (manual, end of implementation):** one real turn on the developer's actual subscription login — the verification the API path never got.

### 7. Docs

README + GUIDE.md: provider picker, subscription requirements (Claude Code installed + signed in), fallback API-key path. Same change set as the code.

## Files touched

| File | Change |
|---|---|
| `src/main/copilot-cli.ts` | new — spawn, stream parse, session, timeout |
| `src/main/agent-sidecar.ts` | extend — copilot-role tool serving over loopback |
| `scripts/magnetic-mcp.mjs` | copilot role + dynamic tool list fetch |
| `src/renderer/copilot/agent-runtime.ts` | transport switch |
| `src/renderer/copilot/CopilotPanel.tsx` | provider picker UI + status |
| shared settings schema + preload/IPC | `copilotProvider`, `copilot:cliStatus`, delta push channel |
| `e2e/copilot-subscription.spec.ts` | new |
| README, `docs/GUIDE.md` | provider docs |

## Non-goals

- No ChatGPT/Codex or generic-CLI provider (deferred; the transport switch leaves room).
- No in-app claude.ai OAuth.
- No change to the proposal gate, undo semantics, tool surface, or export prohibition.
- No packaged-app bundling of Claude Code; it is the user's install.

## Risks

1. **Filmstrip images over MCP** — untested; degrade path defined.
2. **Windows spawn quirks** (`claude.cmd`, PATH resolution from a packaged Electron app) — mitigated by explicit resolution + `MAGNETIC_CLAUDE_BIN` override.
3. **CLI flag drift across Claude Code versions** — flags used are the stable headless set; E2E fake pins our parser, live check catches drift.
4. **Latency** — per-turn spawn adds ~1-2s versus the SDK path; acceptable for chat, noted in docs.
