import type { ReactNode } from 'react'
import { Panel } from './Panel'
import { useLibrary } from '../state/LibraryContext'

export function ViewerPanel(): ReactNode {
  const { snapshot, selectedIds } = useLibrary()
  const selected =
    snapshot !== null && selectedIds.length > 0 ? (snapshot.assets[selectedIds[0]] ?? null) : null

  return (
    <Panel
      title="Viewer"
      testId="panel-viewer"
      className="panel-viewer"
      toolbar={<span>00:00:00:00</span>}
    >
      <div className="viewer-screen">
        <span data-testid="viewer-selected">
          {selected === null ? 'No clip selected' : selected.fileName}
        </span>
      </div>
    </Panel>
  )
}
