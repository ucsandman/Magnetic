import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCliArgs,
  childEnv,
  cliErrorMessage,
  ensureCopilotToolServer,
  parseStreamLine,
  resetCliCacheForTests,
  resolveClaudeCli,
  setTurnTools,
  stopCopilotToolServer
} from './copilot-cli'

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
    expect(parseStreamLine(line)).toEqual({
      kind: 'result',
      ok: false,
      reply: 'boom',
      sessionId: null
    })
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
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config',
      'C:\\t\\m.json',
      '--allowedTools',
      'mcp__magnetic__*',
      '--disallowedTools',
      'Bash,Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite',
      '--max-turns',
      '12'
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
      method: 'POST',
      headers,
      body: JSON.stringify({ tool: '__list_tools', input: {} })
    })
    expect((await list.json()).result.tools[0].name).toBe('blade')

    const good = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool: 'blade', input: { at: 1 } })
    })
    expect(good.status).toBe(200)
    expect((await good.json()).result).toBe('done')
    expect(calls).toEqual([{ tool: 'blade', input: { at: 1 } }])

    const bad = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool: 'boom', input: {} })
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
