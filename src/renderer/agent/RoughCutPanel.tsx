import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Transcript } from '../../shared/types'
import { ABReview } from '../copilot/ABReview'
import { scoreFlow } from '../copilot/flow-score'
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
  const pendingProposal = useTimelineStore((state) => state.pendingProposal)
  const flowReport = useTimelineStore((state) => state.flowReport)
  const [aggressiveness, setAggressiveness] = useState(50)
  const [includeFillers, setIncludeFillers] = useState(true)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [transcripts, setTranscripts] = useState<Map<string, Transcript>>(new Map())
  const [cleanupVoice, setCleanupVoice] = useState(false)
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

  // Proposal mode while the scratch is still computed against this sequence;
  // the human is never locked out, so their edits simply void the proposal.
  // Copilot proposals (ranges === null) belong to the Copilot panel — this
  // panel neither renders nor discards them.
  const roughCutProposal =
    pendingProposal !== null &&
    pendingProposal.ranges !== null &&
    sequence === pendingProposal.baseSequence
      ? { ranges: pendingProposal.ranges }
      : null
  const proposing = roughCutProposal !== null
  useEffect(() => {
    if (pendingProposal !== null && pendingProposal.ranges !== null && !proposing) {
      useTimelineStore.getState().discardProposal()
    }
  }, [pendingProposal, proposing])
  useEffect(
    () => () => {
      const pending = useTimelineStore.getState().pendingProposal
      if (pending !== null && pending.ranges !== null) {
        useTimelineStore.getState().discardProposal()
      }
    },
    []
  )

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

  // preview bands only while planning; the ghost overlay owns the proposal
  // visual and the review list speaks for itself
  useEffect(() => {
    useTimelineStore.getState().setSilenceRanges(reviewing || proposing ? null : included)
  }, [included, reviewing, proposing])
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

  const propose = (): void => {
    if (included.length === 0) return
    if (useTimelineStore.getState().proposeRoughCut(included)) setExcluded(new Set())
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
      {!reviewing && !proposing && (
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
            <label className="silence-field">
              <span>Clean up voice</span>
              <input
                type="checkbox"
                data-testid="roughcut-denoise"
                checked={cleanupVoice}
                onChange={(event) => setCleanupVoice(event.target.checked)}
              />
              <span className="silence-unit">denoise on accept</span>
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
              title="Preview every checked cut as a ghost diff on the timeline — nothing applies until you accept"
              onClick={propose}
            >
              Rough Cut
            </button>
            <button type="button" data-testid="roughcut-cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {roughCutProposal !== null && (
        <>
          <div className="silence-summary" data-testid="roughcut-proposal-summary">
            Proposed: {roughCutProposal.ranges.length} cut
            {roughCutProposal.ranges.length === 1 ? '' : 's'} ·{' '}
            {formatSec(
              roughCutProposal.ranges.reduce(
                (sum, range) => sum + (range.toFlicks - range.fromFlicks),
                0
              )
            )}{' '}
            tighter — hatched on the timeline, green strip shows the result. Nothing has been
            applied yet.
          </div>
          <div className="silence-list" data-testid="roughcut-proposal-list">
            {roughCutProposal.ranges.map((range, index) => (
              <div
                key={rangeKey(range)}
                className="silence-row"
                data-testid={`roughcut-proposed-${index}`}
                onClick={() => seekTo(range.fromFlicks)}
              >
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
          {snapshot !== null && pendingProposal !== null && (
            <ABReview
              base={pendingProposal.baseSequence}
              proposed={pendingProposal.proposedSequence}
              snapshot={snapshot}
            />
          )}
          <div className="silence-actions">
            <button
              type="button"
              className="primary"
              data-testid="roughcut-accept"
              title="Commit the proposed cuts as one undo step"
              onClick={() => {
                const proposed = pendingProposal?.proposedSequence
                useTimelineStore.getState().acceptProposal()
                const next = useTimelineStore.getState().sequence
                if (next !== null) {
                  useTimelineStore
                    .getState()
                    .setFlowReport({ forSequence: next, ...scoreFlow(next, envelopes) })
                }
                if (cleanupVoice && proposed !== undefined) {
                  const assetIds = new Set(
                    proposed.spine
                      .filter((item) => item.kind === 'clip')
                      .map((item) => item.assetId)
                  )
                  for (const assetId of assetIds) void window.api.denoiseAsset(assetId)
                }
              }}
            >
              Accept
            </button>
            <button
              type="button"
              data-testid="roughcut-discard"
              title="Drop the proposal — the timeline never changed"
              onClick={() => useTimelineStore.getState().discardProposal()}
            >
              Discard
            </button>
          </div>
        </>
      )}
      {reviewing && (
        <>
          {flowReport !== null && flowReport.forSequence === sequence && (
            <div
              className={`flow-chip flow-${flowReport.score >= 85 ? 'good' : flowReport.score >= 65 ? 'ok' : 'poor'}`}
              data-testid="roughcut-flow-chip"
              title="Heuristic self-check of the applied pass — flags marked on the ruler"
            >
              Flow score {flowReport.score} · {flowReport.flags.length} flag
              {flowReport.flags.length === 1 ? '' : 's'} on the ruler
            </div>
          )}
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
