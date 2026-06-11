import type { ReactNode } from 'react'
import { Panel } from './Panel'

export function InspectorPanel(): ReactNode {
  return (
    <Panel title="Inspector" testId="panel-inspector" className="panel-inspector">
      <span>Nothing selected</span>
    </Panel>
  )
}
