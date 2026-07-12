import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { DEFAULT_THRESHOLD_DB, detectSilence, type TimeRange } from './detect'
import { useAssetEnvelopes } from './use-envelopes'

/** UI clamp: pathological thresholds must not yield thousands of micro-cuts. */
const MIN_DURATION_FLOOR_SEC = 0.25

const rangeKey = (range: TimeRange): string => `${range.fromFlicks}:${range.toFlicks}`
const formatSec = (flicks: number): string => `${(flicks / FLICKS_PER_SECOND).toFixed(2)} s`

/**
 * Auto silence removal: re-threshold the cached per-asset RMS envelopes live
 * (no ffmpeg re-run), preview candidate ranges as bands on the timeline, and
 * cut them all through deleteRanges — one undo step, exactly like Remove
 * fillers. Authored spine gaps are intentionally not detected.
 */
export function SilencePanel({ onClose }: { onClose(): void }): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB)
  const [minDurationSec, setMinDurationSec] = useState(0.5)
  const [paddingMs, setPaddingMs] = useState(100)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const { envelopes, analysisFailures } = useAssetEnvelopes(sequence, snapshot)

  const detected = useMemo(
    () =>
      sequence === null
        ? []
        : detectSilence(sequence, envelopes, {
            thresholdDb,
            minDurationFlicks: Math.round(
              Math.max(MIN_DURATION_FLOOR_SEC, minDurationSec) * FLICKS_PER_SECOND
            ),
            padFlicks: Math.round((paddingMs / 1000) * FLICKS_PER_SECOND)
          }),
    [sequence, envelopes, thresholdDb, minDurationSec, paddingMs]
  )

  const included = useMemo(
    () => detected.filter((range) => !excluded.has(rangeKey(range))),
    [detected, excluded]
  )

  // preview: push the candidate ranges to the timeline overlay; clear on close
  useEffect(() => {
    useTimelineStore.getState().setSilenceRanges(included)
  }, [included])
  useEffect(() => () => useTimelineStore.getState().setSilenceRanges(null), [])

  const totalFlicks = included.reduce((sum, range) => sum + (range.toFlicks - range.fromFlicks), 0)

  const seekTo = (flicks: number): void => {
    const store = useTimelineStore.getState()
    store.setViewerMode('sequence')
    store.setPlayhead(flicks)
  }

  const toggleExcluded = (range: TimeRange): void => {
    setExcluded((current) => {
      const next = new Set(current)
      const key = rangeKey(range)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const apply = (): void => {
    if (included.length === 0) return
    useTimelineStore.getState().deleteRanges(included)
    setExcluded(new Set())
  }

  return (
    <div
      className="silence-panel"
      data-testid="silence-panel"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="silence-controls">
        <label className="silence-field">
          <span>Threshold</span>
          <input
            type="range"
            min={-60}
            max={-10}
            step={1}
            value={thresholdDb}
            onChange={(event) => setThresholdDb(Number(event.target.value))}
          />
          <input
            type="number"
            data-testid="silence-threshold"
            min={-100}
            max={0}
            step={1}
            value={thresholdDb}
            onChange={(event) => setThresholdDb(Number(event.target.value))}
          />
          <span className="silence-unit">dB</span>
        </label>
        <label className="silence-field">
          <span>Min duration</span>
          <input
            type="range"
            min={MIN_DURATION_FLOOR_SEC}
            max={3}
            step={0.05}
            value={minDurationSec}
            onChange={(event) => setMinDurationSec(Number(event.target.value))}
          />
          <input
            type="number"
            data-testid="silence-min-duration"
            min={MIN_DURATION_FLOOR_SEC}
            max={10}
            step={0.05}
            value={minDurationSec}
            onChange={(event) => setMinDurationSec(Number(event.target.value))}
          />
          <span className="silence-unit">s</span>
        </label>
        <label className="silence-field">
          <span>Padding</span>
          <input
            type="range"
            min={0}
            max={500}
            step={10}
            value={paddingMs}
            onChange={(event) => setPaddingMs(Number(event.target.value))}
          />
          <input
            type="number"
            data-testid="silence-padding"
            min={0}
            max={2000}
            step={10}
            value={paddingMs}
            onChange={(event) => setPaddingMs(Number(event.target.value))}
          />
          <span className="silence-unit">ms</span>
        </label>
      </div>
      <div className="silence-summary" data-testid="silence-summary">
        {included.length} gap{included.length === 1 ? '' : 's'} · {formatSec(totalFlicks)} total
      </div>
      <div className="silence-list" data-testid="silence-list">
        {analysisFailures > 0 && (
          <div className="browser-empty" data-testid="silence-analysis-failed">
            Audio analysis failed for {analysisFailures} clip{analysisFailures === 1 ? '' : 's'} —
            silence in those clips cannot be detected. Check the media and re-import to retry.
          </div>
        )}
        {detected.length === 0 && analysisFailures === 0 && (
          <div className="browser-empty">
            No dead air detected — add clips with audio (analysis runs in the background after
            import), or raise the threshold. Authored gaps are not detected.
          </div>
        )}
        {detected.map((range, index) => (
          <div
            key={rangeKey(range)}
            className={`silence-row ${excluded.has(rangeKey(range)) ? 'excluded' : ''}`}
            data-testid={`silence-row-${index}`}
            onClick={() => seekTo(range.fromFlicks)}
          >
            <input
              type="checkbox"
              data-testid={`silence-row-include-${index}`}
              checked={!excluded.has(rangeKey(range))}
              onClick={(event) => event.stopPropagation()}
              onChange={() => toggleExcluded(range)}
            />
            <span className="silence-row-start">{formatSec(range.fromFlicks)}</span>
            <span className="silence-row-duration">
              {formatSec(range.toFlicks - range.fromFlicks)}
            </span>
          </div>
        ))}
      </div>
      <div className="silence-actions">
        <button
          type="button"
          className="primary"
          data-testid="silence-apply"
          disabled={included.length === 0}
          title="Ripple-delete every checked gap (one undo step)"
          onClick={apply}
        >
          Cut {included.length} gap{included.length === 1 ? '' : 's'}
        </button>
        <button type="button" data-testid="silence-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
