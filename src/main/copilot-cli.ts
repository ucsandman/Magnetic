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
