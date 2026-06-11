import {
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import type { AssetView, ImportError, Rating } from '../../shared/types'
import { formatDurationFlicks } from '../../shared/timecode'
import { useLibrary } from '../state/LibraryContext'
import { Sidebar } from './Sidebar'
import { AssetCell } from './AssetCell'

type RatingFilter = 'all' | 'favorites' | 'hideRejected'
type ViewMode = 'grid' | 'list'

export function BrowserPanel(): ReactNode {
  const { snapshot, selectedIds, setSelectedIds } = useLibrary()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RatingFilter>('all')
  const [view, setView] = useState<ViewMode>('grid')
  const [eventId, setEventId] = useState<string | null>(null)
  const [importErrors, setImportErrors] = useState<ImportError[]>([])
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)

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

  const onKeyDown = (event: KeyboardEvent): void => {
    if (selectedIds.length === 0) return
    const key = event.key.toLowerCase()
    if (key === 'f') rateSelected('favorite')
    else if (key === 'delete') rateSelected('rejected')
    else if (key === 'u') rateSelected('none')
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

  return (
    <section className="panel panel-browser" data-testid="panel-browser">
      <header className="panel-header">Browser</header>
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
            <div className="browser-empty">No media — File → Import Media… or drop files here</div>
          )}
          {view === 'grid' ? (
            <div className="asset-grid">
              {visibleAssets.map((asset) => (
                <AssetCell
                  key={asset.id}
                  asset={asset}
                  selected={selectedIds.includes(asset.id)}
                  onSelect={(event) => selectAsset(asset, event)}
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
    </section>
  )
}
