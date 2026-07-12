import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import type { Transcript } from '../../shared/types'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { useAssetEnvelopes } from '../silence/use-envelopes'
import { ensureTranscripts } from '../transcript/cache'
import { ABReview } from './ABReview'
import { advisorErrorMessage, streamCopilotTurn, type AdvisorTurn } from './agent-runtime'
import { buildCopilotContext } from './context'
import { dependencyGroups } from './dependency'
import { scoreFlow } from './flow-score'

/**
 * Read-only copilot advisor (phase 3): a chat over the open sequence. The
 * runtime declares zero tools, so nothing here can touch the timeline — the
 * copilot sees (context.ts) and says, the human does. Chat state lives in a
 * module store so switching browser tabs doesn't lose the conversation.
 */

interface CopilotChat {
  turns: AdvisorTurn[]
  /** Streaming assistant text, null when idle. */
  streaming: string | null
  error: string | null
  setTurns(turns: AdvisorTurn[]): void
  setStreaming(text: string | null): void
  setError(error: string | null): void
}

const useCopilotChat = create<CopilotChat>((set) => ({
  turns: [],
  streaming: null,
  error: null,
  setTurns: (turns) => set({ turns }),
  setStreaming: (streaming) => set({ streaming }),
  setError: (error) => set({ error })
}))

export function CopilotPanel({ onClose }: { onClose(): void }): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const pendingProposal = useTimelineStore((state) => state.pendingProposal)
  const flowReport = useTimelineStore((state) => state.flowReport)
  const { turns, streaming, error } = useCopilotChat()
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [keyLoaded, setKeyLoaded] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [question, setQuestion] = useState('')
  const [transcripts, setTranscripts] = useState<Map<string, Transcript>>(new Map())
  const { envelopes } = useAssetEnvelopes(sequence, snapshot)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.api.getSettings().then((settings) => {
      setApiKey(settings.anthropicApiKey)
      setKeyLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (sequence === null || snapshot === null) return
    let disposed = false
    void ensureTranscripts(sequence, snapshot).then((map) => {
      if (!disposed) setTranscripts(map)
    })
    return () => {
      disposed = true
    }
  }, [sequence, snapshot])

  // follow the newest message / streaming delta
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [turns, streaming])

  useEffect(() => () => abortRef.current?.abort(), [])

  // This panel's proposal: an op batch (ranges === null) still computed
  // against the current sequence. Human edits underneath simply void it.
  const copilotProposal =
    pendingProposal !== null &&
    pendingProposal.ranges === null &&
    sequence === pendingProposal.baseSequence
      ? pendingProposal
      : null
  useEffect(() => {
    if (pendingProposal !== null && pendingProposal.ranges === null && copilotProposal === null) {
      useTimelineStore.getState().discardProposal()
    }
  }, [pendingProposal, copilotProposal])

  // Partial accept: ops fall into forced decision groups (id-introduction +
  // conservative position-addressing rules — see dependency.ts). One checkbox
  // per group; all checked by default, reset whenever the proposal changes.
  const groups = useMemo(
    () =>
      copilotProposal !== null && copilotProposal.ops !== null
        ? dependencyGroups(copilotProposal.baseSequence, copilotProposal.ops)
        : [],
    [copilotProposal]
  )
  // checkbox state resets whenever the proposal object changes — adjusted
  // during render (React's derived-state pattern), not in an effect
  const [checkboxes, setCheckboxes] = useState<{
    proposal: typeof copilotProposal
    unchecked: Set<number>
  }>({ proposal: null, unchecked: new Set() })
  if (checkboxes.proposal !== copilotProposal) {
    setCheckboxes({ proposal: copilotProposal, unchecked: new Set() })
  }
  const uncheckedGroups = checkboxes.unchecked
  const setUncheckedGroups = (update: (current: Set<number>) => Set<number>): void =>
    setCheckboxes((current) => ({ ...current, unchecked: update(current.unchecked) }))
  const keptIndices = useMemo(
    () => groups.filter((_, groupIndex) => !uncheckedGroups.has(groupIndex)).flat(),
    [groups, uncheckedGroups]
  )

  const publishFlowReport = (): void => {
    const next = useTimelineStore.getState().sequence
    if (next === null) return
    const report = scoreFlow(next, envelopes)
    useTimelineStore.getState().setFlowReport({ forSequence: next, ...report })
  }

  const acceptSelected = (): void => {
    const store = useTimelineStore.getState()
    if (uncheckedGroups.size === 0) {
      store.acceptProposal()
      publishFlowReport()
      return
    }
    if (!store.acceptCopilotOps(keptIndices)) {
      useCopilotChat
        .getState()
        .setError(
          'Partial accept failed — those changes could not replay on their own. Try a different selection or accept everything.'
        )
      return
    }
    publishFlowReport()
  }

  const saveKey = (): void => {
    const trimmed = keyDraft.trim()
    if (trimmed === '') return
    void window.api.setSettings({ anthropicApiKey: trimmed }).then(() => {
      setApiKey(trimmed)
      setKeyDraft('')
      setEditingKey(false)
    })
  }

  const send = (): void => {
    const chat = useCopilotChat.getState()
    const text = question.trim()
    if (text === '' || chat.streaming !== null || sequence === null || apiKey === null) return
    const store = useTimelineStore.getState()
    // a new instruction supersedes any unreviewed batch from the last turn
    if (store.pendingProposal !== null && store.pendingProposal.ranges === null) {
      store.discardProposal()
    }
    const assetNames = new Map(
      Object.values(snapshot?.assets ?? {}).map((asset) => [asset.id, asset.fileName])
    )
    const contextOf = (scratch: typeof sequence): string =>
      buildCopilotContext(scratch, transcripts, envelopes, assetNames)
    const nextTurns: AdvisorTurn[] = [...chat.turns, { role: 'user', text }]
    chat.setTurns(nextTurns)
    chat.setError(null)
    chat.setStreaming('')
    setQuestion('')
    const controller = new AbortController()
    abortRef.current = controller
    const flowOf = (scratch: typeof sequence): string => {
      const report = scoreFlow(scratch, envelopes)
      return `Flow score ${report.score}/100 — ${report.flags.length} flag(s):\n${report.flags.map((flag) => `- [${(flag.flicks / 705_600_000).toFixed(1)}s] ${flag.kind}: ${flag.message}`).join('\n') || '(none)'}`
    }
    void streamCopilotTurn({
      apiKey,
      context: contextOf(sequence),
      turns: nextTurns,
      base: sequence,
      contextOf,
      flowOf,
      signal: controller.signal,
      onDelta: (delta) => {
        const current = useCopilotChat.getState()
        current.setStreaming((current.streaming ?? '') + delta)
      },
      onToolTime: (flicks) => {
        useTimelineStore.getState().setAgentPlayhead(flicks)
      }
    })
      .then((result) => {
        const current = useCopilotChat.getState()
        current.setTurns([...current.turns, { role: 'assistant', text: result.reply }])
        if (result.proposed !== sequence && result.ops.length > 0) {
          useTimelineStore.getState().proposeCopilotChanges(result.proposed, result.ops)
        }
      })
      .catch((failure: unknown) => {
        useCopilotChat.getState().setError(advisorErrorMessage(failure))
      })
      .finally(() => {
        useCopilotChat.getState().setStreaming(null)
        useTimelineStore.getState().setAgentPlayhead(null)
        abortRef.current = null
      })
  }

  const needsKey = keyLoaded && (apiKey === null || editingKey)

  return (
    <div
      className="copilot-panel"
      data-testid="copilot-panel"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="copilot-disclaimer" data-testid="copilot-disclaimer">
        The copilot sees your timeline, dead air, and transcript. Its edits are proposals: they
        preview as a ghost diff and apply only when you Accept — never directly.
      </div>
      {needsKey && (
        <div className="copilot-setup" data-testid="copilot-setup">
          <p>
            The copilot talks to the Anthropic API with your own key. It is stored on this machine
            (app settings), sent only to api.anthropic.com, and never logged.
          </p>
          <div className="copilot-input-row">
            <input
              type="password"
              data-testid="copilot-key-input"
              placeholder="sk-ant-…"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey()
              }}
            />
            <button
              type="button"
              className="primary"
              data-testid="copilot-key-save"
              disabled={keyDraft.trim() === ''}
              onClick={saveKey}
            >
              Save key
            </button>
            {editingKey && (
              <button type="button" onClick={() => setEditingKey(false)}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {!needsKey && keyLoaded && (
        <>
          <div className="copilot-log" data-testid="copilot-log" ref={logRef}>
            {turns.length === 0 && streaming === null && (
              <div className="browser-empty">
                Ask about the open cut — “what happens in the first 30 seconds?”, “where does it
                drag?”, “which takes mention the launch date?”
              </div>
            )}
            {turns.map((turn, index) => (
              <div
                key={index}
                className={`copilot-msg copilot-msg-${turn.role}`}
                data-testid={`copilot-msg-${index}`}
              >
                {turn.text}
              </div>
            ))}
            {streaming !== null && (
              <div className="copilot-msg copilot-msg-assistant" data-testid="copilot-streaming">
                {streaming === '' ? '…' : streaming}
              </div>
            )}
            {error !== null && (
              <div className="copilot-error" data-testid="copilot-error">
                {error}
              </div>
            )}
          </div>
          {copilotProposal !== null && (
            <div className="copilot-proposal" data-testid="copilot-proposal">
              <div className="copilot-proposal-title">
                Proposed {copilotProposal.changes.length} change
                {copilotProposal.changes.length === 1 ? '' : 's'} — previewed on the timeline,
                nothing applied yet. Accept commits as one undo step.
              </div>
              <ul className="copilot-proposal-list">
                {groups.map((group, groupIndex) => (
                  <li key={groupIndex} className="copilot-proposal-group">
                    <label>
                      <input
                        type="checkbox"
                        data-testid={`copilot-group-${groupIndex}`}
                        checked={!uncheckedGroups.has(groupIndex)}
                        onChange={() =>
                          setUncheckedGroups((current) => {
                            const next = new Set(current)
                            if (next.has(groupIndex)) next.delete(groupIndex)
                            else next.add(groupIndex)
                            return next
                          })
                        }
                      />
                      <span>
                        {group.map((opIndex, position) => (
                          <span key={opIndex} data-testid={`copilot-change-${opIndex}`}>
                            {position > 0 ? ' + ' : ''}
                            {copilotProposal.ops?.[opIndex]?.summary ?? ''}
                          </span>
                        ))}
                        {group.length > 1 && (
                          <em className="copilot-group-linked"> (linked — one decision)</em>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {snapshot !== null && (
                <ABReview
                  base={copilotProposal.baseSequence}
                  proposed={copilotProposal.proposedSequence}
                  snapshot={snapshot}
                />
              )}
              <div className="copilot-proposal-actions">
                <button
                  type="button"
                  className="primary"
                  data-testid="copilot-accept"
                  disabled={keptIndices.length === 0}
                  onClick={acceptSelected}
                >
                  Accept{uncheckedGroups.size > 0 ? ` ${keptIndices.length} selected` : ''}
                </button>
                <button
                  type="button"
                  data-testid="copilot-discard"
                  onClick={() => useTimelineStore.getState().discardProposal()}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
          {flowReport !== null && flowReport.forSequence === sequence && (
            <div
              className={`flow-chip flow-${flowReport.score >= 85 ? 'good' : flowReport.score >= 65 ? 'ok' : 'poor'}`}
              data-testid="flow-chip"
              title="Heuristic self-check of the accepted cut — flags are marked on the timeline ruler; click one to jump there"
            >
              Flow score {flowReport.score} · {flowReport.flags.length} flag
              {flowReport.flags.length === 1 ? '' : 's'} on the ruler
            </div>
          )}
          <div className="copilot-input-row">
            <input
              type="text"
              data-testid="copilot-question"
              placeholder="Ask about this cut…"
              value={question}
              disabled={streaming !== null}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') send()
              }}
            />
            {streaming === null ? (
              <button
                type="button"
                className="primary"
                data-testid="copilot-send"
                disabled={question.trim() === '' || sequence === null}
                onClick={send}
              >
                Send
              </button>
            ) : (
              <button
                type="button"
                data-testid="copilot-stop"
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            )}
            <button
              type="button"
              data-testid="copilot-key-edit"
              title="Change the stored API key"
              onClick={() => setEditingKey(true)}
            >
              Key…
            </button>
          </div>
        </>
      )}
    </div>
  )
}
