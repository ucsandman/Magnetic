import { useEffect, useState, type ReactNode } from 'react'
import { BrowserPanel } from './browser/BrowserPanel'
import { ViewerPanel } from './layout/ViewerPanel'
import { TimelinePanel } from './layout/TimelinePanel'
import { InspectorPanel } from './layout/InspectorPanel'
import { DebugPanel } from './layout/DebugPanel'
import { LibraryProvider } from './state/LibraryContext'

export default function App(): ReactNode {
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [debugVisible, setDebugVisible] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.shiftKey && event.key === '4') {
        event.preventDefault()
        setInspectorVisible((visible) => !visible)
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setDebugVisible((visible) => !visible)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
