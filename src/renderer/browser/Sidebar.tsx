import { useEffect, useState, type ReactNode } from 'react'
import type { LibrarySnapshot } from '../../shared/types'
import type { TitleData } from '../../shared/timeline/model'
import { useTimelineStore } from '../state/timeline-store'
import { TITLE_PRESETS } from '../titles/render'

interface SidebarProps {
  snapshot: LibrarySnapshot
  selectedEventId: string | null
  onSelectEvent(eventId: string): void
}

export function Sidebar({ snapshot, selectedEventId, onSelectEvent }: SidebarProps): ReactNode {
  const [autoTranscribe, setAutoTranscribe] = useState(true)
  const [agentAccess, setAgentAccess] = useState(false)
  const [agentStatus, setAgentStatus] = useState<{ port: number | null; token: string | null }>({
    port: null,
    token: null
  })
  const [tokenVisible, setTokenVisible] = useState(false)
  const refreshAgentStatus = (): void => {
    void window.api
      .agentStatus()
      .then((status) => setAgentStatus({ port: status.port, token: status.token }))
  }
  useEffect(() => {
    void window.api.getSettings().then((settings) => {
      setAutoTranscribe(settings.autoTranscribe)
      setAgentAccess(settings.agentAccess)
    })
    refreshAgentStatus()
  }, [])
  return (
    <nav className="browser-sidebar" data-testid="browser-sidebar">
      <div className="sidebar-library">{snapshot.name}</div>
      <ul>
        {snapshot.events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className={event.id === selectedEventId ? 'active' : ''}
              onClick={() => onSelectEvent(event.id)}
            >
              {event.name}
              <span className="sidebar-count">{event.assetIds.length}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-library sidebar-titles-header">Titles</div>
      <ul>
        {(Object.keys(TITLE_PRESETS) as TitleData['preset'][]).map((preset) => (
          <li key={preset}>
            <button
              type="button"
              data-testid={`title-preset-${preset}`}
              title="Click to connect at the playhead"
              onClick={(event) => {
                if (event.detail > 1) return
                useTimelineStore.getState().connectTitleAtPlayhead(preset)
              }}
            >
              {TITLE_PRESETS[preset].label}
            </button>
          </li>
        ))}
      </ul>
      <label
        className="sidebar-setting"
        title="Transcribe assets with audio automatically on import (clips over 30 minutes are skipped — use each asset's Transcribe action instead)"
      >
        <input
          type="checkbox"
          data-testid="setting-auto-transcribe"
          checked={autoTranscribe}
          onChange={(event) => {
            setAutoTranscribe(event.target.checked)
            void window.api.setSettings({ autoTranscribe: event.target.checked })
          }}
        />
        <span>
          Auto-transcribe
          <span className="sidebar-setting-note">clips under 30 min</span>
        </span>
      </label>
      <label
        className="sidebar-setting"
        title="Let external agents (Claude Code, any MCP client) see this project and PROPOSE edits — every change previews as a ghost diff and applies only when you Accept. Off severs all connections instantly."
      >
        <input
          type="checkbox"
          data-testid="setting-agent-access"
          checked={agentAccess}
          onChange={(event) => {
            setAgentAccess(event.target.checked)
            void window.api
              .setSettings({ agentAccess: event.target.checked })
              .then(refreshAgentStatus)
          }}
        />
        <span>
          Agent Access
          <span className="sidebar-setting-note">
            {agentAccess && agentStatus.port !== null
              ? `MCP on 127.0.0.1:${agentStatus.port}`
              : 'external agents propose, you accept'}
          </span>
        </span>
      </label>
      {agentAccess && agentStatus.token !== null && (
        <div className="sidebar-agent-token" data-testid="agent-token-row">
          <button
            type="button"
            data-testid="agent-token-reveal"
            title={tokenVisible ? 'Hide the token' : 'Reveal the connection token'}
            onClick={() => setTokenVisible((visible) => !visible)}
          >
            {tokenVisible ? (agentStatus.token ?? '') : 'Token ••••'}
          </button>
          <button
            type="button"
            data-testid="agent-token-rotate"
            title="Rotate the token — connected agents are cut off until reconfigured"
            onClick={() => {
              void window.api
                .setSettings({ agentToken: crypto.randomUUID() })
                .then(refreshAgentStatus)
            }}
          >
            Rotate
          </button>
        </div>
      )}
    </nav>
  )
}
