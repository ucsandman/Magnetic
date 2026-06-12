import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from 'react'

export interface ContextMenuItem {
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect(): void
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

interface ContextMenuProps {
  menu: ContextMenuState | null
  onClose(): void
}

export function ContextMenu({ menu, onClose }: ContextMenuProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Clamp into the viewport: menus opened near the bottom edge (the timeline
  // is the bottom panel) would otherwise overflow and hide their last items.
  useLayoutEffect(() => {
    if (menu === null) {
      setPosition(null)
      return
    }
    const rect = ref.current?.getBoundingClientRect()
    const width = rect?.width ?? 0
    const height = rect?.height ?? 0
    setPosition({
      left: Math.max(0, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(0, Math.min(menu.y, window.innerHeight - height - 4))
    })
  }, [menu])

  useEffect(() => {
    if (menu === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node) ?? false) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [menu, onClose])

  if (menu === null) return null

  return (
    <div
      ref={ref}
      className="context-menu"
      data-testid="context-menu"
      style={position ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.danger ? 'danger' : ''}
          data-testid={`context-${item.id}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            item.onSelect()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
