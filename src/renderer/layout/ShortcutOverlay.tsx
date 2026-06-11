import type { ReactNode } from 'react'
import { listShortcuts } from '../shortcuts'

/**
 * The `?` overlay enumerates the LIVE shortcut registry — every binding that
 * is currently registered, not a hardcoded copy.
 */
export function ShortcutOverlay({ onClose }: { onClose(): void }): ReactNode {
  const shortcuts = listShortcuts().sort((a, b) => a.combo.localeCompare(b.combo))
  return (
    <div className="export-overlay" data-testid="shortcut-overlay" onClick={onClose}>
      <div className="export-dialog shortcut-overlay-body" onClick={(e) => e.stopPropagation()}>
        <div className="export-title">Keyboard Shortcuts ({shortcuts.length})</div>
        <div className="shortcut-list">
          {shortcuts.map((shortcut) => (
            <div key={shortcut.id} className="shortcut-row" data-testid="shortcut-row">
              <kbd>{shortcut.combo}</kbd>
              <span>{shortcut.description}</span>
            </div>
          ))}
        </div>
        <div className="export-actions">
          <button type="button" data-testid="shortcut-overlay-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
