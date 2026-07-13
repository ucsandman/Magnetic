import { useEffect, useRef, type ReactNode } from 'react'
import { DEFAULT_TARGET_LUFS, normalizeGainDb } from '../../shared/loudness'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { effectiveRole, type Sequence } from '../../shared/timeline/model'
import type { LibrarySnapshot } from '../../shared/types'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { ensureTranscripts } from '../transcript/cache'
import { DUCK_AMOUNT_DB, planDucking } from '../silence/ducking'
import { findQuote } from '../transcript/quote'
import { projectTranscript } from '../transcript/projection'
import { buildCopilotContext } from './context'
import { ensureEnvelopes } from './envelopes'
import { scoreFlow } from './flow-score'
import { executeEditBatch, executeEditTool } from './tools'

/**
 * The external-agent gateway: executes tool calls the sidecar forwards from
 * MCP clients (Claude Code, any harness). Reads answer from the live store;
 * WRITES only ever become a pendingProposal — the same ghost-diff gate as the
 * in-app copilot, labeled 'Agent' so the timeline banner surfaces it. The
 * agent then polls get_status for the human's verdict. Mounted always;
 * requests only arrive while the sidecar is enabled.
 */

type Outcome = 'accepted' | 'discarded' | null

/**
 * Gesture-queue: never present a proposal while the human is mid-drag — park
 * the request (surfaced as "N queued" by the banner) and continue against
 * whatever the sequence is AFTER the gesture, so their edit can't void it.
 */
async function waitForGestureEnd(): Promise<void> {
  if (!useTimelineStore.getState().isInteracting) return
  useTimelineStore.getState().bumpAgentQueued(1)
  try {
    await new Promise<void>((resolve) => {
      const unsubscribe = useTimelineStore.subscribe((state) => {
        if (!state.isInteracting) {
          unsubscribe()
          resolve()
        }
      })
    })
  } finally {
    useTimelineStore.getState().bumpAgentQueued(-1)
  }
}

/** Present an executed scratch batch as the pending 'Agent' proposal. */
function presentProposal(
  base: Sequence,
  scratch: Sequence,
  executed: { name: string; input: unknown; summary: string }[],
  results: string[],
  lastOutcome: { current: Outcome }
): unknown {
  if (scratch === base || executed.length === 0) {
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
      await waitForGestureEnd()
      // re-read after any wait: the gesture may have edited the sequence
      const current = useTimelineStore.getState()
      const base = current.sequence
      if (base === null) return { error: 'no project is open in the editor' }
      if (current.pendingProposal !== null) {
        return { error: 'a proposal is already awaiting human review — poll get_status' }
      }
      for (const op of ops) {
        if (typeof op.name !== 'string') return { error: 'every op needs a string name' }
      }
      const batch = executeEditBatch(base, ops as { name: string; input: unknown }[], snapshot.assets)
      if (!batch.ok) return { error: batch.error }
      return presentProposal(base, batch.next, batch.executed, batch.results, lastOutcome)
    }
    case 'cut_words': {
      const record = input as { quote?: unknown; occurrence?: unknown } | null
      const quote = typeof record?.quote === 'string' ? record.quote.trim() : ''
      if (quote.length === 0) return { error: 'cut_words needs { quote: "the words to cut" }' }
      const occurrence =
        typeof record?.occurrence === 'number' && Number.isInteger(record.occurrence)
          ? record.occurrence
          : null
      await waitForGestureEnd()
      const current = useTimelineStore.getState()
      const base = current.sequence
      if (base === null) return { error: 'no project is open in the editor' }
      if (current.pendingProposal !== null) {
        return { error: 'a proposal is already awaiting human review — poll get_status' }
      }
      const transcripts = await ensureTranscripts(base, snapshot)
      const words = projectTranscript(base, transcripts)
      if (words.length === 0) {
        return { error: 'no transcript available yet — transcription runs after import' }
      }
      const matches = findQuote(words, quote)
      if (matches.length === 0) {
        return { error: `"${quote}" does not occur in the transcript — read_timeline to see it` }
      }
      if (matches.length > 1 && occurrence === null) {
        return {
          error: `"${quote}" occurs ${matches.length} times — pass occurrence (0-based) to pick one`,
          occurrences: matches.map((match, index) => ({
            occurrence: index,
            at_sec: Math.round((match.fromFlicks / FLICKS_PER_SECOND) * 10) / 10
          }))
        }
      }
      const match = matches[Math.min(occurrence ?? 0, matches.length - 1)]
      const deleteInput = {
        from_sec: match.fromFlicks / FLICKS_PER_SECOND,
        to_sec: match.toFlicks / FLICKS_PER_SECOND
      }
      const outcome = executeEditTool(base, 'ripple_delete_range', deleteInput)
      const executed =
        outcome.summary === null
          ? []
          : [
              {
                name: 'ripple_delete_range',
                input: deleteInput,
                summary: `Cut "${quote}" — ${outcome.summary}`
              }
            ]
      return presentProposal(base, outcome.next, executed, [outcome.resultText], lastOutcome)
    }
    case 'duck_music': {
      const record = input as { amount_db?: unknown } | null
      const amount =
        typeof record?.amount_db === 'number' && Number.isFinite(record.amount_db)
          ? Math.min(0, Math.max(-60, record.amount_db))
          : DUCK_AMOUNT_DB
      await waitForGestureEnd()
      const current = useTimelineStore.getState()
      const base = current.sequence
      if (base === null) return { error: 'no project is open in the editor' }
      if (current.pendingProposal !== null) {
        return { error: 'a proposal is already awaiting human review — poll get_status' }
      }
      const envelopes = await ensureEnvelopes(base, snapshot)
      const plans = planDucking(base, envelopes)
      if (plans.length === 0) {
        return {
          error:
            'no music-role clip overlaps dialogue speech — tag the bed with set_role, or audio analysis may still be running'
        }
      }
      let scratch = base
      const executed: { name: string; input: unknown; summary: string }[] = []
      const results: string[] = []
      for (const plan of plans) {
        const duckInput = {
          clip_id: plan.clipId,
          amount_db: amount,
          ranges: plan.ranges.map((range) => ({
            from_sec: range.fromClipFlicks / FLICKS_PER_SECOND,
            to_sec: range.toClipFlicks / FLICKS_PER_SECOND
          }))
        }
        const outcome = executeEditTool(scratch, 'duck_clip', duckInput)
        scratch = outcome.next
        results.push(`${plan.clipId}: ${outcome.resultText}`)
        if (outcome.summary !== null) {
          executed.push({ name: 'duck_clip', input: duckInput, summary: outcome.summary })
        }
      }
      return presentProposal(base, scratch, executed, results, lastOutcome)
    }
    case 'normalize_loudness': {
      const record = input as { target_lufs?: unknown; clip_ids?: unknown } | null
      const target =
        typeof record?.target_lufs === 'number' && Number.isFinite(record.target_lufs)
          ? record.target_lufs
          : DEFAULT_TARGET_LUFS
      const requested = Array.isArray(record?.clip_ids)
        ? (record.clip_ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : null
      await waitForGestureEnd()
      const current = useTimelineStore.getState()
      const base = current.sequence
      if (base === null) return { error: 'no project is open in the editor' }
      if (current.pendingProposal !== null) {
        return { error: 'a proposal is already awaiting human review — poll get_status' }
      }
      // targets: the requested ids, else every audible dialogue-role clip
      const wanted = (id: string, role: ReturnType<typeof effectiveRole>): boolean =>
        requested !== null ? requested.includes(id) : role === 'dialogue'
      const targets: { clipId: string; assetId: string }[] = []
      for (const item of base.spine) {
        if (item.kind !== 'clip' || item.audioDisabled === true) continue
        if (wanted(item.id, effectiveRole(item))) {
          targets.push({ clipId: item.id, assetId: item.assetId })
        }
      }
      for (const cc of base.connected) {
        if (cc.titleData !== undefined || cc.audioDisabled === true) continue
        if (wanted(cc.id, effectiveRole(cc))) {
          targets.push({ clipId: cc.id, assetId: cc.assetId })
        }
      }
      if (targets.length === 0) return { error: 'no matching clips with audio' }
      const lufsByAsset = new Map<string, number | null>()
      await Promise.all(
        [...new Set(targets.map((entry) => entry.assetId))].map(async (assetId) => {
          try {
            lufsByAsset.set(assetId, await window.api.audioLoudness(assetId))
          } catch {
            lufsByAsset.set(assetId, null)
          }
        })
      )
      let scratch = base
      const executed: { name: string; input: unknown; summary: string }[] = []
      const results: string[] = []
      for (const entry of targets) {
        const lufs = lufsByAsset.get(entry.assetId) ?? null
        if (lufs === null) {
          results.push(`${entry.clipId}: loudness unmeasurable, skipped`)
          continue
        }
        const volumeInput = {
          clip_id: entry.clipId,
          volume_db: Math.round(normalizeGainDb(lufs, target) * 10) / 10
        }
        const outcome = executeEditTool(scratch, 'set_volume', volumeInput)
        scratch = outcome.next
        results.push(`${entry.clipId}: measured ${lufs.toFixed(1)} LUFS — ${outcome.resultText}`)
        if (outcome.summary !== null) {
          executed.push({
            name: 'set_volume',
            input: volumeInput,
            summary: `${outcome.summary} (measured ${lufs.toFixed(1)} LUFS, target ${target})`
          })
        }
      }
      return presentProposal(base, scratch, executed, results, lastOutcome)
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
