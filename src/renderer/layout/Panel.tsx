import type { ReactNode } from 'react'

interface PanelProps {
  title: string
  testId: string
  className: string
  toolbar?: ReactNode
  children: ReactNode
}

/** Shared panel chrome: header strip, optional toolbar row, body. */
export function Panel({ title, testId, className, toolbar, children }: PanelProps): ReactNode {
  return (
    <section className={`panel ${className}`} data-testid={testId}>
      <header className="panel-header">{title}</header>
      {toolbar !== undefined && <div className="panel-toolbar">{toolbar}</div>}
      <div className="panel-body">{children}</div>
    </section>
  )
}
