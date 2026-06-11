import { useRef, useState, type ReactNode } from 'react'
import { sequenceDuration } from '../../shared/timeline/model'
import { planExport, renderMixdownWav, replayFrames } from '../playback/offline'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'

type Preset = '1080p' | '720p' | 'source'

type Phase =
  | { kind: 'configure' }
  | { kind: 'running'; framesDone: number; frameCount: number }
  | { kind: 'done'; destination: string }
  | { kind: 'error'; message: string }

/** File → Export (Ctrl+E): preset, destination, progress, cancel. */
export function ExportDialog({ onClose }: { onClose(): void }): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const [preset, setPreset] = useState<Preset>('1080p')
  const [destination, setDestination] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'configure' })
  const cancelledRef = useRef(false)

  if (sequence === null || snapshot === null) return null
  const plan = planExport(sequence)
  const empty = sequenceDuration(sequence) === 0

  const browse = async (): Promise<void> => {
    const picked = await window.api.exportPickDestination()
    if (picked !== null) setDestination(picked)
  }

  const start = async (): Promise<void> => {
    if (destination.trim() === '' || empty) return
    cancelledRef.current = false
    useTimelineStore.getState().setViewerMode('sequence')
    setPhase({ kind: 'running', framesDone: 0, frameCount: plan.frameCount })
    try {
      const wav = await renderMixdownWav(sequence)
      await window.api.exportStart({
        destination: destination.trim(),
        width: 1920,
        height: 1080,
        fps: plan.fps,
        scaleTo: preset === '720p' ? { width: 1280, height: 720 } : null,
        wav
      })
      const completed = await replayFrames(
        sequence,
        snapshot,
        async (rgba, frameIndex) => {
          // copy into a standalone ArrayBuffer for a clean structured-clone payload
          const copy = new ArrayBuffer(rgba.byteLength)
          new Uint8Array(copy).set(rgba)
          await window.api.exportFrame(copy)
          setPhase({ kind: 'running', framesDone: frameIndex + 1, frameCount: plan.frameCount })
        },
        () => cancelledRef.current
      )
      if (!completed) {
        await window.api.exportCancel()
        onClose()
        return
      }
      await window.api.exportFinish()
      setPhase({ kind: 'done', destination: destination.trim() })
    } catch (error) {
      await window.api.exportCancel().catch(() => undefined)
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const cancel = (): void => {
    cancelledRef.current = true
  }

  return (
    <div className="export-overlay" data-testid="export-dialog">
      <div className="export-dialog">
        <div className="export-title">Export Movie</div>
        {phase.kind === 'configure' && (
          <>
            <label className="fx-field">
              <span>Preset</span>
              <select
                data-testid="export-preset"
                value={preset}
                onChange={(event) => setPreset(event.target.value as Preset)}
              >
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
                <option value="source">Source (sequence size)</option>
              </select>
            </label>
            <label className="fx-field">
              <span>Destination</span>
              <input
                type="text"
                data-testid="export-destination"
                placeholder="C:\\path\\to\\export.mp4"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </label>
            <button type="button" onClick={() => void browse()}>
              Browse…
            </button>
            <div className="export-estimate" data-testid="export-estimate">
              {plan.frameCount} frames · {plan.durationSec.toFixed(2)} s ·{' '}
              {(plan.fps.num / plan.fps.den).toFixed(2)} fps
            </div>
            <div className="export-actions">
              <button
                type="button"
                data-testid="export-start"
                disabled={destination.trim() === '' || empty}
                onClick={() => void start()}
              >
                Export
              </button>
              <button type="button" data-testid="export-close" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {phase.kind === 'running' && (
          <>
            <div data-testid="export-progress">
              {phase.framesDone} / {phase.frameCount} frames
            </div>
            <progress max={phase.frameCount} value={phase.framesDone} />
            <div className="export-actions">
              <button type="button" data-testid="export-cancel" onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        )}
        {phase.kind === 'done' && (
          <>
            <div data-testid="export-success">Exported to {phase.destination}</div>
            <div className="export-actions">
              <button type="button" data-testid="export-close" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {phase.kind === 'error' && (
          <>
            <div className="export-error" data-testid="export-error">
              Export failed: {phase.message}
            </div>
            <div className="export-actions">
              <button type="button" data-testid="export-close" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
