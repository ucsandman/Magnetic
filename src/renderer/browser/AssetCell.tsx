import { useState, type MouseEvent, type ReactNode } from 'react'
import type { AssetView } from '../../shared/types'
import { formatDurationFlicks } from '../../shared/timecode'
import { Waveform } from './Waveform'

interface AssetCellProps {
  asset: AssetView
  selected: boolean
  onSelect(event: MouseEvent): void
  onOpen(): void
}

const RATING_GLYPH: Record<string, string> = { favorite: '★', rejected: '✕' }

export function AssetCell({ asset, selected, onSelect, onOpen }: AssetCellProps): ReactNode {
  const [frameIndex, setFrameIndex] = useState(0)
  const strip = asset.filmstrip
  const isVideo = asset.video !== undefined
  const ready = isVideo ? strip !== undefined : asset.waveform !== undefined

  const onMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    if (strip === undefined) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(0.999, Math.max(0, (event.clientX - rect.left) / rect.width))
    setFrameIndex(Math.floor(ratio * strip.frameCount))
  }

  return (
    <div
      className={`asset-cell ${selected ? 'selected' : ''}`}
      data-testid={`asset-cell-${asset.fileName}`}
      data-rating={asset.rating}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-magnetic-asset', asset.id)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        if (asset.audio !== undefined) void window.api.transcribeAsset(asset.id)
      }}
      title={asset.audio !== undefined ? 'Right-click to transcribe' : undefined}
    >
      <div
        className={`asset-media ${ready ? '' : 'shimmer'}`}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setFrameIndex(0)}
      >
        {strip !== undefined && (
          <div
            className="asset-strip"
            data-testid="asset-strip"
            style={{
              width: `${strip.frameW}px`,
              height: `${strip.frameH}px`,
              backgroundImage: `url("${strip.url}")`,
              backgroundPosition: `-${frameIndex * strip.frameW}px 0px`
            }}
          />
        )}
        {!isVideo && asset.waveform !== undefined && <Waveform url={asset.waveform.url} />}
        {!ready && <span className="asset-pending">processing…</span>}
      </div>
      <div className="asset-meta">
        <span className="asset-name" title={asset.fileName}>
          {asset.fileName}
        </span>
        <span className="asset-badges">
          {asset.missing && (
            <button
              type="button"
              className="asset-missing-badge"
              data-testid="asset-relink"
              title="Media file is missing — click to relink"
              onClick={(event) => {
                event.stopPropagation()
                void window.api.relinkAsset(asset.id)
              }}
            >
              ⚠ Relink
            </button>
          )}
          {asset.proxyUrl !== undefined && (
            <span
              className="asset-proxy-badge"
              data-testid="asset-proxy"
              title="This codec is not natively decodable — playback uses an H.264 preview proxy"
            >
              proxy
            </span>
          )}
          <span className="asset-rating" data-testid="asset-rating">
            {RATING_GLYPH[asset.rating] ?? ''}
          </span>
          <span className="asset-duration" data-testid="asset-duration">
            {formatDurationFlicks(asset.durationFlicks)}
          </span>
        </span>
      </div>
    </div>
  )
}
