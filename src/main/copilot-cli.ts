/**
 * Subscription transport for the copilot: drives the user's locally installed
 * Claude Code CLI headlessly, so turns bill to their Claude subscription
 * login instead of an API key. This module owns the pure protocol pieces
 * (arg building, stream-json parsing, env hygiene, error mapping) plus CLI
 * resolution and the per-turn tool server. It must stay importable outside
 * Electron (unit tests run in plain node) — anything touching the electron
 * module lives in copilot-bridge.ts / copilot-turn.ts instead.
 */

import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'

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
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfigPath,
    '--allowedTools',
    'mcp__magnetic__*',
    '--max-turns',
    '12'
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

/**
 * Loopback HTTP tool server for one copilot session (structural clone of
 * agent-sidecar.ts). Unlike the sidecar, the token/port never touch disk —
 * they travel to the CLI's stream-json shim via the per-turn MCP config env
 * — and __list_tools answers from setTurnTools instead of forwarding.
 */
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
