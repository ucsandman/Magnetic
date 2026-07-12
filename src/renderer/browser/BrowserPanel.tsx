import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { AssetView, ImportError, Rating } from '../../shared/types'
import { formatDurationFlicks } from '../../shared/timecode'
import { registerShortcut } from '../shortcuts'
import { ContextMenu, type ContextMenuState } from '../context-menu'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { TranscriptPanel } from '../transcript/TranscriptPanel'
import { SilencePanel } from '../silence/SilencePanel'
import { RoughCutPanel } from '../agent/RoughCutPanel'
import { CopilotPanel } from '../copilot/CopilotPanel'
import { Sidebar } from './Sidebar'
import { AssetCell } from './AssetCell'

type RatingFilter = 'all' | 'favorites' | 'hideRejected'
type ViewMode = 'grid' | 'list'

export function BrowserPanel(): ReactNode {
  const { snapshot, selectedIds, setSelectedIds, openAsset, setGridAssetIds } = useLibrary()
  const [tab, setTab] = useState<'clips' | 'transcript' | 'silence' | 'roughcut' | 'copilot'>(
    'clips'
  )
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RatingFilter>('all')
  const [view, setView] = useState<ViewMode>('grid')
  const [eventId, setEventId] = useState<string | null>(null)
  const [importErrors, setImportErrors] = useState<ImportError[]>([])
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const currentEvent =
    snapshot === null
      ? null
      : (snapshot.events.find((event) => event.id === eventId) ?? snapshot.events[0] ?? null)

  const visibleAssets: AssetView[] = useMemo(() => {
    if (snapshot === null || currentEvent === null) return []
    return currentEvent.assetIds
      .map((id) => snapshot.assets[id])
      .filter((asset): asset is AssetView => asset !== undefined)
      .filter((asset) => asset.fileName.toLowerCase().includes(search.toLowerCase()))
      .filter((asset) => {
        if (filter === 'favorites') return asset.rating === 'favorite'
        if (filter === 'hideRejected') return asset.rating !== 'rejected'
        return true
      })
  }, [snapshot, currentEvent, search, filter])

  const selectAsset = (asset: AssetView, event: MouseEvent): void => {
    if (event.shiftKey && lastClickedId !== null) {
      const order = visibleAssets.map((a) => a.id)
      const from = order.indexOf(lastClickedId)
      const to = order.indexOf(asset.id)
      if (from !== -1 && to !== -1) {
        setSelectedIds(order.slice(Math.min(from, to), Math.max(from, to) + 1))
        return
      }
    }
    setLastClickedId(asset.id)
    setSelectedIds([asset.id])
  }

  const rateSelected = (rating: Rating): void => {
    for (const id of selectedIds) {
      void window.api.setAssetRating(id, rating)
    }
  }

  const openInViewer = (assetId: string): void => {
    openAsset(assetId)
    document.querySelector<HTMLElement>('[data-testid="panel-viewer"]')?.focus()
  }

  const showAssetMenu = (asset: AssetView, event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const targetIds = selectedIds.includes(asset.id) ? selectedIds : [asset.id]
    if (!selectedIds.includes(asset.id)) {
      setLastClickedId(asset.id)
      setSelectedIds([asset.id])
    }
    const targetAssets = targetIds
      .map((id) => snapshot?.assets[id])
      .filter((candidate): candidate is AssetView => candidate !== undefined)
    const audioAssets = targetAssets.filter((candidate) => candidate.audio !== undefined)
    const deleteLabel = targetIds.length === 1 ? 'Delete Media' : `Delete ${targetIds.length} Items`
    const deleteMessage =
      targetIds.length === 1
        ? `Delete "${asset.fileName}" from the library? This also removes its timeline clips.`
        : `Delete ${targetIds.length} items from the library? This also removes their timeline clips.`
    const deleteAssets = (): void => {
      if (!window.confirm(deleteMessage)) return
      void (async () => {
        try {
          await Promise.all(targetIds.map((id) => window.api.deleteAsset(id)))
        } catch (error) {
          window.alert(`Delete failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          // Reconcile even on partial failure: other deletes may have landed
          // and main has already pruned their clips from the saved sequence.
          setSelectedIds(selectedIds.filter((id) => !targetIds.includes(id)))
          await useTimelineStore.getState().load()
        }
      })()
    }
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          id: 'open-viewer',
          label: 'Open in Viewer',
          onSelect: () => openInViewer(asset.id)
        },
        {
          id: 'favorite',
          label: 'Favorite',
          separatorBefore: true,
          onSelect: () => targetIds.forEach((id) => void window.api.setAssetRating(id, 'favorite'))
        },
        {
          id: 'reject',
          label: 'Reject',
          onSelect: () => targetIds.forEach((id) => void window.api.setAssetRating(id, 'rejected'))
        },
        {
          id: 'clear-rating',
          label: 'Clear Rating',
          onSelect: () => targetIds.forEach((id) => void window.api.setAssetRating(id, 'none'))
        },
        {
          id: 'transcribe',
          label: 'Transcribe',
          separatorBefore: true,
          disabled: audioAssets.length === 0,
          onSelect: () =>
            audioAssets.forEach((candidate) => void window.api.transcribeAsset(candidate.id))
        },
        {
          id: 'denoise',
          label: audioAssets.every((candidate) => candidate.denoisedUrl !== undefined)
            ? 'Clean Up Audio ✓ (redo)'
            : 'Clean Up Audio',
          disabled: audioAssets.length === 0,
          onSelect: () =>
            audioAssets.forEach((candidate) => void window.api.denoiseAsset(candidate.id))
        },
        {
          id: 'relink',
          label: 'Relink',
          disabled: !asset.missing,
          onSelect: () => void window.api.relinkAsset(asset.id)
        },
        {
          id: 'delete-media',
          label: deleteLabel,
          danger: true,
          separatorBefore: true,
          onSelect: deleteAssets
        }
      ]
    })
  }

  const closeContextMenu = useCallback((): void => setContextMenu(null), [])

  const onKeyDown = (event: KeyboardEvent): void => {
    if (selectedIds.length === 0) return
    const key = event.key.toLowerCase()
    if (key === 'f') rateSelected('favorite')
    else if (key === 'delete') rateSelected('rejected')
    else if (key === 'u') rateSelected('none')
    else if (key === 'enter') openInViewer(selectedIds[0])
  }

  const onDrop = async (event: DragEvent): Promise<void> => {
    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files).map((file) => window.api.pathForFile(file))
    if (paths.length === 0) return
    const result = await window.api.importPaths(paths)
    if (result.errors.length > 0) setImportErrors(result.errors)
  }

  const onImportClick = async (): Promise<void> => {
    const result = await window.api.importDialog()
    if (result.errors.length > 0) setImportErrors(result.errors)
  }

  // Ctrl+Shift+T toggles the timeline-transcript tab
  useEffect(() => {
    return registerShortcut('browser-transcript-tab', {
      combo: 'ctrl+shift+t',
      description: 'Show or hide the timeline transcript',
      handler: () => setTab((current) => (current === 'clips' ? 'transcript' : 'clips'))
    })
  }, [])

  return (
    <section className="panel panel-browser" data-testid="panel-browser">
      <header className="panel-header">
        Browser
        <span className="inspector-tabs">
          <button
            type="button"
            className={tab === 'clips' ? 'active' : ''}
            data-testid="browser-tab-clips"
            onClick={() => setTab('clips')}
          >
            Clips
          </button>
          <button
            type="button"
            className={tab === 'transcript' ? 'active' : ''}
            data-testid="browser-tab-transcript"
            onClick={() => setTab('transcript')}
          >
            Transcript
          </button>
          <button
            type="button"
            className={tab === 'silence' ? 'active' : ''}
            data-testid="browser-tab-silence"
            onClick={() => setTab('silence')}
          >
            Silence
          </button>
          <button
            type="button"
            className={tab === 'roughcut' ? 'active' : ''}
            data-testid="browser-tab-roughcut"
            onClick={() => setTab('roughcut')}
          >
            Rough Cut
          </button>
          <button
            type="button"
            className={tab === 'copilot' ? 'active' : ''}
            data-testid="browser-tab-copilot"
            onClick={() => setTab('copilot')}
          >
            Copilot
          </button>
        </span>
      </header>
      {tab === 'transcript' && <TranscriptPanel />}
      {tab === 'silence' && <SilencePanel onClose={() => setTab('clips')} />}
      {tab === 'roughcut' && <RoughCutPanel onClose={() => setTab('clips')} />}
      {tab === 'copilot' && <CopilotPanel onClose={() => setTab('clips')} />}
      {tab === 'clips' && (
        <>
          <div className="panel-toolbar">
            <button type="button" data-testid="browser-import" onClick={() => void onImportClick()}>
              Import
            </button>
            <input
              type="search"
              className="browser-search"
              data-testid="browser-search"
              placeholder="Search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              data-testid="browser-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value as RatingFilter)}
            >
              <option value="all">All Clips</option>
              <option value="favorites">Favorites</option>
              <option value="hideRejected">Hide Rejected</option>
            </select>
            <button
              type="button"
              data-testid="browser-view-toggle"
              onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
            >
              {view === 'grid' ? 'List' : 'Grid'}
            </button>
            {selectedIds.length >= 2 && (
              <button
                type="button"
                data-testid="browser-grid-preview"
                title={
                  selectedIds.length > 9
                    ? 'Watch the first 9 selected clips side by side'
                    : 'Watch the selected clips side by side'
                }
                onClick={() => setGridAssetIds(selectedIds.slice(0, 9))}
              >
                Watch {Math.min(selectedIds.length, 9)}
              </button>
            )}
          </div>
          {importErrors.length > 0 && (
            <div className="import-errors" data-testid="import-errors">
              {importErrors.map((error) => (
                <div key={error.file}>
                  Could not import {error.file}: {error.reason}
                </div>
              ))}
              <button type="button" onClick={() => setImportErrors([])}>
                Dismiss
              </button>
            </div>
          )}
          <div className="browser-content">
            {snapshot !== null && (
              <Sidebar
                snapshot={snapshot}
                selectedEventId={currentEvent?.id ?? null}
                onSelectEvent={setEventId}
              />
            )}
            <div
              className="browser-assets"
              data-testid="browser-assets"
              tabIndex={0}
              onKeyDown={onKeyDown}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void onDrop(event)}
            >
              {visibleAssets.length === 0 && (
                <div className="browser-empty">
                  No media — File → Import Media… or drop files here
                </div>
              )}
              {view === 'grid' ? (
                <div className="asset-grid">
                  {visibleAssets.map((asset) => (
                    <AssetCell
                      key={asset.id}
                      asset={asset}
                      selected={selectedIds.includes(asset.id)}
                      onSelect={(event) => selectAsset(asset, event)}
                      onOpen={() => openInViewer(asset.id)}
                      onContextMenu={(event) => showAssetMenu(asset, event)}
                    />
                  ))}
                </div>
              ) : (
                <table className="asset-list">
                  <tbody>
                    {visibleAssets.map((asset) => (
                      <tr
                        key={asset.id}
                        data-testid={`asset-row-${asset.fileName}`}
                        data-rating={asset.rating}
                        className={selectedIds.includes(asset.id) ? 'selected' : ''}
                        onClick={(event) => selectAsset(asset, event)}
                        onContextMenu={(event) => showAssetMenu(asset, event)}
                      >
                        <td>{asset.fileName}</td>
                        <td>{formatDurationFlicks(asset.durationFlicks)}</td>
                        <td>{asset.rating === 'none' ? '' : asset.rating}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <ContextMenu menu={contextMenu} onClose={closeContextMenu} />
        </>
      )}
    </section>
  )
}
