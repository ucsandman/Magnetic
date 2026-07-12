import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { diffDeletions, proposedTimeAt } from '../../shared/timeline/diff'
import type { Sequence } from '../../shared/timeline/model'
import { sequenceDuration } from '../../shared/timeline/model'
import type { LibrarySnapshot } from '../../shared/types'
import { renderProposalPair } from './preview-engine'

const fmtSec = (flicks: number): string => `${(flicks / FLICKS_PER_SECOND).toFixed(2)} s`

/**
 * Split-screen before/after of a pending proposal: REAL frames from the
 * playback engine, base on the left, proposed on the right, kept on the same
 * moment of content via proposedTimeAt. Scrub the slider across the changed
 * region; renders are debounced and strictly sequential (preview-engine.ts).
 */
export function ABReview({
  base,
  proposed,
  snapshot
}: {
  base: Sequence
  proposed: Sequence
  snapshot: LibrarySnapshot
}): ReactNode {
  const deletions = useMemo(() => diffDeletions(base, proposed), [base, proposed])
  const duration = useMemo(() => sequenceDuration(base), [base])
  const [positionFlicks, setPositionFlicks] = useState(() =>
    deletions.length > 0 ? deletions[0].fromFlicks : 0
  )
  const [blocked, setBlocked] = useState(false)
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const proposedCanvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      const proposedFlicks = proposedTimeAt(deletions, positionFlicks)
      void renderProposalPair(base, proposed, snapshot, positionFlicks, proposedFlicks).then(
        (frames) => {
          if (disposed) {
            frames?.base.close()
            frames?.proposed.close()
            return
          }
          setBlocked(frames === null)
          if (frames === null) return
          for (const [canvas, bitmap] of [
            [baseCanvasRef.current, frames.base],
            [proposedCanvasRef.current, frames.proposed]
          ] as const) {
            if (canvas === null) {
              bitmap.close()
              continue
            }
            const ctx = canvas.getContext('2d')
            ctx?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
            bitmap.close()
          }
        }
      )
    }, 120)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [base, proposed, snapshot, deletions, positionFlicks])

  return (
    <div className="ab-review" data-testid="ab-review">
      <div className="ab-review-panes">
        <figure>
          <canvas ref={baseCanvasRef} width={320} height={180} data-testid="ab-before" />
          <figcaption>Before · {fmtSec(positionFlicks)}</figcaption>
        </figure>
        <figure>
          <canvas ref={proposedCanvasRef} width={320} height={180} data-testid="ab-after" />
          <figcaption>After · {fmtSec(proposedTimeAt(deletions, positionFlicks))}</figcaption>
        </figure>
      </div>
      <input
        type="range"
        data-testid="ab-position"
        min={0}
        max={Math.max(1, duration)}
        step={FLICKS_PER_SECOND / 30}
        value={positionFlicks}
        onChange={(event) => setPositionFlicks(Number(event.target.value))}
      />
      {blocked && (
        <div className="ab-review-blocked">Pause playback to see the before/after frames.</div>
      )}
    </div>
  )
}
