import { sequenceDuration, type Sequence } from '../../shared/timeline/model'
import type { LibrarySnapshot } from '../../shared/types'
import { useTimelineStore } from '../state/timeline-store'
import { playbackEngine } from './engine'

/**
 * Sequence transport shared by the Space/JKL shortcuts (TimelinePanel) and
 * the viewer transport buttons (SequencePlayer) — one code path for both.
 */

/**
 * Pause when playing, else play from the playhead (wrapping to 0 at the end).
 * Returns false when there is nothing to play (empty sequence) so callers can
 * offer a fallback (e.g. play the browser selection instead).
 */
export function toggleSequencePlayback(
  sequence: Sequence | null,
  snapshot: LibrarySnapshot | null
): boolean {
  if (playbackEngine.isPlaying) {
    playbackEngine.pause()
    return true
  }
  if (sequence === null || snapshot === null || sequenceDuration(sequence) === 0) return false
  const store = useTimelineStore.getState()
  store.setViewerMode('sequence')
  const total = sequenceDuration(sequence)
  const from = store.playheadFlicks >= total ? 0 : store.playheadFlicks
  void playbackEngine.play(sequence, snapshot, from)
  return true
}

/** Move the sequence playhead; playback (if any) continues from the new position. */
export function seekSequence(
  sequence: Sequence | null,
  snapshot: LibrarySnapshot | null,
  flicks: number
): void {
  const target = Math.max(0, flicks)
  const wasPlaying = playbackEngine.isPlaying
  if (wasPlaying) playbackEngine.pause()
  useTimelineStore.getState().setPlayhead(target)
  if (wasPlaying && sequence !== null && snapshot !== null && target < sequenceDuration(sequence)) {
    void playbackEngine.play(sequence, snapshot, target)
  }
}

/** Pause and park the playhead at the end of the sequence. */
export function goToSequenceEnd(sequence: Sequence | null): void {
  if (sequence === null) return
  playbackEngine.pause()
  useTimelineStore.getState().setPlayhead(sequenceDuration(sequence))
}
