import type { ReactNode } from 'react'
import { useTimelineStore } from '../state/timeline-store'

/**
 * Surfaces EXTERNAL agent proposals right on the timeline — the human must
 * never have to hunt for a pending ghost diff an MCP client created. Accept
 * and Discard are the same store actions as the Copilot card (full accept;
 * for per-change checkboxes open the Copilot tab, which shows the same
 * proposal).
 */
export function AgentProposalBanner(): ReactNode {
  const sequence = useTimelineStore((state) => state.sequence)
  const pendingProposal = useTimelineStore((state) => state.pendingProposal)
  if (
    pendingProposal === null ||
    pendingProposal.label !== 'Agent' ||
    sequence !== pendingProposal.baseSequence
  ) {
    return null
  }
  return (
    <div className="agent-banner" data-testid="agent-banner">
      <span>
        ⚡ External agent proposes {pendingProposal.changes.length} change
        {pendingProposal.changes.length === 1 ? '' : 's'} — previewed below, nothing applied yet.
      </span>
      <button
        type="button"
        className="primary"
        data-testid="agent-banner-accept"
        onClick={() => useTimelineStore.getState().acceptProposal()}
      >
        Accept
      </button>
      <button
        type="button"
        data-testid="agent-banner-discard"
        onClick={() => useTimelineStore.getState().discardProposal()}
      >
        Discard
      </button>
    </div>
  )
}
