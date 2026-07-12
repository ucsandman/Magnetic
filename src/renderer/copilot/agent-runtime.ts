import Anthropic from '@anthropic-ai/sdk'
import type { Sequence } from '../../shared/timeline/model'
import { EDIT_TOOLS, executeEditTool } from './tools'

/**
 * Copilot runtime. Phase 4: the model edits through kernel-op tools executed
 * against a SCRATCH sequence — never the store, never the undo stack. The
 * turn's outcome is a proposal the human accepts or discards (ghost-diff).
 * The API key arrives from main via settingsGet and lives only in memory
 * here; it is never logged and never touches localStorage.
 */

export const COPILOT_MODEL = 'claude-opus-4-8'
/** Runaway guard: a turn gets at most this many model↔tools round-trips. */
const MAX_TOOL_ITERATIONS = 12

/**
 * Frozen system prompt — byte-stable so the prompt-cache prefix survives
 * across turns. Volatile content (timeline context, chat turns) comes after.
 */
const SYSTEM_PROMPT = `You are the editing copilot inside Magnetic, a magnetic-timeline video editor. You can see the open sequence, its detected dead air, and its transcript in the context block that follows.

You edit through tools, but every tool call runs against a WORKING COPY of the timeline. Nothing you do is applied: when your turn ends, the human sees your changes as a ghost preview on their timeline plus a change list, and chooses Accept or Discard. You cannot export, save, or touch anything outside the working copy.

Rules:
- Ground every claim in the context. If the context doesn't show something (no transcript yet, analysis running), say so plainly instead of guessing.
- Reference moments as m:ss.s sequence timecodes, matching the context's format. Address clips by their [id=…] from the context.
- Only make edits the user actually asked for; for pure questions, just answer — no tools.
- After a batch of edits, call read_timeline once to verify the working copy looks right, then summarize what you changed and why in one short paragraph.
- A failed tool call returns a typed error — correct the input and retry, or explain why the edit isn't possible.
- Be concise. An editor mid-session wants the answer, not an essay.`

export interface AdvisorTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface CopilotTurnRequest {
  apiKey: string
  /** buildCopilotContext output for the BASE sequence. */
  context: string
  /** Full chat history, latest user question last. */
  turns: AdvisorTurn[]
  /** The sequence the scratch starts from (the store's current sequence). */
  base: Sequence
  /** Perception of an arbitrary scratch — backs the read_timeline tool. */
  contextOf(scratch: Sequence): string
  onDelta(text: string): void
  /** Latest sequence time a tool call referenced (agent playhead). */
  onToolTime?(flicks: number): void
  signal?: AbortSignal
}

export interface CopilotTurnResult {
  reply: string
  /** Plain-English change list — one entry per successful, change-producing call. */
  changes: string[]
  /** Scratch after the turn; === base when nothing changed. */
  proposed: Sequence
}

const READ_TIMELINE_TOOL: Anthropic.Tool = {
  name: 'read_timeline',
  description:
    'Re-read the WORKING COPY of the timeline (same format as the context block). Call after edits to verify the result.',
  input_schema: { type: 'object', properties: {} }
}

/**
 * Test-build stub (window.api.__test is only exposed under MAGNETIC_TEST):
 * E2E installs __magneticFakeAdvisor to capture the exact context/question the
 * runtime would send and script the turn — a string reply, or a reply plus
 * tool calls that run through the REAL executor. No network, no key.
 */
type FakeAdvisorResult = string | { reply: string; toolCalls?: { name: string; input: unknown }[] }
type FakeAdvisor = (input: { context: string; question: string }) => FakeAdvisorResult

function fakeAdvisor(): FakeAdvisor | null {
  const hooked = window as unknown as {
    api?: { __test?: unknown }
    __magneticFakeAdvisor?: FakeAdvisor
  }
  if (hooked.api?.__test === undefined) return null
  return typeof hooked.__magneticFakeAdvisor === 'function' ? hooked.__magneticFakeAdvisor : null
}

async function streamFakeTurn(
  request: CopilotTurnRequest,
  fake: FakeAdvisor
): Promise<CopilotTurnResult> {
  const question = [...request.turns].reverse().find((turn) => turn.role === 'user')?.text ?? ''
  const result = fake({ context: request.context, question })
  const reply = typeof result === 'string' ? result : result.reply
  const toolCalls = typeof result === 'string' ? [] : (result.toolCalls ?? [])
  let scratch = request.base
  const changes: string[] = []
  for (const call of toolCalls) {
    const outcome = executeEditTool(scratch, call.name, call.input)
    scratch = outcome.next
    if (outcome.summary !== null) changes.push(outcome.summary)
    if (outcome.timeRefFlicks !== null) request.onToolTime?.(outcome.timeRefFlicks)
  }
  // stream in a few chunks so the UI's streaming path is actually exercised
  const step = Math.max(1, Math.ceil(reply.length / 3))
  for (let i = 0; i < reply.length; i += step) {
    request.onDelta(reply.slice(i, i + step))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { reply, changes, proposed: scratch }
}

/**
 * One copilot turn: a streaming manual tool loop. Edits execute against a
 * scratch copy via executeEditTool (kernel ops + validate gate); the caller
 * turns a changed scratch into a pendingProposal for the ghost-diff review.
 */
export async function streamCopilotTurn(request: CopilotTurnRequest): Promise<CopilotTurnResult> {
  const fake = fakeAdvisor()
  if (fake !== null) return streamFakeTurn(request, fake)

  const client = new Anthropic({
    apiKey: request.apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' }
  })
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT },
    // breakpoint after the context: tools + system prompt + perception cache
    // as one prefix, re-billed only when the sequence actually changes
    { type: 'text', text: request.context, cache_control: { type: 'ephemeral' } }
  ]
  const messages: Anthropic.MessageParam[] = request.turns.map((turn) => ({
    role: turn.role,
    content: turn.text
  }))
  const tools: Anthropic.Tool[] = [...EDIT_TOOLS, READ_TIMELINE_TOOL]

  let scratch = request.base
  const changes: string[] = []
  const replyParts: string[] = []

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const stream = client.messages.stream({
      model: COPILOT_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      tools,
      messages
    })
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', () => stream.abort(), { once: true })
    }
    stream.on('text', (delta) => request.onDelta(delta))
    const message = await stream.finalMessage()
    replyParts.push(
      ...message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
    )

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content })
      continue
    }
    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    )
    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { reply: replyParts.join(''), changes, proposed: scratch }
    }

    messages.push({ role: 'assistant', content: message.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const toolUse of toolUses) {
      if (toolUse.name === READ_TIMELINE_TOOL.name) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: request.contextOf(scratch)
        })
        continue
      }
      const outcome = executeEditTool(scratch, toolUse.name, toolUse.input)
      scratch = outcome.next
      if (outcome.summary !== null) changes.push(outcome.summary)
      if (outcome.timeRefFlicks !== null) request.onToolTime?.(outcome.timeRefFlicks)
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: outcome.resultText,
        is_error: outcome.ok ? undefined : true
      })
    }
    messages.push({ role: 'user', content: results })
  }

  request.onDelta('\n\n[stopped: tool-iteration cap reached — review what was proposed so far]')
  return {
    reply: replyParts.join('') + '\n[stopped at the tool-iteration cap]',
    changes,
    proposed: scratch
  }
}

/** Friendly error line for the chat; never includes the key or raw headers. */
export function advisorErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'That API key was rejected — check it in the key settings below.'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the API — wait a moment and try again.'
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API — check your connection.'
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
