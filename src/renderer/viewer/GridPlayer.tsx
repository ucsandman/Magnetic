import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AssetView } from '../../shared/types'
import { registerShortcut } from '../shortcuts'
import { useLibrary } from '../state/LibraryContext'
import { GRID_MAX_CELLS, gridColumns } from './grid-layout'
import { useMediaUrl } from './use-media-url'

/**
 * Multi-clip review grid: every selected clip plays at once (muted), like a
 * multiview monitor. Click a cell to solo its audio; double-click to open
 * that clip in the source viewer.
 */
export function GridPlayer({ assetIds }: { assetIds: string[] }): ReactNode {
  const { snapshot, setGridAssetIds, openAsset } = useLibrary()
  const [soloId, setSoloId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(true)
  const videosRef = useRef(new Map<string, HTMLVideoElement>())

  const assets = assetIds
    .slice(0, GRID_MAX_CELLS)
    .map((id) => snapshot?.assets[id])
    .filter((asset): asset is AssetView => asset !== undefined)

  const close = useCallback((): void => {
    setGridAssetIds(null)
    document.querySelector<HTMLElement>('[data-testid="browser-assets"]')?.focus()
  }, [setGridAssetIds])

  useEffect(() => {
    return registerShortcut('grid-close', {
      combo: 'escape',
      description: 'Close the clip grid',
      when: () => document.querySelector('[data-testid="export-dialog"]') === null,
      handler: close
    })
  }, [close])

  const eachVideo = (apply: (video: HTMLVideoElement) => void): void => {
    videosRef.current.forEach(apply)
  }

  const togglePlaying = (): void => {
    setPlaying((current) => {
      const next = !current
      eachVideo((video) => {
        if (next) void video.play()
        else video.pause()
      })
      return next
    })
  }

  return (
    <section className="panel panel-viewer" data-testid="panel-viewer" tabIndex={0}>
      <header className="panel-header">
        Viewer
        <span className="viewer-mode-badge" data-testid="viewer-mode">
          grid
        </span>
      </header>
      <div className="panel-toolbar">
        <span data-testid="grid-count">
          {assets.length} clips — click for audio, double-click to open
        </span>
        <span className="spacer" />
        <button
          type="button"
          data-testid="grid-restart"
          title="Restart all clips from the beginning"
          onClick={() =>
            eachVideo((video) => {
              video.currentTime = 0
            })
          }
        >
          ⇤
        </button>
        <button
          type="button"
          data-testid="grid-play-pause"
          title="Play / pause all clips"
          onClick={togglePlaying}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" data-testid="grid-close" title="Close the grid (Esc)" onClick={close}>
          ✕
        </button>
      </div>
      <div
        className="grid-player"
        style={{ '--grid-cols': gridColumns(assets.length) } as CSSProperties}
      >
        {assets.map((asset) => (
          <GridCell
            key={asset.id}
            asset={asset}
            soloed={soloId === asset.id}
            onVideo={(video) => {
              if (video === null) videosRef.current.delete(asset.id)
              else videosRef.current.set(asset.id, video)
            }}
            onSolo={() => setSoloId((current) => (current === asset.id ? null : asset.id))}
            onPromote={() => openAsset(asset.id)}
          />
        ))}
      </div>
    </section>
  )
}

function GridCell({
  asset,
  soloed,
  onVideo,
  onSolo,
  onPromote
}: {
  asset: AssetView
  soloed: boolean
  onVideo(video: HTMLVideoElement | null): void
  onSolo(): void
  onPromote(): void
}): ReactNode {
  const url = useMediaUrl(asset)
  const playable = !asset.missing && url !== ''
  return (
    <div
      className={`grid-cell ${soloed ? 'soloed' : ''}`}
      data-testid={`grid-cell-${asset.fileName}`}
      onClick={onSolo}
      onDoubleClick={onPromote}
      title="Click for audio — double-click to open in the viewer"
    >
      {playable ? (
        <video src={url} muted={!soloed} autoPlay loop ref={onVideo} />
      ) : (
        <span className="grid-cell-unavailable">
          {asset.missing ? 'media missing' : 'preparing preview…'}
        </span>
      )}
      <div className="grid-cell-label">
        <span className="grid-cell-name">{asset.fileName}</span>
        {soloed && (
          <span className="grid-cell-audio" data-testid="grid-cell-audio">
            audio
          </span>
        )}
      </div>
    </div>
  )
}
