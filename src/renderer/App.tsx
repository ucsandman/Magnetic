import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { BrowserPanel } from './browser/BrowserPanel'
import { ViewerPanel } from './viewer/ViewerPanel'
import { TimelinePanel } from './layout/TimelinePanel'
import { InspectorPanel } from './layout/InspectorPanel'
import { DebugPanel } from './layout/DebugPanel'
import { ExportDialog } from './export/ExportDialog'
import { ShortcutOverlay } from './layout/ShortcutOverlay'
import {
  clampLayoutSize,
  LAYOUT_DEFAULTS,
  loadLayout,
  saveLayout,
  type LayoutSizes
} from './layout/layout-state'
import { Splitter } from './layout/Splitter'
import { LibraryProvider } from './state/LibraryContext'
import { registerShortcut } from './shortcuts'

export default function App(): ReactNode {
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [debugVisible, setDebugVisible] = useState(false)
  const [exportVisible, setExportVisible] = useState(false)
  const [shortcutsVisible, setShortcutsVisible] = useState(false)
  const [layout, setLayout] = useState<LayoutSizes>(() => loadLayout())
  const dragBaseRef = useRef<LayoutSizes>(layout)

  const beginLayoutDrag = useCallback((): void => {
    dragBaseRef.current = layout
  }, [layout])
  const resizePanel = useCallback((key: keyof LayoutSizes, delta: number): void => {
    setLayout((current) => ({
      ...current,
      [key]: clampLayoutSize(key, dragBaseRef.current[key] + delta)
    }))
  }, [])
  const endLayoutDrag = useCallback((): void => {
    setLayout((current) => {
      saveLayout(current)
      return current
    })
  }, [])
  const resetPanel = useCallback((key: keyof LayoutSizes): void => {
    setLayout((current) => {
      const next = { ...current, [key]: LAYOUT_DEFAULTS[key] }
      saveLayout(next)
      return next
    })
  }, [])
  const resetLayout = useCallback((): void => {
    setLayout({ ...LAYOUT_DEFAULTS })
    saveLayout({ ...LAYOUT_DEFAULTS })
  }, [])
  const isDefaultLayout =
    layout.browserW === LAYOUT_DEFAULTS.browserW &&
    layout.inspectorW === LAYOUT_DEFAULTS.inspectorW &&
    layout.timelineH === LAYOUT_DEFAULTS.timelineH

  useEffect(() => {
    const unsubscribers = [
      registerShortcut('app-toggle-inspector', {
        combo: 'ctrl+4',
        description: 'Show or hide the Inspector',
        handler: () => setInspectorVisible((visible) => !visible)
      }),
      registerShortcut('app-toggle-debug', {
        combo: 'ctrl+shift+d',
        description: 'Show or hide binary diagnostics',
        handler: () => setDebugVisible((visible) => !visible)
      }),
      registerShortcut('app-export', {
        combo: 'ctrl+e',
        description: 'Export the sequence as a movie',
        handler: () => setExportVisible(true)
      }),
      registerShortcut('app-shortcuts', {
        combo: 'shift+?',
        description: 'Show this keyboard shortcut list',
        handler: () => setShortcutsVisible((visible) => !visible)
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

  // Test harnesses — test builds only (window.api.__test is gated on MAGNETIC_TEST=1).
  useEffect(() => {
    if (window.api.__test !== undefined) {
      void import('./playback/decoder/spike').then((module) => module.installDecoderSpike())
      void import('./state/timeline-store').then((module) => module.installTimelineTestHooks())
    }
  }, [])

  return (
    <LibraryProvider>
      <div
        className={`app-shell ${inspectorVisible ? '' : 'inspector-hidden'}`}
        style={
          {
            '--browser-w': `${layout.browserW}px`,
            '--inspector-w': `${layout.inspectorW}px`,
            '--timeline-h': `${layout.timelineH}px`
          } as CSSProperties
        }
      >
        <div className="topbar">
          <span className="app-title">Magnetic</span>
          <span className="spacer" />
          <button
            type="button"
            data-testid="reset-layout"
            title="Restore the default panel sizes"
            disabled={isDefaultLayout}
            onClick={resetLayout}
          >
            Reset Layout
          </button>
          <button
            type="button"
            className={inspectorVisible ? 'active' : ''}
            data-testid="toggle-inspector"
            title="Show or hide the Inspector (Ctrl+4)"
            onClick={() => setInspectorVisible((visible) => !visible)}
          >
            Inspector
          </button>
        </div>
        <BrowserPanel />
        <ViewerPanel />
        <InspectorPanel />
        <TimelinePanel />
        <Splitter
          direction="col"
          testId="splitter-browser"
          className="splitter-browser"
          title="Drag to resize the Browser — double-click to reset"
          onDragStart={beginLayoutDrag}
          onDrag={(delta) => resizePanel('browserW', delta)}
          onDragEnd={endLayoutDrag}
          onReset={() => resetPanel('browserW')}
        />
        {inspectorVisible && (
          <Splitter
            direction="col"
            testId="splitter-inspector"
            className="splitter-inspector"
            title="Drag to resize the Inspector — double-click to reset"
            onDragStart={beginLayoutDrag}
            onDrag={(delta) => resizePanel('inspectorW', -delta)}
            onDragEnd={endLayoutDrag}
            onReset={() => resetPanel('inspectorW')}
          />
        )}
        <Splitter
          direction="row"
          testId="splitter-timeline"
          className="splitter-timeline"
          title="Drag to resize the Timeline — double-click to reset"
          onDragStart={beginLayoutDrag}
          onDrag={(delta) => resizePanel('timelineH', -delta)}
          onDragEnd={endLayoutDrag}
          onReset={() => resetPanel('timelineH')}
        />
        {debugVisible && <DebugPanel />}
        {exportVisible && <ExportDialog onClose={() => setExportVisible(false)} />}
        {shortcutsVisible && <ShortcutOverlay onClose={() => setShortcutsVisible(false)} />}
      </div>
    </LibraryProvider>
  )
}
