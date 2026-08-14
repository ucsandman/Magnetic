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
import { existsSync } from 'fs'

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
