import { useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import type { Transcript } from '../../shared/types'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { useAssetEnvelopes } from '../silence/use-envelopes'
import { ensureTranscripts } from '../transcript/cache'
import { advisorErrorMessage, streamAdvisorReply, type AdvisorTurn } from './agent-runtime'
import { buildCopilotContext } from './context'

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
    const assetNames = new Map(
      Object.values(snapshot?.assets ?? {}).map((asset) => [asset.id, asset.fileName])
    )
    const context = buildCopilotContext(sequence, transcripts, envelopes, assetNames)
    const nextTurns: AdvisorTurn[] = [...chat.turns, { role: 'user', text }]
    chat.setTurns(nextTurns)
    chat.setError(null)
    chat.setStreaming('')
    setQuestion('')
    const controller = new AbortController()
    abortRef.current = controller
    void streamAdvisorReply({
      apiKey,
      context,
      turns: nextTurns,
      signal: controller.signal,
      onDelta: (delta) => {
        const current = useCopilotChat.getState()
        current.setStreaming((current.streaming ?? '') + delta)
      }
    })
      .then((reply) => {
        const current = useCopilotChat.getState()
        current.setTurns([...current.turns, { role: 'assistant', text: reply }])
      })
      .catch((failure: unknown) => {
        useCopilotChat.getState().setError(advisorErrorMessage(failure))
      })
      .finally(() => {
        useCopilotChat.getState().setStreaming(null)
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
        Read-only advisor — it sees your timeline, dead air, and transcript; it cannot edit (yet).
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
