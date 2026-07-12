import { useEffect, useRef, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Sequence } from '../../shared/timeline/model'
import type { AudioEnvelope, LibrarySnapshot } from '../../shared/types'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { ensureTranscripts } from '../transcript/cache'
import { buildCopilotContext } from './context'
import { scoreFlow } from './flow-score'
import { executeEditTool } from './tools'

/**
 * The external-agent gateway: executes tool calls the sidecar forwards from
 * MCP clients (Claude Code, any harness). Reads answer from the live store;
 * WRITES only ever become a pendingProposal — the same ghost-diff gate as the
 * in-app copilot, labeled 'Agent' so the timeline banner surfaces it. The
 * agent then polls get_status for the human's verdict. Mounted always;
 * requests only arrive while the sidecar is enabled.
 */

const envelopeCache = new Map<string, AudioEnvelope>()

async function ensureEnvelopes(
  sequence: Sequence,
  snapshot: LibrarySnapshot
): Promise<Map<string, AudioEnvelope>> {
  const wanted = new Set<string>()
  for (const item of sequence.spine) if (item.kind === 'clip') wanted.add(item.assetId)
  for (const cc of sequence.connected) if (cc.titleData === undefined) wanted.add(cc.assetId)
  await Promise.all(
    [...wanted].map(async (assetId) => {
      if (envelopeCache.has(assetId)) return
      const url = snapshot.assets[assetId]?.envelopeUrl
      if (url === undefined) return
      try {
        const response = await fetch(url)
        if (response.ok) envelopeCache.set(assetId, (await response.json()) as AudioEnvelope)
      } catch {
        // analysis missing — the context/flow simply won't include it
      }
    })
  )
  const result = new Map<string, AudioEnvelope>()
  for (const assetId of wanted) {
    const envelope = envelopeCache.get(assetId)
    if (envelope !== undefined) result.set(assetId, envelope)
  }
  return result
}

type Outcome = 'accepted' | 'discarded' | null

async function handleAgentTool(
  tool: string,
  input: unknown,
  snapshot: LibrarySnapshot | null,
  lastOutcome: { current: Outcome }
): Promise<unknown> {
  const store = useTimelineStore.getState()
  const sequence = store.sequence
  if (sequence === null || snapshot === null) {
    return { error: 'no project is open in the editor' }
  }
  const assetNames = new Map(
    Object.values(snapshot.assets).map((asset) => [asset.id, asset.fileName])
  )

  switch (tool) {
    case 'read_timeline': {
      const [transcripts, envelopes] = await Promise.all([
        ensureTranscripts(sequence, snapshot),
        ensureEnvelopes(sequence, snapshot)
      ])
      return { ok: true, text: buildCopilotContext(sequence, transcripts, envelopes, assetNames) }
    }
    case 'check_flow': {
      const envelopes = await ensureEnvelopes(sequence, snapshot)
      const report = scoreFlow(sequence, envelopes)
      return { ok: true, score: report.score, flags: report.flags }
    }
    case 'get_status': {
      const total = sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
      return {
        ok: true,
        projectOpen: true,
        spineItems: sequence.spine.length,
        durationSec: Math.round((total / FLICKS_PER_SECOND) * 10) / 10,
        proposalPending: store.pendingProposal !== null,
        lastOutcome: lastOutcome.current
      }
    }
    case 'propose_edits': {
      const record = input as { ops?: unknown } | null
      const ops = Array.isArray(record?.ops)
        ? (record.ops as { name?: unknown; input?: unknown }[])
        : null
      if (ops === null || ops.length === 0) {
        return { error: 'propose_edits needs { ops: [{ name, input }, …] }' }
      }
      if (store.pendingProposal !== null) {
        return { error: 'a proposal is already awaiting human review — poll get_status' }
      }
      let scratch = sequence
      const executed: { name: string; input: unknown; summary: string }[] = []
      const results: string[] = []
      for (const op of ops) {
        if (typeof op.name !== 'string') return { error: 'every op needs a string name' }
        const outcome = executeEditTool(scratch, op.name, op.input)
        scratch = outcome.next
        results.push(`${op.name}: ${outcome.resultText}`)
        if (outcome.summary !== null) {
          executed.push({ name: op.name, input: op.input, summary: outcome.summary })
        }
      }
      if (scratch === sequence || executed.length === 0) {
        return { error: 'the ops changed nothing', results }
      }
      lastOutcome.current = null
      if (!useTimelineStore.getState().proposeCopilotChanges(scratch, executed, 'Agent')) {
        return { error: 'the proposal failed the timeline invariant gate', results }
      }
      return {
        ok: true,
        presented: true,
        changes: executed.map((op) => op.summary),
        results,
        note: 'the human sees a ghost-diff preview now — poll get_status for their verdict; nothing is applied until they Accept'
      }
    }
    default:
      return { error: `unknown tool "${tool}"` }
  }
}

export function AgentGateway(): ReactNode {
  const { snapshot } = useLibrary()
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    const lastOutcome: { current: Outcome } = { current: null }
    // verdict tracking: an 'Agent' proposal leaving the slot was either
    // accepted (the sequence moved off its base) or discarded (it didn't)
    let watched: { baseSequence: Sequence } | null = null
    const unsubscribeStore = useTimelineStore.subscribe((state) => {
      const pending = state.pendingProposal
      if (pending !== null && pending.label === 'Agent') {
        watched = { baseSequence: pending.baseSequence }
      } else if (pending === null && watched !== null) {
        lastOutcome.current = state.sequence !== watched.baseSequence ? 'accepted' : 'discarded'
        watched = null
      }
    })
    const unsubscribeRequests = window.api.onAgentRequest(({ id, tool, input }) => {
      void handleAgentTool(tool, input, snapshotRef.current, lastOutcome)
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
        .then((result) => window.api.agentRespond(id, result))
    })
    return () => {
      unsubscribeStore()
      unsubscribeRequests()
    }
  }, [])

  return null
}
