import { type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

interface SplitterProps {
  /** col = drag horizontally (panel widths), row = drag vertically. */
  direction: 'col' | 'row'
  testId: string
  className: string
  title: string
  onDragStart(): void
  /** Cumulative pointer delta (px) since drag start, along the axis. */
  onDrag(deltaPx: number): void
  onDragEnd(): void
  /** Double-click resets this dimension to its default. */
  onReset(): void
}

/** Invisible drag handle overlaying a panel gap in the app-shell grid. */
export function Splitter({
  direction,
  testId,
  className,
  title,
  onDragStart,
  onDrag,
  onDragEnd,
  onReset
}: SplitterProps): ReactNode {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startY = event.clientY
    onDragStart()
    const move = (ev: PointerEvent): void => {
      onDrag(direction === 'col' ? ev.clientX - startX : ev.clientY - startY)
    }
    const up = (): void => {
      element.removeEventListener('pointermove', move)
      onDragEnd()
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up, { once: true })
  }

  return (
    <div
      className={`splitter splitter-${direction} ${className}`}
      data-testid={testId}
      title={title}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  )
}
