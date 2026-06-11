import type { ReactNode } from 'react'
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
              title="Double-click to connect at the playhead"
              onDoubleClick={() => useTimelineStore.getState().connectTitleAtPlayhead(preset)}
            >
              {TITLE_PRESETS[preset].label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
