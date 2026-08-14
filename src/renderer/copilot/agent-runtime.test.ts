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
