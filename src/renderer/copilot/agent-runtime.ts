import Anthropic from '@anthropic-ai/sdk'

/**
 * Phase-3 copilot runtime: a READ-ONLY streaming advisor. No tools are
 * declared, so the model structurally cannot mutate the sequence — it answers
 * and suggests in plain language from the perception context (context.ts).
 * The API key arrives from main via settingsGet and lives only in memory here;
 * it is never logged and never touches localStorage.
 */

export const COPILOT_MODEL = 'claude-opus-4-8'

/**
 * Frozen system prompt — byte-stable so the prompt-cache prefix survives
 * across turns. Volatile content (timeline context, chat turns) comes after.
 */
const SYSTEM_PROMPT = `You are the editing copilot inside Magnetic, a magnetic-timeline video editor. You are in READ-ONLY advisor mode: you cannot change the timeline. You can see the open sequence, its detected dead air, and its transcript in the context block that follows.

Rules:
- Ground every claim in the context. If the context doesn't show something (no transcript yet, analysis running), say so plainly instead of guessing.
- Reference moments as m:ss.s sequence timecodes, matching the context's format.
- When asked for advice ("tighten this", "where does it drag?"), suggest specific, actionable edits with timecodes the editor can perform — you cannot perform them yourself yet.
- Be concise. An editor mid-session wants the answer, not an essay.`

export interface AdvisorTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface AdvisorRequest {
  apiKey: string
  /** buildCopilotContext output for the CURRENT sequence. */
  context: string
  /** Full chat history, latest user question last. */
  turns: AdvisorTurn[]
  onDelta(text: string): void
  signal?: AbortSignal
}

/**
 * Test-build stub (window.api.__test is only exposed under MAGNETIC_TEST):
 * E2E installs __magneticFakeAdvisor to capture the exact context/question
 * the runtime would send and script the streamed reply — no network, no key.
 */
type FakeAdvisor = (input: { context: string; question: string }) => string

function fakeAdvisor(): FakeAdvisor | null {
  const hooked = window as unknown as {
    api?: { __test?: unknown }
    __magneticFakeAdvisor?: FakeAdvisor
  }
  if (hooked.api?.__test === undefined) return null
  return typeof hooked.__magneticFakeAdvisor === 'function' ? hooked.__magneticFakeAdvisor : null
}

export async function streamAdvisorReply(request: AdvisorRequest): Promise<string> {
  const fake = fakeAdvisor()
  if (fake !== null) {
    const question = [...request.turns].reverse().find((turn) => turn.role === 'user')?.text ?? ''
    const reply = fake({ context: request.context, question })
    // stream in a few chunks so the UI's streaming path is actually exercised
    const step = Math.max(1, Math.ceil(reply.length / 3))
    for (let i = 0; i < reply.length; i += step) {
      request.onDelta(reply.slice(i, i + step))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return reply
  }

  const client = new Anthropic({
    apiKey: request.apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' }
  })
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT },
    // breakpoint after the context: system prompt + perception cache as one
    // prefix and only re-bill when the sequence actually changes
    { type: 'text', text: request.context, cache_control: { type: 'ephemeral' } }
  ]
  const messages: Anthropic.MessageParam[] = request.turns.map((turn) => ({
    role: turn.role,
    content: turn.text
  }))
  const stream = client.messages.stream({
    model: COPILOT_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    messages
  })
  if (request.signal !== undefined) {
    request.signal.addEventListener('abort', () => stream.abort(), { once: true })
  }
  stream.on('text', (delta) => request.onDelta(delta))
  const finalMessage = await stream.finalMessage()
  return finalMessage.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
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
