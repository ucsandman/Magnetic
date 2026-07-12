import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Transcript } from '../../shared/types'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { useAssetEnvelopes } from '../silence/use-envelopes'
import { ensureTranscripts } from '../transcript/cache'
import { planRoughCut, silenceOptionsFor, type CutReason, type RoughCutRange } from './roughcut'

const rangeKey = (range: RoughCutRange): string => `${range.fromFlicks}:${range.toFlicks}`
const formatSec = (flicks: number): string => `${(flicks / FLICKS_PER_SECOND).toFixed(2)} s`
const reasonLabel: Record<CutReason, string> = { silence: 'dead air', filler: 'filler' }

/**
 * One-button rough cut: merge silence + filler detection into a single plan,
 * preview it as timeline bands, apply it as ONE undo step, then review the
 * applied cuts spell-checker style — each row seeks to its cut and can be
 * individually rejected (restored) while the pass is still the top of history.
 * The first agent-authored surface: every cut is attributed and reversible.
 */
export function RoughCutPanel({ onClose }: { onClose(): void }): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const roughCut = useTimelineStore((state) => state.roughCut)
  const [aggressiveness, setAggressiveness] = useState(50)
  const [includeFillers, setIncludeFillers] = useState(true)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [transcripts, setTranscripts] = useState<Map<string, Transcript>>(new Map())
  const { envelopes, analysisFailures } = useAssetEnvelopes(sequence, snapshot)

  useEffect(() => {
    if (sequence === null || snapshot === null) return
    let disposed = false
    void ensureTranscripts(sequence, snapshot).then((map) => {
      if (!disposed) setTranscripts(map)
    })
    return () => {
      disposed = true
    }
  }, [sequence, snapshot])

  // Review mode while the applied pass is still the sequence's top of history;
  // any other edit or undo replaces the sequence object and ends the review.
  const reviewing = roughCut !== null && sequence === roughCut.resultSequence
  useEffect(() => {
    if (roughCut !== null && !reviewing) useTimelineStore.getState().clearRoughCut()
  }, [roughCut, reviewing])

  const plan = useMemo(
    () =>
      sequence === null
        ? []
        : planRoughCut(sequence, transcripts, envelopes, {
            silence: silenceOptionsFor(aggressiveness / 100),
            includeFillers
          }),
    [sequence, transcripts, envelopes, aggressiveness, includeFillers]
  )

  const included = useMemo(
    () => plan.filter((range) => !excluded.has(rangeKey(range))),
    [plan, excluded]
  )

  // preview bands only while planning; the review list speaks for itself
  useEffect(() => {
    useTimelineStore.getState().setSilenceRanges(reviewing ? null : included)
  }, [included, reviewing])
  useEffect(() => () => useTimelineStore.getState().setSilenceRanges(null), [])

  const totalFlicks = included.reduce((sum, range) => sum + (range.toFlicks - range.fromFlicks), 0)

  const seekTo = (flicks: number): void => {
    const store = useTimelineStore.getState()
    store.setViewerMode('sequence')
    store.setPlayhead(flicks)
  }

  const toggleExcluded = (range: RoughCutRange): void => {
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
    useTimelineStore.getState().applyRoughCut(included)
    setExcluded(new Set())
  }

  const finish = (): void => {
    useTimelineStore.getState().clearRoughCut()
    onClose()
  }

  return (
    <div
      className="silence-panel"
      data-testid="roughcut-panel"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      {!reviewing && (
        <>
          <div className="silence-controls">
            <label className="silence-field">
              <span>Aggressiveness</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={aggressiveness}
                onChange={(event) => setAggressiveness(Number(event.target.value))}
              />
              <input
                type="number"
                data-testid="roughcut-aggressiveness"
                min={0}
                max={100}
                step={1}
                value={aggressiveness}
                onChange={(event) => setAggressiveness(Number(event.target.value))}
              />
              <span className="silence-unit">%</span>
            </label>
            <label className="silence-field">
              <span>Remove fillers</span>
              <input
                type="checkbox"
                data-testid="roughcut-fillers"
                checked={includeFillers}
                onChange={(event) => setIncludeFillers(event.target.checked)}
              />
              <span className="silence-unit">um, uh, you know…</span>
            </label>
          </div>
          <div className="silence-summary" data-testid="roughcut-summary">
            {included.length} cut{included.length === 1 ? '' : 's'} · {formatSec(totalFlicks)}{' '}
            tighter
          </div>
          <div className="silence-list" data-testid="roughcut-list">
            {analysisFailures > 0 && (
              <div className="browser-empty" data-testid="roughcut-analysis-failed">
                Audio analysis failed for {analysisFailures} clip
                {analysisFailures === 1 ? '' : 's'} — dead air in those clips cannot be detected.
              </div>
            )}
            {plan.length === 0 && analysisFailures === 0 && (
              <div className="browser-empty">
                Nothing to cut yet — add clips with audio (analysis and transcription run in the
                background after import), or raise the aggressiveness.
              </div>
            )}
            {plan.map((range, index) => (
              <div
                key={rangeKey(range)}
                className={`silence-row ${excluded.has(rangeKey(range)) ? 'excluded' : ''}`}
                data-testid={`roughcut-row-${index}`}
                onClick={() => seekTo(range.fromFlicks)}
              >
                <input
                  type="checkbox"
                  data-testid={`roughcut-row-include-${index}`}
                  checked={!excluded.has(rangeKey(range))}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggleExcluded(range)}
                />
                <span className="silence-row-start">{formatSec(range.fromFlicks)}</span>
                <span className="silence-row-duration">
                  {formatSec(range.toFlicks - range.fromFlicks)}
                </span>
                <span className={`roughcut-reason roughcut-reason-${range.reason}`}>
                  {reasonLabel[range.reason]}
                </span>
              </div>
            ))}
          </div>
          <div className="silence-actions">
            <button
              type="button"
              className="primary"
              data-testid="roughcut-apply"
              disabled={included.length === 0}
              title="Ripple-delete every checked range (one undo step), then review each cut"
              onClick={apply}
            >
              Rough Cut
            </button>
            <button type="button" data-testid="roughcut-cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {reviewing && (
        <>
          <div className="silence-summary" data-testid="roughcut-review-summary">
            Rough cut applied: {roughCut.cuts.length} cut{roughCut.cuts.length === 1 ? '' : 's'} ·{' '}
            {formatSec(roughCut.cuts.reduce((sum, cut) => sum + cut.removedFlicks, 0))} removed —
            click a cut to review it, Reject restores just that one. Ctrl+Z undoes the whole pass.
          </div>
          <div className="silence-list" data-testid="roughcut-review-list">
            {roughCut.cuts.map((cut, index) => (
              <div
                key={`${cut.flicks}:${index}`}
                className="silence-row"
                data-testid={`roughcut-cut-${index}`}
                onClick={() => seekTo(cut.flicks)}
              >
                <span className="roughcut-ai-badge">AI</span>
                <span className="silence-row-start">{formatSec(cut.flicks)}</span>
                <span className="silence-row-duration">−{formatSec(cut.removedFlicks)}</span>
                <span className={`roughcut-reason roughcut-reason-${cut.reason}`}>
                  {reasonLabel[cut.reason]}
                </span>
                <button
                  type="button"
                  data-testid={`roughcut-reject-${index}`}
                  title="Restore this cut; the others stay"
                  onClick={(event) => {
                    event.stopPropagation()
                    useTimelineStore.getState().rejectRoughCutCut(index)
                  }}
                >
                  Reject
                </button>
              </div>
            ))}
          </div>
          <div className="silence-actions">
            <button type="button" className="primary" data-testid="roughcut-done" onClick={finish}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  )
}
