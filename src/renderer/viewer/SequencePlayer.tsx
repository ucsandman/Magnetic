import { useEffect, useRef, type ReactNode } from 'react'
import { flicksToTimecode } from '../../shared/timecode'
import { sequenceDuration, spineEditPoints } from '../../shared/timeline/model'
import { playbackEngine } from '../playback/engine'
import { goToSequenceEnd, seekSequence, toggleSequencePlayback } from '../playback/transport'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'

/**
 * The viewer's sequence mode: a WebGL2 compositor canvas driven by the
 * playback engine. While paused, every playhead or sequence change renders a
 * still; during playback the engine animates the timeline playhead.
 */
export function SequencePlayer(): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const playheadFlicks = useTimelineStore((state) => state.playheadFlicks)
  const isPlaying = useTimelineStore((state) => state.isSequencePlaying)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    playbackEngine.attach(canvas)
    return () => {
      playbackEngine.detach()
    }
  }, [])

  // paused scrub/seek and edits-while-paused → still render
  useEffect(() => {
    if (playbackEngine.isPlaying || sequence === null || snapshotRef.current === null) return
    void playbackEngine.renderStill(sequence, snapshotRef.current, playheadFlicks)
  }, [sequence, playheadFlicks, snapshot])

  // edits during playback → rebuild from the current position
  useEffect(() => {
    if (!playbackEngine.isPlaying || sequence === null || snapshotRef.current === null) return
    void playbackEngine.play(
      sequence,
      snapshotRef.current,
      useTimelineStore.getState().playheadFlicks
    )
  }, [sequence])

  const fps = sequence?.fps ?? { num: 30, den: 1 }
  const empty = sequence === null || sequenceDuration(sequence) === 0
  return (
    <section className="panel panel-viewer" data-testid="panel-viewer" tabIndex={0}>
      <header className="panel-header">
        Viewer
        <span className="viewer-mode-badge" data-testid="viewer-mode">
          sequence
        </span>
      </header>
      <div className="panel-toolbar">
        <span className="viewer-tc" data-testid="sequence-timecode">
          {flicksToTimecode(playheadFlicks, fps)}
        </span>
        <span className="spacer" />
        <span data-testid="sequence-playing">{isPlaying ? 'playing' : 'paused'}</span>
      </div>
      <div className="panel-body">
        <canvas ref={canvasRef} className="sequence-canvas" data-testid="sequence-canvas" />
      </div>
      <div className="viewer-transport">
        <button
          type="button"
          data-testid="sequence-go-start"
          title="Go to start (Home)"
          disabled={empty}
          onClick={() => seekSequence(sequence, snapshot, 0)}
        >
          ⇤
        </button>
        <button
          type="button"
          data-testid="sequence-prev-edit"
          title="Previous edit point (↑)"
          disabled={empty}
          onClick={() => {
            if (sequence === null) return
            const playhead = useTimelineStore.getState().playheadFlicks
            const prev = spineEditPoints(sequence)
              .reverse()
              .find((point) => point < playhead)
            if (prev !== undefined) seekSequence(sequence, snapshot, prev)
          }}
        >
          ⏮
        </button>
        <button
          type="button"
          data-testid="sequence-play-pause"
          title="Play / pause the sequence (Space)"
          disabled={empty}
          onClick={() => toggleSequencePlayback(sequence, snapshot)}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          data-testid="sequence-next-edit"
          title="Next edit point (↓)"
          disabled={empty}
          onClick={() => {
            if (sequence === null) return
            const playhead = useTimelineStore.getState().playheadFlicks
            const next = spineEditPoints(sequence).find((point) => point > playhead)
            if (next !== undefined) seekSequence(sequence, snapshot, next)
          }}
        >
          ⏭
        </button>
        <button
          type="button"
          data-testid="sequence-go-end"
          title="Go to end (End)"
          disabled={empty}
          onClick={() => goToSequenceEnd(sequence)}
        >
          ⇥
        </button>
      </div>
    </section>
  )
}
