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
