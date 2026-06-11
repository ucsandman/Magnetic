import type { ReactNode } from 'react'
import { Panel } from './Panel'

export function ViewerPanel(): ReactNode {
  return (
    <Panel
      title="Viewer"
      testId="panel-viewer"
      className="panel-viewer"
      toolbar={<span>00:00:00:00</span>}
    >
      <div className="viewer-screen">
        <span>No clip selected</span>
      </div>
    </Panel>
  )
}
