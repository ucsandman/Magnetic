import { useEffect, useState, type ReactNode } from 'react'
import { BrowserPanel } from './browser/BrowserPanel'
import { ViewerPanel } from './viewer/ViewerPanel'
import { TimelinePanel } from './layout/TimelinePanel'
import { InspectorPanel } from './layout/InspectorPanel'
import { DebugPanel } from './layout/DebugPanel'
import { LibraryProvider } from './state/LibraryContext'
import { registerShortcut } from './shortcuts'

export default function App(): ReactNode {
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [debugVisible, setDebugVisible] = useState(false)

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
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

  // Decoder spike harness — test builds only (window.api.__test is gated on MAGNETIC_TEST=1).
  useEffect(() => {
    if (window.api.__test !== undefined) {
      void import('./playback/decoder/spike').then((module) => module.installDecoderSpike())
    }
  }, [])

  return (
    <LibraryProvider>
      <div className={`app-shell ${inspectorVisible ? '' : 'inspector-hidden'}`}>
        <div className="topbar">
          <span className="app-title">Magnetic</span>
          <span className="spacer" />
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
        {debugVisible && <DebugPanel />}
      </div>
    </LibraryProvider>
  )
}
