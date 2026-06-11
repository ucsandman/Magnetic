import type { ReactNode } from 'react'
import { Panel } from './Panel'

export function TimelinePanel(): ReactNode {
  return (
    <Panel
      title="Timeline"
      testId="panel-timeline"
      className="panel-timeline"
      toolbar={<span>No project open</span>}
    >
      <span>Create a project to start editing</span>
    </Panel>
  )
}
