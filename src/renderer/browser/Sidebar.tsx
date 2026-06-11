import type { ReactNode } from 'react'
import type { LibrarySnapshot } from '../../shared/types'

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
    </nav>
  )
}
