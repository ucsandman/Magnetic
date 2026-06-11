import type { ReactNode } from 'react'
import { Panel } from './Panel'

export function BrowserPanel(): ReactNode {
  return (
    <Panel
      title="Browser"
      testId="panel-browser"
      className="panel-browser"
      toolbar={<span>Library · All Clips</span>}
    >
      <span>No media imported yet</span>
    </Panel>
  )
}
