import { useEffect, useRef, useState, type ReactNode } from 'react'
import { playbackEngine } from '../playback/engine'
import { useTimelineStore } from '../state/timeline-store'
import { METER_FLOOR_DB, rmsToMeter } from './meter-scale'

/** Full-scale release time — instant attack, ~300 ms fall. */
const RELEASE_SEC = 0.3

/**
 * Mono RMS meter in the sequence transport, driven from the engine's
 * analyser while the sequence plays; idle renders the floor.
 */
export function AudioMeter(): ReactNode {
  const [fraction, setFraction] = useState(0)
  const [zone, setZone] = useState<'green' | 'yellow' | 'red'>('green')
  const shownRef = useRef(0)

  // Permanent rAF (same pattern as the viewer timecode loop): instant
  // attack, RELEASE_SEC fall, floor while the sequence is not playing.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = (now - last) / 1000
      last = now
      const playing = useTimelineStore.getState().isSequencePlaying
      const target = rmsToMeter(playing ? playbackEngine.audioRms() : 0)
      shownRef.current =
        target.fraction >= shownRef.current
          ? target.fraction
          : Math.max(target.fraction, shownRef.current - dt / RELEASE_SEC)
      setFraction(shownRef.current)
      setZone(target.zone)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const db = Math.round(METER_FLOOR_DB + fraction * -METER_FLOOR_DB)
  return (
    <span
      className="audio-meter"
      data-testid="sequence-meter"
      role="meter"
      title="Audio level (dBFS)"
      aria-label="Audio level"
      aria-valuemin={METER_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={db}
    >
      <span
        className={`audio-meter-fill audio-meter-${zone}`}
        style={{ width: `${fraction * 100}%` }}
      />
    </span>
  )
}
