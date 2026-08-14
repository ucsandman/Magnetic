# Copilot on a Claude Subscription — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app Copilot run turns through the user's locally installed Claude Code CLI (billed to their Claude Pro/Max subscription) as an alternative transport to the existing API-key path.

**Architecture:** Main process spawns `claude -p --output-format stream-json` per chat turn. The CLI reaches Magnetic's edit tools through the existing MCP stdio shim (`scripts/magnetic-mcp.mjs`) in a new "copilot role", which talks to a new ephemeral loopback tool server in main, which forwards tool calls over IPC to the renderer where they execute against the same per-turn scratch sequence as the API path. Ghost-diff proposal, Accept/Discard, and undo semantics are untouched.

**Tech Stack:** Electron + TypeScript, zod-validated IPC, vitest (unit), Playwright `_electron` (E2E). Zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-copilot-subscription-design.md`

## Global Constraints

- **No new npm dependencies.** Everything here uses Node built-ins and existing deps (zod, zustand).
- **Every new IPC channel is zod-validated in `src/main/ipc.ts`** (repo invariant; `ipc.test.ts` asserts malformed payloads reject).
- **Child processes spawned for the CLI must strip `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from env** — otherwise the API key silently overrides the subscription login (proven in spike).
- **Never log tokens, env vars, or the loopback bearer token.** Test fixtures compose ids/tokens from plain words — the repo's secret-guard pre-commit hook blocks high-entropy literals in tracked files.
- **The subscription transport must not weaken the trust model:** tools execute only against the per-turn scratch; no export tool; proposal gate unchanged.
- Repo verify commands: `npm run typecheck`, `npm run lint`, `npm test`, `npx playwright test e2e/<spec>`.
- Commit format: plain imperative subject (repo style, e.g. `Copilot: …`), plus the session trailer lines used in this session.
- Windows is the primary platform. `claude` may resolve to a `.cmd` shim — spawn those via `cmd.exe /d /s /c`.

## Deviation from spec (decided during planning)

The spec said `--append-system-prompt <SYSTEM_PROMPT>`. The system prompt contains newlines and quotes; passing it as a command-line argument through a Windows `.cmd` shim (which requires `cmd.exe` quoting) is fragile. Instead, the first turn's stdin prompt carries the instructions as a delimited preamble (Task 6). The CLI's own system prompt is additive either way; behavior is equivalent and transport-safe. All other flags are quoting-safe tokens.

---

### Task 1: Pure CLI protocol helpers

**Files:**
- Create: `src/main/copilot-cli.ts` (pure section only in this task)
- Test: `src/main/copilot-cli.test.ts`

**Interfaces:**
- Consumes: nothing from this feature (first task).
- Produces (used by Tasks 2, 4):
  - `interface CliStatus { found: boolean; version: string | null; path: string | null }`
  - `function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `function buildCliArgs(options: { mcpConfigPath: string; resumeSessionId: string | null }): string[]`
  - `type StreamEvent = { kind: 'delta'; text: string } | { kind: 'result'; ok: boolean; reply: string; sessionId: string | null } | { kind: 'other' }`
  - `function parseStreamLine(line: string): StreamEvent`
  - `function cliErrorMessage(exitCode: number | null, stderrTail: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/copilot-cli.test.ts
import { describe, expect, it } from 'vitest'
import { buildCliArgs, childEnv, cliErrorMessage, parseStreamLine } from './copilot-cli'

// Shapes captured from the 2026-08-14 spike run (claude 2.1.232); ids
// replaced with word-composed fakes (secret-guard: no high-entropy literals).
const DELTA_LINE =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The"}},"session_id":"spike-session-words","parent_tool_use_id":null,"uuid":"spike-uuid-words"}'
const RESULT_LINE =
  '{"is_error":false,"duration_api_ms":11223,"num_turns":4,"stop_reason":"end_turn","session_id":"spike-session-words","total_cost_usd":0.27,"result":"It returned pong.","type":"result","subtype":"success"}'

describe('parseStreamLine', () => {
  it('extracts text deltas from stream_event lines', () => {
    expect(parseStreamLine(DELTA_LINE)).toEqual({ kind: 'delta', text: 'The' })
  })
  it('extracts reply and session id from the result line', () => {
    expect(parseStreamLine(RESULT_LINE)).toEqual({
      kind: 'result',
      ok: true,
      reply: 'It returned pong.',
      sessionId: 'spike-session-words'
    })
  })
  it('marks an error result as not ok', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'boom' })
    expect(parseStreamLine(line)).toEqual({ kind: 'result', ok: false, reply: 'boom', sessionId: null })
  })
  it('classifies non-delta events and garbage as other', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init"}').kind).toBe('other')
    expect(parseStreamLine('{"type":"assistant","message":{}}').kind).toBe('other')
    expect(parseStreamLine('not json').kind).toBe('other')
    expect(parseStreamLine('').kind).toBe('other')
  })
})

describe('childEnv', () => {
  it('strips the API auth vars and keeps the rest', () => {
    const env = childEnv({
      PATH: 'x',
      ANTHROPIC_API_KEY: 'placeholder-key-value',
      ANTHROPIC_AUTH_TOKEN: 'placeholder-token-value'
    })
    expect(env.PATH).toBe('x')
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false)
  })
})

describe('buildCliArgs', () => {
  it('builds the headless flag set with the mcp config', () => {
    expect(buildCliArgs({ mcpConfigPath: 'C:\\t\\m.json', resumeSessionId: null })).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config', 'C:\\t\\m.json',
      '--allowedTools', 'mcp__magnetic__*',
      '--max-turns', '12'
    ])
  })
  it('appends --resume when continuing a session', () => {
    const args = buildCliArgs({ mcpConfigPath: 'm.json', resumeSessionId: 'session-abc-words' })
    expect(args.slice(-2)).toEqual(['--resume', 'session-abc-words'])
  })
})

describe('cliErrorMessage', () => {
  it('maps login failures to sign-in guidance', () => {
    expect(cliErrorMessage(1, 'Invalid API key · Please run /login')).toMatch(/sign in/i)
    expect(cliErrorMessage(1, 'not logged in')).toMatch(/sign in/i)
  })
  it('falls back to a short excerpt for other failures', () => {
    const message = cliErrorMessage(1, 'something exploded')
    expect(message).toContain('something exploded')
    expect(message).toMatch(/exit code 1/i)
  })
  it('reports a kill (null exit code) as stopped', () => {
    expect(cliErrorMessage(null, '')).toMatch(/stopped/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/copilot-cli.test.ts`
Expected: FAIL — cannot resolve `./copilot-cli`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/copilot-cli.ts
/**
 * Subscription transport for the copilot: drives the user's locally installed
 * Claude Code CLI headlessly, so turns bill to their Claude subscription
 * login instead of an API key. This module owns the pure protocol pieces
 * (arg building, stream-json parsing, env hygiene, error mapping) plus CLI
 * resolution and the per-turn tool server. It must stay importable outside
 * Electron (unit tests run in plain node) — anything touching the electron
 * module lives in copilot-bridge.ts / copilot-turn.ts instead.
 */

export interface CliStatus {
  found: boolean
  version: string | null
  path: string | null
}

/**
 * The spike proved ANTHROPIC_API_KEY silently overrides the claude.ai login;
 * strip both auth vars so the subscription is what bills.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ANTHROPIC_API_KEY
  delete next.ANTHROPIC_AUTH_TOKEN
  return next
}

export function buildCliArgs(options: {
  mcpConfigPath: string
  resumeSessionId: string | null
}): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config', options.mcpConfigPath,
    '--allowedTools', 'mcp__magnetic__*',
    '--max-turns', '12'
  ]
  if (options.resumeSessionId !== null) args.push('--resume', options.resumeSessionId)
  return args
}

export type StreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'result'; ok: boolean; reply: string; sessionId: string | null }
  | { kind: 'other' }

export function parseStreamLine(line: string): StreamEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'other' }
  const event = parsed as {
    type?: unknown
    event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } }
    is_error?: unknown
    result?: unknown
    session_id?: unknown
  }
  if (
    event.type === 'stream_event' &&
    event.event?.type === 'content_block_delta' &&
    event.event.delta?.type === 'text_delta' &&
    typeof event.event.delta.text === 'string'
  ) {
    return { kind: 'delta', text: event.event.delta.text }
  }
  if (event.type === 'result') {
    return {
      kind: 'result',
      ok: event.is_error !== true,
      reply: typeof event.result === 'string' ? event.result : '',
      sessionId: typeof event.session_id === 'string' ? event.session_id : null
    }
  }
  return { kind: 'other' }
}

/** Friendly chat line for a failed CLI turn; never includes env or tokens. */
export function cliErrorMessage(exitCode: number | null, stderrTail: string): string {
  if (exitCode === null) return 'The turn was stopped.'
  if (/log ?in|logged ?in|authentication|api key/i.test(stderrTail)) {
    return 'Claude Code is not signed in — open a terminal, run `claude`, sign in once, then try again.'
  }
  const excerpt = stderrTail.trim().slice(-300)
  return `Claude Code failed (exit code ${exitCode})${excerpt === '' ? '.' : `: ${excerpt}`}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/copilot-cli.test.ts`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit**

```bash
git add src/main/copilot-cli.ts src/main/copilot-cli.test.ts
git commit -m "Copilot subscription: pure CLI protocol helpers (args, stream-json, env, errors)"
```

---

### Task 2: CLI resolution + status IPC

**Files:**
- Modify: `src/main/copilot-cli.ts` (append)
- Modify: `src/shared/channels.ts` (add `copilotCliStatus`)
- Modify: `src/main/ipc.ts` (deps type + handler)
- Modify: `src/main/index.ts` (wire dep)
- Modify: `src/shared/ipc.ts` (`MagneticApi`)
- Modify: `src/preload/index.ts`
- Test: `src/main/copilot-cli.test.ts` (append)

**Interfaces:**
- Consumes: `CliStatus`, `childEnv` from Task 1.
- Produces:
  - main: `async function resolveClaudeCli(): Promise<CliStatus>` (caches after first success), `function resetCliCacheForTests(): void`, `function spawnCli(path: string, args: string[], env: NodeJS.ProcessEnv)` (used by Task 4).
  - renderer-visible: `window.api.copilotCliStatus(): Promise<{ found: boolean; version: string | null }>` (path stays main-side).
  - Channel name: `IPC.copilotCliStatus = 'copilotCli:status'`.

Resolution order: `MAGNETIC_CLAUDE_BIN` env (absolute path, used as-is — also the E2E seam) → `where claude` (win32) / `which claude` → first non-empty output line. Version: spawn the resolved path with `['--version']`, parse the first whitespace-separated token (`2.1.232 (Claude Code)` → `2.1.232`). Any spawn failure → `{ found: false, version: null, path: null }`.

- [ ] **Step 1: Write the failing tests** (append to `copilot-cli.test.ts`)

```ts
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach } from 'vitest'
import { resetCliCacheForTests, resolveClaudeCli } from './copilot-cli'

describe('resolveClaudeCli', () => {
  const savedBin = process.env.MAGNETIC_CLAUDE_BIN
  beforeEach(() => resetCliCacheForTests())
  afterEach(() => {
    if (savedBin === undefined) delete process.env.MAGNETIC_CLAUDE_BIN
    else process.env.MAGNETIC_CLAUDE_BIN = savedBin
    resetCliCacheForTests()
  })

  it('reports found with a version for a working MAGNETIC_CLAUDE_BIN override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fakecli-'))
    const cmdPath = join(dir, 'fake-claude.cmd')
    writeFileSync(cmdPath, '@echo 9.9.9 (fake)\r\n')
    process.env.MAGNETIC_CLAUDE_BIN = cmdPath
    const status = await resolveClaudeCli()
    expect(status).toEqual({ found: true, version: '9.9.9', path: cmdPath })
  })

  it('reports not found when the override does not exist', async () => {
    process.env.MAGNETIC_CLAUDE_BIN = join(tmpdir(), 'no-such-claude.exe')
    const status = await resolveClaudeCli()
    expect(status).toEqual({ found: false, version: null, path: null })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/copilot-cli.test.ts`
Expected: FAIL — `resolveClaudeCli` not exported.

- [ ] **Step 3: Implement** (append to `copilot-cli.ts`)

```ts
import { spawn } from 'child_process'
import { existsSync } from 'fs'

let cachedStatus: CliStatus | null = null

export function resetCliCacheForTests(): void {
  cachedStatus = null
}

/** True for Windows shell shims that need cmd.exe to execute. */
function needsCmdShell(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path)
}

/** Spawn a CLI path safely on Windows (.cmd shims run via cmd.exe). */
export function spawnCli(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ReturnType<typeof spawn> {
  if (needsCmdShell(path)) {
    return spawn('cmd.exe', ['/d', '/s', '/c', path, ...args], { env })
  }
  return spawn(path, args, { env })
}

function capture(path: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    const child = spawnCli(path, args, childEnv(process.env))
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.on('error', () => resolve({ code: -1, stdout: '' }))
    child.on('close', (code) => resolve({ code, stdout }))
  })
}

async function findCliPath(): Promise<string | null> {
  const override = process.env.MAGNETIC_CLAUDE_BIN
  if (override !== undefined && override !== '') {
    return existsSync(override) ? override : null
  }
  const finder = process.platform === 'win32' ? ['where', 'claude'] : ['which', 'claude']
  const { code, stdout } = await capture(finder[0], [finder[1]])
  if (code !== 0) return null
  const first = stdout.split(/\r?\n/).find((line) => line.trim() !== '')
  return first?.trim() ?? null
}

export async function resolveClaudeCli(): Promise<CliStatus> {
  if (cachedStatus?.found === true) return cachedStatus
  const path = await findCliPath()
  if (path === null) {
    cachedStatus = { found: false, version: null, path: null }
    return cachedStatus
  }
  const { code, stdout } = await capture(path, ['--version'])
  if (code !== 0) {
    cachedStatus = { found: false, version: null, path: null }
    return cachedStatus
  }
  const version = stdout.trim().split(/\s+/)[0] ?? null
  cachedStatus = { found: true, version: version === '' ? null : version, path }
  return cachedStatus
}
```

Note: `capture('where', ...)` — `where`/`which` have no `.cmd` suffix so `spawnCli` runs them directly; both are real executables.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/copilot-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the IPC channel**

In `src/shared/channels.ts`, after `agentFolderPickDialog`:

```ts
  /** renderer -> main: is Claude Code installed, which version. */
  copilotCliStatus: 'copilotCli:status',
```

In `src/main/ipc.ts`: add to the deps interface

```ts
  copilotCliStatus(): Promise<{ found: boolean; version: string | null }>
```

and in `registerIpc`:

```ts
  handleValidated(IPC.copilotCliStatus, z.undefined(), async () => deps.copilotCliStatus())
```

In `src/main/index.ts` `registerIpc({...})`, after `agentFolderPickDialog`:

```ts
    copilotCliStatus: async () => {
      const status = await resolveClaudeCli()
      return { found: status.found, version: status.version }
    },
```

with `import { resolveClaudeCli } from './copilot-cli'`.

In `src/shared/ipc.ts` `MagneticApi`, after `agentFolderPickDialog`:

```ts
  copilotCliStatus(): Promise<{ found: boolean; version: string | null }>
```

In `src/preload/index.ts`, after `agentFolderPickDialog`:

```ts
  copilotCliStatus: () => ipcRenderer.invoke(IPC.copilotCliStatus),
```

- [ ] **Step 6: Verify types and full unit suite**

Run: `npm run typecheck && npx vitest run src/main`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/copilot-cli.ts src/main/copilot-cli.test.ts src/shared/channels.ts src/shared/ipc.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "Copilot subscription: Claude Code detection + copilotCli:status channel"
```

---

### Task 3: Copilot tool server in main

**Files:**
- Modify: `src/main/copilot-cli.ts` (append — the server is electron-free)
- Create: `src/main/copilot-bridge.ts` (electron-touching renderer forwarder)
- Modify: `src/shared/channels.ts`, `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`
- Test: `src/main/copilot-cli.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 4, 5, 6):
  - `interface CopilotToolDef { name: string; description: string; inputSchema: unknown }`
  - `type ToolReply = { ok: boolean; content: unknown }`
  - `async function ensureCopilotToolServer(forward: (tool: string, input: unknown) => Promise<ToolReply>): Promise<{ port: number; token: string }>`
  - `function setTurnTools(tools: CopilotToolDef[]): void`
  - `async function stopCopilotToolServer(): Promise<void>`
  - copilot-bridge: `function forwardToolToRenderer(tool: string, input: unknown): Promise<ToolReply>`, `function resolveCopilotToolRequest(id: string, ok: boolean, content: unknown): void`
  - Channels: `copilotToolRequest: 'copilotTool:request'` (main→renderer push, `{ id, tool, input }`), `copilotToolRespond: 'copilotTool:respond'` (renderer→main invoke, `{ id, ok, content }`).
  - Renderer-visible: `window.api.onCopilotToolRequest(cb): () => void`, `window.api.copilotToolRespond(id: string, ok: boolean, content: unknown): Promise<void>`.

This is a structural clone of `agent-sidecar.ts`'s loopback server, with three differences: (1) the token/port are ephemeral and **never written to a discovery file** — they travel to the shim via the per-turn MCP config env; (2) the special tool name `__list_tools` answers from `setTurnTools` state instead of forwarding; (3) forwarded replies carry `{ ok, content }` so a failed edit-tool call becomes an HTTP 400 whose body the shim marks `isError` for the model.

HTTP contract (mirrors the sidecar): `POST /tool` with `authorization: Bearer <token>`, body `{"tool": string, "input": unknown}`. Reply `200 {"result": <content>}` on `ok: true`, `400 {"error": <String(content)>}` on `ok: false`, `401 {"error":"bad token"}` on bad auth. `__list_tools` replies `200 {"result": {"tools": CopilotToolDef[]}}`.

- [ ] **Step 1: Write the failing test** (append; uses a fake forwarder, no Electron)

```ts
import { ensureCopilotToolServer, setTurnTools, stopCopilotToolServer } from './copilot-cli'

describe('copilot tool server', () => {
  afterEach(async () => {
    await stopCopilotToolServer()
  })

  it('serves __list_tools from turn state and forwards other calls', async () => {
    const calls: { tool: string; input: unknown }[] = []
    const { port, token } = await ensureCopilotToolServer(async (tool, input) => {
      calls.push({ tool, input })
      return tool === 'boom' ? { ok: false, content: 'typed error' } : { ok: true, content: 'done' }
    })
    setTurnTools([{ name: 'blade', description: 'cut', inputSchema: { type: 'object' } }])

    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const list = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST', headers, body: JSON.stringify({ tool: '__list_tools', input: {} })
    })
    expect((await list.json()).result.tools[0].name).toBe('blade')

    const good = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST', headers, body: JSON.stringify({ tool: 'blade', input: { at: 1 } })
    })
    expect(good.status).toBe(200)
    expect((await good.json()).result).toBe('done')
    expect(calls).toEqual([{ tool: 'blade', input: { at: 1 } }])

    const bad = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST', headers, body: JSON.stringify({ tool: 'boom', input: {} })
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('typed error')

    const unauthorized = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer wrong-token-words' },
      body: JSON.stringify({ tool: 'blade', input: {} })
    })
    expect(unauthorized.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/copilot-cli.test.ts`
Expected: FAIL — `ensureCopilotToolServer` not exported.

- [ ] **Step 3: Implement the server** (append to `copilot-cli.ts`; copy the request-body handling shape — 1 MB cap, JSON parse guard — from `agent-sidecar.ts:105-123`)

```ts
import { randomUUID } from 'crypto'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'

export interface CopilotToolDef {
  name: string
  description: string
  inputSchema: unknown
}

export type ToolReply = { ok: boolean; content: unknown }

let toolServer: Server | null = null
let toolServerPort = 0
let toolServerToken = ''
const toolServerSockets = new Set<Socket>()
let turnTools: CopilotToolDef[] = []

export function setTurnTools(tools: CopilotToolDef[]): void {
  turnTools = tools
}

export async function ensureCopilotToolServer(
  forward: (tool: string, input: unknown) => Promise<ToolReply>
): Promise<{ port: number; token: string }> {
  if (toolServer !== null) return { port: toolServerPort, token: toolServerToken }
  toolServerToken = randomUUID()
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${toolServerToken}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'bad token' }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/tool') {
      res.writeHead(404).end(JSON.stringify({ error: 'unknown route' }))
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        try {
          const payload = JSON.parse(body) as { tool?: unknown; input?: unknown }
          if (typeof payload.tool !== 'string') throw new Error('missing tool name')
          if (payload.tool === '__list_tools') {
            res.writeHead(200).end(JSON.stringify({ result: { tools: turnTools } }))
            return
          }
          const reply = await forward(payload.tool, payload.input)
          if (reply.ok) res.writeHead(200).end(JSON.stringify({ result: reply.content }))
          else res.writeHead(400).end(JSON.stringify({ error: String(reply.content) }))
        } catch (error) {
          res.writeHead(400).end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          )
        }
      })()
    })
  })
  server.on('connection', (socket) => {
    toolServerSockets.add(socket)
    socket.on('close', () => toolServerSockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  toolServer = server
  const address = server.address()
  toolServerPort = typeof address === 'object' && address !== null ? address.port : 0
  return { port: toolServerPort, token: toolServerToken }
}

export async function stopCopilotToolServer(): Promise<void> {
  if (toolServer === null) return
  const closing = toolServer
  toolServer = null
  turnTools = []
  for (const socket of toolServerSockets) socket.destroy()
  toolServerSockets.clear()
  await new Promise<void>((resolve) => closing.close(() => resolve()))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/copilot-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the renderer forwarder** — `src/main/copilot-bridge.ts` (separate file so `copilot-cli.ts` stays importable in plain node; same correlated-push shape as `agent-sidecar.ts:61-82`):

```ts
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/channels'
import type { ToolReply } from './copilot-cli'

/**
 * Forwards copilot tool calls from the loopback tool server to the renderer,
 * where they execute against the active turn's scratch sequence. Correlated
 * push/respond, 30s timeout — the sidecar pattern.
 */
const pendingToolCalls = new Map<
  string,
  { resolve(reply: ToolReply): void; timer: NodeJS.Timeout }
>()

export function forwardToolToRenderer(tool: string, input: unknown): Promise<ToolReply> {
  const window = BrowserWindow.getAllWindows()[0]
  if (window === undefined) {
    return Promise.resolve({ ok: false, content: 'no editor window is open' })
  }
  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(id)
      resolve({ ok: false, content: 'the editor did not answer in time' })
    }, 30_000)
    pendingToolCalls.set(id, { resolve, timer })
    window.webContents.send(IPC.copilotToolRequest, { id, tool, input })
  })
}

export function resolveCopilotToolRequest(id: string, ok: boolean, content: unknown): void {
  const entry = pendingToolCalls.get(id)
  if (entry === undefined) return
  pendingToolCalls.delete(id)
  clearTimeout(entry.timer)
  entry.resolve({ ok, content })
}
```

- [ ] **Step 6: Wire the channels**

`src/shared/channels.ts`:

```ts
  /** main -> renderer push: one copilot tool call to run against the turn scratch. */
  copilotToolRequest: 'copilotTool:request',
  /** renderer -> main: the copilot turn executor's answer. */
  copilotToolRespond: 'copilotTool:respond',
```

`src/main/ipc.ts` deps + registration:

```ts
  copilotToolRespond(id: string, ok: boolean, content: unknown): void
```

```ts
  handleValidated(
    IPC.copilotToolRespond,
    z.object({ id: z.string(), ok: z.boolean(), content: z.unknown() }),
    async (payload) => {
      deps.copilotToolRespond(payload.id, payload.ok, payload.content)
    }
  )
```

`src/main/index.ts`:

```ts
    copilotToolRespond: (id, ok, content) => resolveCopilotToolRequest(id, ok, content),
```

`src/shared/ipc.ts` `MagneticApi`:

```ts
  onCopilotToolRequest(cb: (request: { id: string; tool: string; input: unknown }) => void): () => void
  copilotToolRespond(id: string, ok: boolean, content: unknown): Promise<void>
```

`src/preload/index.ts` (same listener shape as `onAgentRequest` at `src/preload/index.ts:45-52`):

```ts
  onCopilotToolRequest: (cb) => {
    const listener = (
      _event: unknown,
      request: { id: string; tool: string; input: unknown }
    ): void => cb(request)
    ipcRenderer.on(IPC.copilotToolRequest, listener)
    return () => ipcRenderer.removeListener(IPC.copilotToolRequest, listener)
  },
  copilotToolRespond: (id, ok, content) =>
    ipcRenderer.invoke(IPC.copilotToolRespond, { id, ok, content }),
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npx vitest run src/main`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/main/copilot-cli.ts src/main/copilot-cli.test.ts src/main/copilot-bridge.ts src/shared/channels.ts src/shared/ipc.ts src/main/ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "Copilot subscription: ephemeral loopback tool server + renderer forwarder"
```

---

### Task 4: Turn runner (spawn orchestration)

**Files:**
- Create: `src/main/copilot-turn.ts` (electron-touching orchestration)
- Modify: `src/shared/channels.ts`, `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/ipc.test.ts`, `src/main/index.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: `resolveClaudeCli`, `spawnCli`, `childEnv`, `buildCliArgs`, `parseStreamLine`, `cliErrorMessage`, `ensureCopilotToolServer`, `setTurnTools`, `CopilotToolDef` (Tasks 1-3); `forwardToolToRenderer` (Task 3).
- Produces (used by Task 6):
  - `async function runCopilotCliTurn(args): Promise<CliTurnResult>` and `function cancelCopilotCliTurn(turnId: string): void`
  - `type CliTurnResult = { ok: true; reply: string; sessionId: string | null } | { ok: false; message: string }`
  - Channels: `copilotCliTurn: 'copilotCli:turn'` (invoke), `copilotCliCancel: 'copilotCli:cancel'` (invoke), `copilotCliDelta: 'copilotCli:delta'` (main→renderer push `{ turnId, text }`).
  - Renderer-visible:
    - `window.api.copilotCliTurn(args: { turnId: string; prompt: string; resumeSessionId: string | null; tools: { name: string; description: string; inputSchema: unknown }[] }): Promise<CliTurnResult>`
    - `window.api.copilotCliCancel(turnId: string): Promise<void>`
    - `window.api.onCopilotCliDelta(cb: (delta: { turnId: string; text: string }) => void): () => void`

- [ ] **Step 1: Implement `src/main/copilot-turn.ts`**

```ts
import { app, BrowserWindow } from 'electron'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { IPC } from '../shared/channels'
import {
  buildCliArgs, childEnv, cliErrorMessage, ensureCopilotToolServer,
  parseStreamLine, resolveClaudeCli, setTurnTools, spawnCli, type CopilotToolDef
} from './copilot-cli'
import { forwardToolToRenderer } from './copilot-bridge'

/**
 * One subscription copilot turn = one headless `claude -p` child. The CLI
 * reaches the edit tools through the magnetic-mcp shim (copilot role), whose
 * port/token arrive via the per-turn MCP config. process.execPath +
 * ELECTRON_RUN_AS_NODE runs the shim without a separate Node install.
 */

const TURN_TIMEOUT_MS = 5 * 60_000
const activeTurns = new Map<string, { kill(): void }>()

function shimPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'magnetic-mcp.mjs')
    : join(app.getAppPath(), 'scripts', 'magnetic-mcp.mjs')
}

export type CliTurnResult =
  | { ok: true; reply: string; sessionId: string | null }
  | { ok: false; message: string }

export async function runCopilotCliTurn(args: {
  turnId: string
  prompt: string
  resumeSessionId: string | null
  tools: CopilotToolDef[]
}): Promise<CliTurnResult> {
  const status = await resolveClaudeCli()
  if (!status.found || status.path === null) {
    return {
      ok: false,
      message:
        'Claude Code is not installed — pick the API key provider, or install Claude Code and sign in.'
    }
  }
  const { port, token } = await ensureCopilotToolServer(forwardToolToRenderer)
  setTurnTools(args.tools)
  const configPath = join(app.getPath('temp'), `magnetic-copilot-${args.turnId}.json`)
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        magnetic: {
          command: process.execPath,
          args: [shimPath()],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            MAGNETIC_AGENT_PORT: String(port),
            MAGNETIC_AGENT_TOKEN: token,
            MAGNETIC_MCP_ROLE: 'copilot'
          }
        }
      }
    })
  )
  const child = spawnCli(
    status.path,
    buildCliArgs({ mcpConfigPath: configPath, resumeSessionId: args.resumeSessionId }),
    childEnv(process.env)
  )
  activeTurns.set(args.turnId, { kill: () => child.kill() })
  child.stdin?.write(args.prompt)
  child.stdin?.end()

  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
  })
  let finalResult: { ok: boolean; reply: string; sessionId: string | null } | null = null
  const window = BrowserWindow.getAllWindows()[0]
  if (child.stdout !== null) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const event = parseStreamLine(line)
      if (event.kind === 'delta') {
        window?.webContents.send(IPC.copilotCliDelta, { turnId: args.turnId, text: event.text })
      } else if (event.kind === 'result') {
        finalResult = { ok: event.ok, reply: event.reply, sessionId: event.sessionId }
      }
    })
  }
  const timeout = setTimeout(() => child.kill(), TURN_TIMEOUT_MS)
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (exitCode) => resolve(exitCode))
  })
  clearTimeout(timeout)
  activeTurns.delete(args.turnId)
  try {
    rmSync(configPath)
  } catch {
    // best effort
  }
  if (finalResult !== null && finalResult.ok) {
    return { ok: true, reply: finalResult.reply, sessionId: finalResult.sessionId }
  }
  if (finalResult !== null) {
    return {
      ok: false,
      message: finalResult.reply !== '' ? finalResult.reply : cliErrorMessage(code, stderrTail)
    }
  }
  return { ok: false, message: cliErrorMessage(code, stderrTail) }
}

/** PID-safe: kills the tracked child process object, never a process name. */
export function cancelCopilotCliTurn(turnId: string): void {
  activeTurns.get(turnId)?.kill()
}
```

- [ ] **Step 2: Wire channels**

`src/shared/channels.ts`:

```ts
  /** renderer -> main: run one subscription copilot turn through the Claude Code CLI. */
  copilotCliTurn: 'copilotCli:turn',
  copilotCliCancel: 'copilotCli:cancel',
  /** main -> renderer push: streaming text delta for the running CLI turn. */
  copilotCliDelta: 'copilotCli:delta',
```

`src/main/ipc.ts` deps:

```ts
  copilotCliTurn(args: {
    turnId: string
    prompt: string
    resumeSessionId: string | null
    tools: { name: string; description: string; inputSchema: unknown }[]
  }): Promise<
    { ok: true; reply: string; sessionId: string | null } | { ok: false; message: string }
  >
  copilotCliCancel(turnId: string): void
```

registrations:

```ts
  handleValidated(
    IPC.copilotCliTurn,
    z.object({
      turnId: z.string().min(1),
      prompt: z.string().min(1),
      resumeSessionId: z.string().nullable(),
      tools: z.array(
        z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })
      )
    }),
    async (payload) => deps.copilotCliTurn(payload)
  )
  handleValidated(IPC.copilotCliCancel, z.object({ turnId: z.string() }), async (payload) => {
    deps.copilotCliCancel(payload.turnId)
  })
```

`src/main/index.ts`:

```ts
    copilotCliTurn: (args) => runCopilotCliTurn(args),
    copilotCliCancel: (turnId) => cancelCopilotCliTurn(turnId),
```

`src/shared/ipc.ts` `MagneticApi`:

```ts
  copilotCliTurn(args: {
    turnId: string
    prompt: string
    resumeSessionId: string | null
    tools: { name: string; description: string; inputSchema: unknown }[]
  }): Promise<
    { ok: true; reply: string; sessionId: string | null } | { ok: false; message: string }
  >
  copilotCliCancel(turnId: string): Promise<void>
  onCopilotCliDelta(cb: (delta: { turnId: string; text: string }) => void): () => void
```

`src/preload/index.ts`:

```ts
  copilotCliTurn: (args) => ipcRenderer.invoke(IPC.copilotCliTurn, args),
  copilotCliCancel: (turnId) => ipcRenderer.invoke(IPC.copilotCliCancel, { turnId }),
  onCopilotCliDelta: (cb) => {
    const listener = (_event: unknown, delta: { turnId: string; text: string }): void => cb(delta)
    ipcRenderer.on(IPC.copilotCliDelta, listener)
    return () => ipcRenderer.removeListener(IPC.copilotCliDelta, listener)
  },
```

- [ ] **Step 3: Extend the malformed-payload IPC contract test**

`src/main/ipc.test.ts` walks registered channels with junk payloads (see its existing table). Add entries: `copilotCli:turn` (junk: `{ turnId: 5 }`), `copilotCli:cancel` (junk: `{}`), `copilotTool:respond` (junk: `{ id: 1 }`), `copilotCli:status` (junk: `'x'` — must reject non-undefined). Follow the file's existing case format exactly.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run src/main`
Expected: clean, including the extended contract test.

- [ ] **Step 5: Commit**

```bash
git add src/main/copilot-turn.ts src/shared/channels.ts src/shared/ipc.ts src/main/ipc.ts src/main/ipc.test.ts src/main/index.ts src/preload/index.ts
git commit -m "Copilot subscription: CLI turn runner — spawn, stream, timeout, cancel"
```

---

### Task 5: MCP shim copilot role

**Files:**
- Modify: `scripts/magnetic-mcp.mjs`

**Interfaces:**
- Consumes: the tool server HTTP contract (Task 3): `__list_tools` → `{ tools: [...] }`; tool results may be `{ __image: { data, mimeType }, note }` (produced by Task 6's executor).
- Produces: when `MAGNETIC_MCP_ROLE=copilot`, `tools/list` returns the app-provided list; `tools/call` image results become MCP image content blocks. No behavior change when the env var is absent (agent-mcp.spec.ts must stay green).

- [ ] **Step 1: Dynamic tool list.** Replace the `tools/list` branch (`scripts/magnetic-mcp.mjs:191-194`) with:

```js
  if (method === 'tools/list') {
    if (process.env.MAGNETIC_MCP_ROLE === 'copilot') {
      void callSidecar('__list_tools', {})
        .then((result) => reply(id, { tools: result.tools }))
        .catch((error) =>
          replyError(id, error instanceof Error ? error.message : String(error))
        )
      return
    }
    reply(id, { tools: TOOLS })
    return
  }
```

- [ ] **Step 2: Image-aware tool results.** In the `tools/call` success branch (`scripts/magnetic-mcp.mjs:198-201`), map image payloads:

```js
      .then((result) => {
        if (result !== null && typeof result === 'object' && result.__image !== undefined) {
          reply(id, {
            content: [
              { type: 'image', data: result.__image.data, mimeType: result.__image.mimeType },
              { type: 'text', text: String(result.note ?? '') }
            ]
          })
          return
        }
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] })
      })
```

- [ ] **Step 3: Update the header comment** to mention the second role: driven by the editor itself (env `MAGNETIC_MCP_ROLE=copilot` + port/token env) as the in-app copilot's subscription transport.

- [ ] **Step 4: Smoke the shim against a stub server.** No test harness exists for `scripts/`; verify by hand. Write this throwaway to the session scratchpad (NOT the repo) as `shim-smoke.mjs`:

```js
// throwaway: boots a stub tool server, then drives the shim as a child
import { createServer } from 'http'
import { spawn } from 'child_process'
const TOKEN = 'shim-smoke-token-words'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const { tool } = JSON.parse(body)
    res.setHeader('content-type', 'application/json')
    if (tool === '__list_tools')
      res.end(JSON.stringify({ result: { tools: [{ name: 'blade', description: 'x', inputSchema: { type: 'object' } }] } }))
    else res.end(JSON.stringify({ result: { __image: { data: 'aGk=', mimeType: 'image/jpeg' }, note: 'strip' } }))
  })
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const shim = spawn('node', ['C:/Projects/final-cut-pro/scripts/magnetic-mcp.mjs'], {
    env: { ...process.env, MAGNETIC_MCP_ROLE: 'copilot', MAGNETIC_AGENT_PORT: String(port), MAGNETIC_AGENT_TOKEN: TOKEN }
  })
  shim.stdout.on('data', (d) => process.stdout.write(d))
  shim.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n')
  shim.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"blade","arguments":{}}}\n')
  setTimeout(() => process.exit(0), 2000)
})
```

Run: `node <scratchpad>/shim-smoke.mjs`
Expected: line 1 lists `blade`; line 2's content starts with an image block `{"type":"image","data":"aGk=","mimeType":"image/jpeg"}`.

- [ ] **Step 5: Commit**

```bash
git add scripts/magnetic-mcp.mjs
git commit -m "Copilot subscription: magnetic-mcp copilot role — dynamic tool list + image results"
```

---

### Task 6: Renderer subscription transport

**Files:**
- Modify: `src/renderer/copilot/agent-runtime.ts`
- Test: `src/renderer/copilot/agent-runtime.test.ts` (new)

**Interfaces:**
- Consumes: `window.api.copilotCliTurn/copilotCliCancel/onCopilotCliDelta/onCopilotToolRequest/copilotToolRespond` (Tasks 3-4); `EDIT_TOOLS`, `executeEditTool` from `./tools`; existing `CopilotTurnRequest`, `CopilotTurnResult`, `CopilotOpEntry`, `READ_TIMELINE_TOOL`, `CHECK_FLOW_TOOL`, `VIEW_FILMSTRIP_TOOL`, `SYSTEM_PROMPT` (export `SYSTEM_PROMPT`; the tool consts are already module-level).
- Produces (used by Task 7):
  - `interface SubscriptionTurnRequest extends Omit<CopilotTurnRequest, 'apiKey' | 'turns'> { question: string; resumeSessionId: string | null }`
  - `async function streamSubscriptionTurn(request: SubscriptionTurnRequest): Promise<CopilotTurnResult & { sessionId: string | null }>`
  - `function subscriptionToolDefs(options: { flow: boolean; vision: boolean }): { name: string; description: string; inputSchema: unknown }[]` (exported for tests)
  - `function buildSubscriptionPrompt(context: string, question: string, isFirstTurn: boolean): string` (exported for tests)

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/copilot/agent-runtime.test.ts
import { describe, expect, it } from 'vitest'
import { buildSubscriptionPrompt, subscriptionToolDefs, SYSTEM_PROMPT } from './agent-runtime'
import { EDIT_TOOLS } from './tools'

describe('subscriptionToolDefs', () => {
  it('maps every edit tool to MCP shape and always includes read_timeline', () => {
    const defs = subscriptionToolDefs({ flow: false, vision: false })
    const names = defs.map((def) => def.name)
    for (const tool of EDIT_TOOLS) expect(names).toContain(tool.name)
    expect(names).toContain('read_timeline')
    expect(names).not.toContain('check_flow')
    expect(names).not.toContain('view_filmstrip')
    const first = defs.find((def) => def.name === EDIT_TOOLS[0].name)
    expect(first?.inputSchema).toEqual(EDIT_TOOLS[0].input_schema)
  })
  it('adds check_flow and view_filmstrip when enabled', () => {
    const names = subscriptionToolDefs({ flow: true, vision: true }).map((def) => def.name)
    expect(names).toContain('check_flow')
    expect(names).toContain('view_filmstrip')
  })
})

describe('buildSubscriptionPrompt', () => {
  it('prefixes instructions and context on the first turn only', () => {
    const first = buildSubscriptionPrompt('CTX', 'trim the intro', true)
    expect(first).toContain(SYSTEM_PROMPT)
    expect(first).toContain('<timeline-context>')
    expect(first).toContain('CTX')
    expect(first.endsWith('trim the intro')).toBe(true)
    expect(buildSubscriptionPrompt('CTX', 'now the outro', false)).toBe('now the outro')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/copilot/agent-runtime.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement.** Export `SYSTEM_PROMPT` (change `const SYSTEM_PROMPT` to `export const SYSTEM_PROMPT` at `agent-runtime.ts:21`). Append:

```ts
export interface SubscriptionTurnRequest extends Omit<CopilotTurnRequest, 'apiKey' | 'turns'> {
  question: string
  resumeSessionId: string | null
}

export function subscriptionToolDefs(options: { flow: boolean; vision: boolean }): {
  name: string
  description: string
  inputSchema: unknown
}[] {
  const passthrough = [
    READ_TIMELINE_TOOL,
    ...(options.flow ? [CHECK_FLOW_TOOL] : []),
    ...(options.vision ? [VIEW_FILMSTRIP_TOOL] : [])
  ]
  return [...EDIT_TOOLS, ...passthrough].map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.input_schema
  }))
}

export function buildSubscriptionPrompt(
  context: string,
  question: string,
  isFirstTurn: boolean
): string {
  if (!isFirstTurn) return question
  return [
    SYSTEM_PROMPT,
    'Your editing tools are the MCP tools on the "magnetic" server. The timeline may change between turns — in any turn where you will edit, call read_timeline first and work from what it returns.',
    '<timeline-context>',
    context,
    '</timeline-context>',
    question
  ].join('\n\n')
}

/**
 * One subscription turn: main drives the Claude Code CLI; tool calls come
 * back over IPC and execute here against the same scratch-sequence loop as
 * the API path. Same proposal contract: caller turns a changed scratch into
 * a pendingProposal ghost-diff.
 */
export async function streamSubscriptionTurn(
  request: SubscriptionTurnRequest
): Promise<CopilotTurnResult & { sessionId: string | null }> {
  const turnId = crypto.randomUUID()
  let scratch = request.base
  const ops: CopilotOpEntry[] = []

  const offTool = window.api.onCopilotToolRequest((call) => {
    void (async () => {
      if (call.tool === READ_TIMELINE_TOOL.name) {
        await window.api.copilotToolRespond(call.id, true, request.contextOf(scratch))
        return
      }
      if (call.tool === CHECK_FLOW_TOOL.name && request.flowOf !== undefined) {
        await window.api.copilotToolRespond(call.id, true, request.flowOf(scratch))
        return
      }
      if (call.tool === VIEW_FILMSTRIP_TOOL.name && request.filmstripOf !== undefined) {
        const clipId = (call.input as { clip_id?: unknown })?.clip_id
        const strip = typeof clipId === 'string' ? await request.filmstripOf(clipId) : null
        if (strip === null) {
          await window.api.copilotToolRespond(call.id, false, 'no filmstrip available for that clip id')
        } else {
          await window.api.copilotToolRespond(call.id, true, {
            __image: { data: strip.data, mimeType: strip.mediaType },
            note: strip.note
          })
        }
        return
      }
      const outcome = executeEditTool(scratch, call.tool, call.input)
      scratch = outcome.next
      if (outcome.summary !== null) {
        ops.push({ name: call.tool, input: call.input, summary: outcome.summary })
      }
      if (outcome.timeRefFlicks !== null) request.onToolTime?.(outcome.timeRefFlicks)
      await window.api.copilotToolRespond(call.id, outcome.ok, outcome.resultText)
    })()
  })
  const offDelta = window.api.onCopilotCliDelta((delta) => {
    if (delta.turnId === turnId) request.onDelta(delta.text)
  })
  const onAbort = (): void => void window.api.copilotCliCancel(turnId)
  request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await window.api.copilotCliTurn({
      turnId,
      prompt: buildSubscriptionPrompt(
        request.context,
        request.question,
        request.resumeSessionId === null
      ),
      resumeSessionId: request.resumeSessionId,
      tools: subscriptionToolDefs({
        flow: request.flowOf !== undefined,
        vision: request.filmstripOf !== undefined
      })
    })
    if (!result.ok) throw new Error(result.message)
    return { reply: result.reply, ops, proposed: scratch, sessionId: result.sessionId }
  } finally {
    offTool()
    offDelta()
    request.signal?.removeEventListener('abort', onAbort)
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/renderer/copilot/agent-runtime.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/agent-runtime.ts src/renderer/copilot/agent-runtime.test.ts
git commit -m "Copilot subscription: renderer transport — tool defs, prompt, scratch executor over IPC"
```

---

### Task 7: `copilotProvider` setting + provider UI

**Files:**
- Modify: `src/main/project-io/library.ts` (settings getter/setter, next to `getAnthropicApiKey` at `library.ts:37-46`)
- Modify: `src/main/ipc.ts` (settings shapes + zod), `src/main/ipc.test.ts`, `src/main/index.ts` (getSettings/setSettings wiring)
- Modify: `src/shared/ipc.ts` (MagneticApi settings types)
- Modify: `src/renderer/copilot/CopilotPanel.tsx`
- Modify: `e2e/copilot.spec.ts`, `e2e/denoise-flow.spec.ts`, `e2e/phase8.spec.ts` (pin detection off)
- Modify: the stylesheet holding `.copilot-setup` (add `.copilot-provider`)

**Interfaces:**
- Consumes: `streamSubscriptionTurn` (Task 6), `window.api.copilotCliStatus` (Task 2).
- Produces: `getSettings()` gains `copilotProvider: 'subscription' | 'apiKey' | null` (null = auto); `setSettings` accepts `copilotProvider?: 'subscription' | 'apiKey'`.

- [ ] **Step 1: Settings plumbing.**

`src/main/project-io/library.ts` (mirror the `anthropicApiKey` pattern at `library.ts:37-46`):

```ts
export function getCopilotProvider(): 'subscription' | 'apiKey' | null {
  const value = readSettings().copilotProvider
  return value === 'subscription' || value === 'apiKey' ? value : null
}

export function setCopilotProvider(provider: 'subscription' | 'apiKey'): void {
  writeSettings({ ...readSettings(), copilotProvider: provider })
}
```

(The settings object is a plain JSON bag; adding a key follows the existing pattern — check the `readSettings` type and extend it if it is typed.)

`src/main/ipc.ts`: add `copilotProvider: 'subscription' | 'apiKey' | null` to the `getSettings()` return type (`ipc.ts:80-86`), `copilotProvider?: 'subscription' | 'apiKey'` to `setSettings` (`ipc.ts:87-90`), and to the zod schema (`ipc.ts:150-158`):

```ts
        copilotProvider: z.enum(['subscription', 'apiKey']).optional(),
```

`src/main/index.ts`: add `copilotProvider: getCopilotProvider()` to the `getSettings` object (`index.ts:112-118`) and to `setSettings` (`index.ts:119-140`):

```ts
      if (settings.copilotProvider !== undefined) setCopilotProvider(settings.copilotProvider)
```

`src/shared/ipc.ts`: extend the `MagneticApi` `getSettings`/`setSettings` types to match.

- [ ] **Step 2: Extend the settings contract test**

`src/main/ipc.test.ts`: add one case — `settingsSet` with `{ copilotProvider: 'bogus' }` rejects; `{ copilotProvider: 'subscription' }` validates.

Run: `npx vitest run src/main/ipc.test.ts`
Expected: PASS.

- [ ] **Step 3: CopilotPanel UI + send() switch.**

State additions in `CopilotPanel` (near `CopilotPanel.tsx:46-55`):

```tsx
  const [cliStatus, setCliStatus] = useState<{ found: boolean; version: string | null } | null>(null)
  const [providerSetting, setProviderSetting] = useState<'subscription' | 'apiKey' | null>(null)
  const checkCli = (): void => {
    void window.api.copilotCliStatus().then(setCliStatus)
  }
```

Extend the mount effect (`CopilotPanel.tsx:57-62`) to also read `settings.copilotProvider` into `providerSetting` and call `checkCli()`.

Derived provider:

```tsx
  const provider: 'subscription' | 'apiKey' =
    providerSetting ?? (cliStatus?.found === true ? 'subscription' : 'apiKey')
```

Chat store: add `cliSessionId: string | null` + `setCliSessionId(id: string | null): void` to `useCopilotChat` (`CopilotPanel.tsx:21-38`).

Gates (replacing `CopilotPanel.tsx:241`):

```tsx
  const needsKey = provider === 'apiKey' && keyLoaded && (apiKey === null || editingKey)
  const needsCli = provider === 'subscription' && cliStatus !== null && !cliStatus.found
```

Provider block, rendered directly under the disclaimer div (`CopilotPanel.tsx:255-258`):

```tsx
      <div className="copilot-provider" data-testid="copilot-provider">
        <label>
          <input
            type="radio"
            name="copilot-provider"
            data-testid="provider-subscription"
            checked={provider === 'subscription'}
            onChange={() => {
              setProviderSetting('subscription')
              void window.api.setSettings({ copilotProvider: 'subscription' })
            }}
          />
          <span>
            Claude subscription{' '}
            {cliStatus === null
              ? '(checking…)'
              : cliStatus.found
                ? `— Claude Code ${cliStatus.version ?? ''} found`
                : '— Claude Code not found'}
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="copilot-provider"
            data-testid="provider-apikey"
            checked={provider === 'apiKey'}
            onChange={() => {
              setProviderSetting('apiKey')
              void window.api.setSettings({ copilotProvider: 'apiKey' })
            }}
          />
          <span>API key</span>
        </label>
      </div>
      {needsCli && (
        <div className="copilot-setup" data-testid="copilot-cli-missing">
          <p>
            The subscription provider uses Claude Code, signed in with your Claude plan. Install it
            from claude.com/code, run it once to sign in, then check again — or switch to the API
            key provider above.
          </p>
          <button type="button" data-testid="copilot-cli-recheck" onClick={checkCli}>
            Check again
          </button>
        </div>
      )}
```

The chat area gate `{!needsKey && keyLoaded && (…)}` (`CopilotPanel.tsx:293`) becomes `{!needsKey && !needsCli && keyLoaded && (…)}`.

`send()` (`CopilotPanel.tsx:158-239`): the `apiKey === null` guard applies only when `provider === 'apiKey'`; subscription instead requires `cliStatus?.found === true`. Branch the call, keeping the `.then/.catch/.finally` chain identical:

```tsx
    const shared = {
      context: contextOf(sequence),
      base: sequence,
      contextOf,
      flowOf,
      filmstripOf: visionEnabled ? filmstripOf : undefined,
      signal: controller.signal,
      onDelta: (delta: string) => {
        const current = useCopilotChat.getState()
        current.setStreaming((current.streaming ?? '') + delta)
      },
      onToolTime: (flicks: number) => {
        useTimelineStore.getState().setAgentPlayhead(flicks)
      }
    }
    const turnPromise =
      provider === 'subscription'
        ? streamSubscriptionTurn({
            ...shared,
            question: text,
            resumeSessionId: useCopilotChat.getState().cliSessionId
          }).then((result) => {
            useCopilotChat.getState().setCliSessionId(result.sessionId)
            return result
          })
        : streamCopilotTurn({ ...shared, apiKey: apiKey as string, turns: nextTurns })
    void turnPromise
      .then(/* existing then body unchanged */)
      .catch(/* existing catch unchanged */)
      .finally(/* existing finally unchanged */)
```

Also: the `Key…` button (`CopilotPanel.tsx:429-436`) renders only when `provider === 'apiKey'`.

**Keep existing copilot E2E deterministic:** without `MAGNETIC_CLAUDE_BIN`, detection on the dev machine finds the real CLI and auto-selects subscription, which would bypass `__magneticFakeAdvisor`. Add to `launchApp`'s env in `e2e/copilot.spec.ts`, `e2e/denoise-flow.spec.ts`, and `e2e/phase8.spec.ts` (the specs that exercise the fake advisor):

```ts
    MAGNETIC_CLAUDE_BIN: 'C:\\nonexistent\\claude.exe',
```

so detection reports not-found and the provider auto-resolves to apiKey.

CSS: next to the existing `.copilot-setup` rules (find the stylesheet with `grep -rn "copilot-setup" src/renderer --include=*.css`):

```css
.copilot-provider {
  display: flex;
  gap: 12px;
  padding: 6px 10px;
  font-size: 12px;
  opacity: 0.9;
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all clean.

Run: `npx playwright test e2e/copilot.spec.ts`
Expected: existing copilot specs still green (apiKey path untouched, detection pinned not-found).

- [ ] **Step 5: Commit**

```bash
git add src/main/project-io/library.ts src/main/ipc.ts src/main/ipc.test.ts src/main/index.ts src/shared/ipc.ts src/renderer/copilot/CopilotPanel.tsx e2e/copilot.spec.ts e2e/denoise-flow.spec.ts e2e/phase8.spec.ts <stylesheet>
git commit -m "Copilot subscription: provider setting + picker UI, send() transport switch"
```

---

### Task 8: Fake claude binary + E2E

**Files:**
- Create: `e2e/fixtures/fake-claude.mjs`, `e2e/fixtures/fake-claude.cmd`
- Create: `e2e/copilot-subscription.spec.ts`

**Interfaces:**
- Consumes: everything shipped in Tasks 1-7; `MAGNETIC_CLAUDE_BIN` (Task 2); the per-turn MCP config format (Task 4).
- Produces: nothing downstream — this is the proof.

- [ ] **Step 1: Write the fake CLI.**

`e2e/fixtures/fake-claude.cmd`:

```bat
@node "%~dp0fake-claude.mjs" %*
```

`e2e/fixtures/fake-claude.mjs` — behaves like `claude` for exactly our call shape:

```js
#!/usr/bin/env node
/**
 * Fake `claude` for E2E: speaks just enough of the headless contract.
 * --version → prints a version. Otherwise: reads the prompt from stdin,
 * spawns the MCP server from --mcp-config, and — when the prompt asks for a
 * cut — REALLY calls the magnetic tools through it, then emits stream-json.
 * FAKE_CLAUDE_MODE=hang → never answers (abort test). =authfail → login error.
 */
import { readFileSync } from 'fs'
import { spawn } from 'child_process'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('9.9.9 (fake)\n')
  process.exit(0)
}
const mode = process.env.FAKE_CLAUDE_MODE ?? 'normal'
if (mode === 'authfail') {
  process.stderr.write('Invalid API key · Please run /login\n')
  process.exit(1)
}
if (mode === 'hang') {
  setTimeout(() => process.exit(1), 120_000) // killed by cancel long before this
} else {
  void main()
}

function argValue(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function delta(text) {
  emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  })
}

function rpc(child, id, method, params) {
  return new Promise((resolve) => {
    let buffered = ''
    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      let newline
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.id === id) {
          child.stdout.off('data', onData)
          resolve(message)
          return
        }
      }
    }
    child.stdout.on('data', onData)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function main() {
  const prompt = await readStdin()
  const resumed = argValue('--resume') !== null
  const config = JSON.parse(readFileSync(argValue('--mcp-config'), 'utf8'))
  const serverConfig = config.mcpServers.magnetic
  const child = spawn(serverConfig.command, serverConfig.args, {
    env: { ...process.env, ...serverConfig.env }
  })
  await rpc(child, 1, 'initialize', { protocolVersion: '2024-11-05' })
  const list = await rpc(child, 2, 'tools/list', {})
  const names = list.result.tools.map((tool) => tool.name)
  delta('Looking at the timeline. ')
  if (/cut the first second/i.test(prompt)) {
    // IMPLEMENTER: confirm the real range-delete tool name + schema in
    // src/renderer/copilot/tools.ts (EDIT_TOOLS, tools.ts:126) and adjust.
    if (!names.includes('ripple_delete_range')) {
      process.stderr.write(`fake-claude: edit tools missing, got ${names.join(',')}\n`)
      process.exit(1)
    }
    await rpc(child, 3, 'tools/call', {
      name: 'ripple_delete_range',
      arguments: { from_sec: 0, to_sec: 1 }
    })
    await rpc(child, 4, 'tools/call', { name: 'read_timeline', arguments: {} })
    delta('Cut proposed.')
  } else {
    delta('No edits needed.')
  }
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resumed ? 'resumed-session answer' : 'first-session answer',
    session_id: resumed ? 'fake-session-two' : 'fake-session-one'
  })
  child.kill()
  process.exit(0)
}
```

- [ ] **Step 2: Write the E2E spec.** Follow `e2e/copilot.spec.ts`'s launch/fixture pattern (temp library, media import via `window.api.__test.importPaths`, wait for envelopes). Launch env adds:

```ts
    MAGNETIC_CLAUDE_BIN: join(__dirname, 'fixtures', 'fake-claude.cmd'),
    FAKE_CLAUDE_MODE: mode // per-test
```

Cases:

1. **Subscription auto-selected + plain reply.** Open copilot tab → `provider-subscription` radio is checked and its label contains `9.9.9`. Ask "hello there" → streamed text appears in `copilot-streaming`, final turn shows `first-session answer`, no proposal rendered.
2. **Edit turn → ghost proposal → accept.** Ask "cut the first second" → `copilot-proposal` appears with ≥1 change; timeline duration shrinks only after clicking `copilot-accept`; one Ctrl+Z restores it (single undo group).
3. **Session resume.** After case 1's turn, send a second message → reply is `resumed-session answer` (proves `--resume fake-session-one` was passed).
4. **CLI missing → guidance + fallback.** Launch with `MAGNETIC_CLAUDE_BIN` pointing at a nonexistent path → `copilot-cli-missing` card visible with the `copilot-cli-recheck` button; selecting the `provider-apikey` radio shows the existing key card.
5. **Abort.** `FAKE_CLAUDE_MODE=hang`, send → click `copilot-stop` → `copilot-error` shows "stopped" within 5s and the input re-enables.

Use `expect.poll` for async predicates (repo E2E gotcha: `waitForFunction(async …)` resolves immediately — a pending Promise is truthy).

- [ ] **Step 3: Run the spec**

Run: `npx playwright test e2e/copilot-subscription.spec.ts`
Expected: 5/5 green. Debug tip: the fake's stderr lands in the Electron main-process output; read it before guessing.

- [ ] **Step 4: Make the check fail on purpose** (repo rule L1: a check never observed failing has been run, not verified). Temporarily make the fake's edit branch skip the `tools/call`, confirm case 2 FAILS (no proposal appears), revert.

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/fake-claude.mjs e2e/fixtures/fake-claude.cmd e2e/copilot-subscription.spec.ts
git commit -m "Copilot subscription: fake-claude fixture + E2E — provider pick, edit proposal, resume, missing CLI, abort"
```

---

### Task 9: Packaging, docs, full verify, live check

**Files:**
- Modify: `electron-builder.yml` (ship the shim in resources)
- Modify: `README.md`, `docs/GUIDE.md`

- [ ] **Step 1: Packaging.** In `electron-builder.yml`, add to (or create) the `extraResources` list, merging with the existing bin entry:

```yaml
extraResources:
  - from: scripts/magnetic-mcp.mjs
    to: magnetic-mcp.mjs
```

This matches `shimPath()`'s packaged branch (`process.resourcesPath/magnetic-mcp.mjs`, Task 4).

- [ ] **Step 2: Docs.** README "Copilot" section + `docs/GUIDE.md`: the two providers, that subscription needs Claude Code installed and signed in (one-time), that the API-key path is unchanged, the ~1-2s extra spawn latency, and that agent edits still land as ghost-diff proposals. Mention `MAGNETIC_CLAUDE_BIN` only in GUIDE.md (advanced/testing).

- [ ] **Step 3: Full verify — run and READ all of it**

```
npm run typecheck
npm run lint
npm test
npx playwright test e2e/copilot.spec.ts e2e/copilot-subscription.spec.ts e2e/agent-mcp.spec.ts e2e/denoise-flow.spec.ts e2e/phase8.spec.ts
```

Expected: all green (agent-mcp.spec proves the shim's original agent role did not regress).

- [ ] **Step 4: Live check on the real subscription (manual, with Wes).** Launch `npm run dev` with `ANTHROPIC_API_KEY` unset in that shell, pick the subscription provider, ask for one real edit on a scratch project, Accept it. This is the first-ever live-model verification of the copilot; record the outcome (model used, latency) in the summary. **Requires Wes present — pause here if running unattended.**

- [ ] **Step 5: Commit + wrap**

```bash
git add electron-builder.yml README.md docs/GUIDE.md
git commit -m "Copilot subscription: package the MCP shim, document the provider picker"
```

Report the CHANGES MADE / DEVIATIONS / VERIFICATION summary per the global working agreement.

---

## Plan self-review notes

- **Spec coverage:** transport (T1/T2/T4), tool bridge + shim role (T3/T5), settings/UX (T7), runtime switch (T6), error mapping (T1/T4), fake-claude E2E (T8), packaging/docs/live check (T9). Filmstrip degrade path: missing strip → `ok:false` text (T6); if the real CLI rejects image blocks, only the shim mapping changes — exercised in T9's live check when vision is toggled.
- **Type consistency:** `CopilotToolDef` = `{ name, description, inputSchema }` everywhere (T3 def, T4 zod, T6 producer). Tool reply contract `{ ok, content }` consistent T3↔T6. `CliTurnResult` shape identical in T4 main + shared types.
- **Known judgment points for the implementer:** exact edit-tool names in `tools.ts` (T8 fixture note), the stylesheet file for `.copilot-provider` (T7 grep), `readSettings`/`writeSettings` typing in `library.ts` (T7 note).
