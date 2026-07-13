import { useRef, useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { sequenceDuration } from '../../shared/timeline/model'
import { smartRenderPlan, type SmartRenderPlan } from '../../shared/timeline/smart-render'
import { deriveSegments } from '../../shared/timeline/segments'
import {
  MIX_CHANNELS,
  MIX_SAMPLE_RATE,
  planExport,
  renderMixdownChunks,
  renderMixdownWav,
  replayFrames
} from '../playback/offline'
import { buildCues } from '../captions/cues'
import { toSrt, toVtt } from '../captions/format'
import { ensureTranscripts } from '../transcript/cache'
import { projectTranscript } from '../transcript/projection'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'

type Preset = '1080p' | '720p' | 'source'
type Mode = 'movie' | 'handoff'

type Phase =
  | { kind: 'configure' }
  | { kind: 'running'; framesDone: number; frameCount: number }
  | { kind: 'smart'; stage: 'audio' | 'video'; fraction: number }
  | { kind: 'handoff-write' }
  | { kind: 'done'; destination: string; segments?: number }
  | { kind: 'error'; message: string }

/** File → Export (Ctrl+E): preset, destination, progress, cancel. */
export function ExportDialog({ onClose }: { onClose(): void }): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const [mode, setMode] = useState<Mode>('movie')
  const [preset, setPreset] = useState<Preset>('1080p')
  const [destination, setDestination] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'configure' })
  const cancelledRef = useRef(false)
  const smartActiveRef = useRef(false)

  if (sequence === null || snapshot === null) return null
  const plan = planExport(sequence)
  const empty = sequenceDuration(sequence) === 0
  // Stream copy cannot scale, so an explicit 720p preset takes the WYSIWYG path.
  const smartPlan = preset === '720p' ? null : smartRenderPlan(sequence)
  // clip: markers → segments; the handoff option needs at least one (shared kernel fn).
  const segments = deriveSegments(sequence)
  const handoffAvailable = segments.length > 0

  const browse = async (): Promise<void> => {
    if (mode === 'handoff') {
      const dir = await window.api.marketingHandoffPickDir()
      if (dir !== null) setDestination(dir)
      return
    }
    const picked = await window.api.exportPickDestination()
    if (picked !== null) setDestination(picked)
  }

  /**
   * Smart render: stream-copy the single trimmed H.264 asset, render only the
   * mixed audio (in chunks). Progress = audio-mix fraction, then ffmpeg's
   * out_time pushes for the copy phase.
   */
  const startSmart = async (
    smart: SmartRenderPlan,
    dest: string,
    afterMovie?: () => Promise<void>
  ): Promise<void> => {
    const durSec = smart.durationFlicks / FLICKS_PER_SECOND
    smartActiveRef.current = true
    setPhase({ kind: 'smart', stage: 'audio', fraction: 0 })
    const unsubscribe = window.api.onSmartExportProgress(({ outTimeSec }) => {
      setPhase({ kind: 'smart', stage: 'video', fraction: Math.min(1, outTimeSec / durSec) })
    })
    try {
      await window.api.smartExportStart({
        destination: dest,
        assetId: smart.assetId,
        inSec: smart.mediaInFlicks / FLICKS_PER_SECOND,
        durSec,
        sampleRate: MIX_SAMPLE_RATE,
        channels: MIX_CHANNELS
      })
      const completed = await renderMixdownChunks(
        sequence,
        (pcm) => window.api.smartExportAudioChunk(pcm),
        ({ renderedSec, totalSec }) =>
          setPhase({ kind: 'smart', stage: 'audio', fraction: renderedSec / totalSec }),
        () => cancelledRef.current
      )
      if (!completed) {
        await window.api.smartExportCancel()
        onClose()
        return
      }
      setPhase({ kind: 'smart', stage: 'video', fraction: 0 })
      await window.api.smartExportMux()
      if (afterMovie !== undefined) await afterMovie()
      else setPhase({ kind: 'done', destination: dest })
    } catch (error) {
      await window.api.smartExportCancel().catch(() => undefined)
      if (cancelledRef.current) {
        onClose()
        return
      }
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      smartActiveRef.current = false
      unsubscribe()
    }
  }

  /**
   * Render the movie to `dest` via the existing export path (smart-render copy
   * or WYSIWYG frame pipe). On success runs `afterMovie` (the handoff's sidecar
   * stage) if given, otherwise lands on the plain done state.
   */
  const runMovie = async (dest: string, afterMovie?: () => Promise<void>): Promise<void> => {
    cancelledRef.current = false
    if (smartPlan !== null) {
      await startSmart(smartPlan, dest, afterMovie)
      return
    }
    useTimelineStore.getState().setViewerMode('sequence')
    setPhase({ kind: 'running', framesDone: 0, frameCount: plan.frameCount })
    try {
      const wav = await renderMixdownWav(sequence)
      await window.api.exportStart({
        destination: dest,
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
      if (afterMovie !== undefined) await afterMovie()
      else setPhase({ kind: 'done', destination: dest })
    } catch (error) {
      await window.api.exportCancel().catch(() => undefined)
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const start = async (): Promise<void> => {
    if (destination.trim() === '' || empty) return
    await runMovie(destination.trim())
  }

  /**
   * One-click marketing handoff: render <destDir>/video.mp4 via the normal
   * export path, then serialize the caption cues and hand the sidecars +
   * segments.json to the main-process writer.
   */
  const startHandoff = async (): Promise<void> => {
    const dir = destination.trim()
    if (dir === '' || empty || !handoffAvailable) return
    const sep = dir.includes('\\') ? '\\' : '/'
    const videoPath = `${dir}${sep}video.mp4`
    await runMovie(videoPath, async () => {
      setPhase({ kind: 'handoff-write' })
      const transcripts = await ensureTranscripts(sequence, snapshot)
      const cues = buildCues(projectTranscript(sequence, transcripts))
      const result = await window.api.marketingHandoffWrite({
        destDir: dir,
        fps: plan.fps,
        segments,
        srt: toSrt(cues),
        vtt: toVtt(cues)
      })
      setPhase({ kind: 'done', destination: dir, segments: result.segments })
    })
  }

  const cancel = (): void => {
    cancelledRef.current = true
    // the smart copy phase sits inside one ffmpeg run — kill it actively
    if (smartActiveRef.current) void window.api.smartExportCancel().catch(() => undefined)
  }

  return (
    <div className="export-overlay" data-testid="export-dialog">
      <div className="export-dialog">
        <div className="export-title">
          {mode === 'handoff' ? 'Marketing Handoff' : 'Export Movie'}
        </div>
        {phase.kind === 'configure' && (
          <>
            <div className="export-actions" data-testid="export-mode">
              <button
                type="button"
                className={mode === 'movie' ? 'active' : ''}
                data-testid="export-mode-movie"
                onClick={() => setMode('movie')}
              >
                Movie
              </button>
              <button
                type="button"
                className={mode === 'handoff' ? 'active' : ''}
                data-testid="export-mode-handoff"
                disabled={!handoffAvailable}
                title={handoffAvailable ? undefined : 'Add clip: markers to define segments'}
                onClick={() => setMode('handoff')}
              >
                Marketing Handoff
              </button>
            </div>
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
              <span>{mode === 'handoff' ? 'Folder' : 'Destination'}</span>
              <input
                type="text"
                data-testid="export-destination"
                placeholder={
                  mode === 'handoff' ? 'C:\\path\\to\\handoff-folder' : 'C:\\path\\to\\export.mp4'
                }
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </label>
            <button type="button" onClick={() => void browse()}>
              {mode === 'handoff' ? 'Choose Folder…' : 'Browse…'}
            </button>
            <div className="export-estimate" data-testid="export-estimate">
              {plan.frameCount} frames · {plan.durationSec.toFixed(2)} s ·{' '}
              {(plan.fps.num / plan.fps.den).toFixed(2)} fps
            </div>
            {smartPlan !== null && (
              <div className="export-estimate" data-testid="smart-render-note">
                Smart render — video passthrough (no re-encode)
              </div>
            )}
            {mode === 'handoff' && (
              <div className="export-estimate" data-testid="handoff-segments-note">
                {segments.length} segment{segments.length === 1 ? '' : 's'} → video.mp4 +
                captions.srt/vtt + segments.json
              </div>
            )}
            <div className="export-actions">
              {mode === 'handoff' ? (
                <button
                  type="button"
                  className="primary"
                  data-testid="handoff-start"
                  disabled={destination.trim() === '' || empty || !handoffAvailable}
                  onClick={() => void startHandoff()}
                >
                  Export Handoff
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  data-testid="export-start"
                  disabled={destination.trim() === '' || empty}
                  onClick={() => void start()}
                >
                  Export
                </button>
              )}
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
        {phase.kind === 'smart' && (
          <>
            <div data-testid="export-progress">
              {phase.stage === 'audio' ? 'Mixing audio' : 'Copying video'} —{' '}
              {Math.round(phase.fraction * 100)}%
            </div>
            <progress max={1} value={phase.fraction} />
            <div className="export-actions">
              <button type="button" data-testid="export-cancel" onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        )}
        {phase.kind === 'handoff-write' && (
          <div data-testid="export-progress">Writing captions &amp; segments…</div>
        )}
        {phase.kind === 'done' && (
          <>
            <div data-testid="export-success">
              {phase.segments === undefined
                ? `Exported to ${phase.destination}`
                : `Handoff exported — ${phase.segments} segment${
                    phase.segments === 1 ? '' : 's'
                  } to ${phase.destination}`}
            </div>
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
