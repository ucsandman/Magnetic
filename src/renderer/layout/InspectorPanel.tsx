import { useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND, flicksPerFrame } from '../../shared/timecode'
import {
  effectiveRole,
  visibleMarkers,
  type AnimatableParam,
  type CaptionSettings,
  type ClipFx,
  type ClipRole,
  type MarkerColor,
  type Sequence,
  type TitleData
} from '../../shared/timeline/model'
import { DEFAULT_CAPTIONS, DEFAULT_FX, removeMarker, updateMarker } from '../../shared/timeline/ops'
import { adjacentKeyframeTime, evaluateFxAt, upsertKeyframe } from '../../shared/timeline/fx-eval'
import { buildCues } from '../captions/cues'
import { ensureEnvelopes } from '../copilot/envelopes'
import { DUCK_AMOUNT_DB, planDucking } from '../silence/ducking'
import { toSrt, toVtt } from '../captions/format'
import { ensureTranscripts } from '../transcript/cache'
import { projectTranscript } from '../transcript/projection'
import { useLibrary } from '../state/LibraryContext'
import { clipMediaTimeAt, clipSequenceTimeOfMedia, useTimelineStore } from '../state/timeline-store'
import { Panel } from './Panel'

type Tab = 'video' | 'color' | 'audio' | 'title' | 'captions'

interface FieldDef {
  key: 'volumeDb' | 'pan'
  label: string
  step: number
}

/** Video/color rows are keyframable: same shape, key narrowed to the 9 scalars. */
interface KfFieldDef {
  key: AnimatableParam
  label: string
  step: number
}

const VIDEO_FIELDS: KfFieldDef[] = [
  { key: 'posX', label: 'Position X', step: 10 },
  { key: 'posY', label: 'Position Y', step: 10 },
  { key: 'scale', label: 'Scale %', step: 5 },
  { key: 'rotation', label: 'Rotation °', step: 1 },
  { key: 'opacity', label: 'Opacity %', step: 5 }
]

const COLOR_FIELDS: KfFieldDef[] = [
  { key: 'exposure', label: 'Exposure', step: 0.1 },
  { key: 'contrast', label: 'Contrast', step: 0.1 },
  { key: 'saturation', label: 'Saturation', step: 0.1 },
  { key: 'temperature', label: 'Temperature', step: 0.1 }
]

const AUDIO_FIELDS: FieldDef[] = [
  { key: 'volumeDb', label: 'Volume dB', step: 1 },
  { key: 'pan', label: 'Pan', step: 0.1 }
]

const ROLE_VALUES: ClipRole[] = ['dialogue', 'music', 'sfx']
const ROLE_LABELS: Record<ClipRole, string> = {
  dialogue: 'Dialogue',
  music: 'Music',
  sfx: 'SFX'
}

/** "2 min ago" style stamp for the session-only AI attribution line. */
function relativeTime(atMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

/** Inspector: Video / Color / Audio (+ Title for titles), bound to selection. */
export function InspectorPanel(): ReactNode {
  const selection = useTimelineStore((state) => state.selection)
  const sequence = useTimelineStore((state) => state.sequence)
  const playheadFlicks = useTimelineStore((state) => state.playheadFlicks)
  const attributions = useTimelineStore((state) => state.attributions)
  const [tab, setTab] = useState<Tab>('video')

  const selectedId = selection.clipIds.length === 1 ? selection.clipIds[0] : null
  const attribution = selectedId === null ? undefined : attributions.get(selectedId)
  const spineClip =
    selectedId === null || sequence === null
      ? undefined
      : sequence.spine.find((item) => item.id === selectedId && item.kind === 'clip')
  const connectedClip =
    selectedId === null || sequence === null
      ? undefined
      : sequence.connected.find((cc) => cc.id === selectedId)
  const clip = (spineClip ?? connectedClip) as { fx?: ClipFx } | undefined
  const titleData = connectedClip?.titleData

  if (clip === undefined || selectedId === null || sequence === null) {
    // no clip selected: sequence-level settings (Captions) are still editable
    return (
      <Panel
        title="Inspector"
        testId="panel-inspector"
        className="panel-inspector"
        toolbar={
          <span className="inspector-tabs">
            <button type="button" className="active" data-testid="inspector-tab-captions">
              Captions
            </button>
          </span>
        }
      >
        <div className="inspector-video">
          {sequence === null ? (
            <span>Nothing selected</span>
          ) : (
            <>
              <MarkerFields sequence={sequence} />
              <CaptionFields sequence={sequence} />
            </>
          )}
        </div>
      </Panel>
    )
  }

  const fx: ClipFx = { ...DEFAULT_FX, ...(clip.fx ?? {}) }
  const setFx = (patch: Partial<ClipFx>): void =>
    useTimelineStore.getState().setFx(selectedId, { ...fx, ...patch })

  // keyframes are anchored in MEDIA time: playhead → clip media time (clamped)
  const mediaNow = clipMediaTimeAt(sequence, selectedId, playheadFlicks)
  const evaluated = mediaNow === null ? fx : evaluateFxAt(clip.fx, mediaNow)

  const writeKeyframeAtPlayhead = (key: AnimatableParam, value: number): void => {
    if (mediaNow === null) return
    const track = upsertKeyframe(fx.kf?.[key], {
      atMediaFlicks: mediaNow,
      value,
      ease: 'easeInOut'
    })
    setFx({ kf: { ...(fx.kf ?? {}), [key]: track } })
  }

  /** Toggle on: seed a keyframe at the playhead. Off: freeze the evaluated value. */
  const toggleKeyframes = (key: AnimatableParam): void => {
    const track = fx.kf?.[key]
    if (track === undefined || track.length === 0) {
      writeKeyframeAtPlayhead(key, fx[key])
      return
    }
    const kf = { ...fx.kf }
    delete kf[key]
    setFx({ [key]: evaluated[key], kf: Object.keys(kf).length > 0 ? kf : undefined })
  }

  const jumpToKeyframe = (key: AnimatableParam, direction: -1 | 1): void => {
    const track = fx.kf?.[key]
    if (track === undefined || track.length === 0 || mediaNow === null) return
    const at = adjacentKeyframeTime(track, mediaNow, direction)
    if (at === null) return
    const timeFlicks = clipSequenceTimeOfMedia(sequence, selectedId, at)
    if (timeFlicks !== null) useTimelineStore.getState().setPlayhead(timeFlicks)
  }

  const tabs: Tab[] =
    titleData === undefined
      ? ['video', 'color', 'audio', 'captions']
      : ['video', 'color', 'audio', 'title', 'captions']
  const activeTab = tabs.includes(tab) ? tab : 'video'

  const numberField = ({ key, label, step }: FieldDef): ReactNode => (
    <label key={key} className="fx-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        data-testid={`fx-${key}`}
        value={fx[key]}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) setFx({ [key]: value })
        }}
      />
    </label>
  )

  /** Keyframable row: diamond toggle + prev/next nav; edits write at the playhead. */
  const keyframeField = ({ key, label, step }: KfFieldDef): ReactNode => {
    const track = fx.kf?.[key]
    const keyframed = track !== undefined && track.length > 0
    const shown = keyframed ? Math.round(evaluated[key] * 1000) / 1000 : fx[key]
    return (
      <label key={key} className="fx-field">
        <span>{label}</span>
        <span className="kf-controls">
          <button
            type="button"
            title="Previous keyframe"
            data-testid={`kf-prev-${key}`}
            disabled={!keyframed}
            onClick={() => jumpToKeyframe(key, -1)}
          >
            ◀
          </button>
          <button
            type="button"
            title={
              keyframed
                ? 'Remove keyframes (freeze the current value)'
                : 'Add a keyframe at the playhead'
            }
            data-testid={`kf-toggle-${key}`}
            className={keyframed ? 'active' : ''}
            onClick={() => toggleKeyframes(key)}
          >
            {keyframed ? '◆' : '◇'}
          </button>
          <button
            type="button"
            title="Next keyframe"
            data-testid={`kf-next-${key}`}
            disabled={!keyframed}
            onClick={() => jumpToKeyframe(key, 1)}
          >
            ▶
          </button>
        </span>
        <input
          type="number"
          step={step}
          data-testid={`fx-${key}`}
          value={shown}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (!Number.isFinite(value)) return
            if (keyframed) writeKeyframeAtPlayhead(key, value)
            else setFx({ [key]: value })
          }}
        />
      </label>
    )
  }

  return (
    <Panel
      title="Inspector"
      testId="panel-inspector"
      className="panel-inspector"
      toolbar={
        <span className="inspector-tabs">
          {tabs.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={candidate === activeTab ? 'active' : ''}
              data-testid={`inspector-tab-${candidate}`}
              onClick={() => setTab(candidate)}
            >
              {candidate[0].toUpperCase() + candidate.slice(1)}
            </button>
          ))}
        </span>
      }
    >
      <div className="inspector-video">
        <MarkerFields sequence={sequence} />
        {attribution !== undefined && (
          <div className="inspector-attribution" data-testid="inspector-attribution">
            <span className="roughcut-ai-badge">AI</span> Edited by {attribution.actor} ·{' '}
            {relativeTime(attribution.atMs)}
          </div>
        )}
        {activeTab === 'video' && (
          <>
            <div className="inspector-section">Video — Transform</div>
            {VIDEO_FIELDS.map(keyframeField)}
          </>
        )}
        {activeTab === 'color' && (
          <>
            <div className="inspector-section">Color Board</div>
            {COLOR_FIELDS.map(keyframeField)}
            <button
              type="button"
              data-testid="color-reset"
              onClick={() => setFx({ exposure: 0, contrast: 1, saturation: 1, temperature: 0 })}
            >
              Reset
            </button>
          </>
        )}
        {activeTab === 'audio' && (
          <>
            <div className="inspector-section">Audio</div>
            {titleData === undefined && (
              <label className="fx-field">
                <span>Role</span>
                <span className="role-picker">
                  {ROLE_VALUES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      data-testid={`role-${role}`}
                      className={
                        effectiveRole((spineClip ?? connectedClip)!) === role ? 'active' : ''
                      }
                      onClick={() => useTimelineStore.getState().setRole(selectedId, role)}
                    >
                      {ROLE_LABELS[role]}
                    </button>
                  ))}
                </span>
              </label>
            )}
            {AUDIO_FIELDS.map(numberField)}
            <label className="fx-field">
              <span>Fade In s</span>
              <input
                type="number"
                step={0.1}
                data-testid="fx-fadeIn"
                value={fx.fadeInFlicks / FLICKS_PER_SECOND}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 0) {
                    setFx({ fadeInFlicks: value * FLICKS_PER_SECOND })
                  }
                }}
              />
            </label>
            <label className="fx-field">
              <span>Fade Out s</span>
              <input
                type="number"
                step={0.1}
                data-testid="fx-fadeOut"
                value={fx.fadeOutFlicks / FLICKS_PER_SECOND}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value >= 0) {
                    setFx({ fadeOutFlicks: value * FLICKS_PER_SECOND })
                  }
                }}
              />
            </label>
            {titleData === undefined && (
              <button
                type="button"
                data-testid="normalize-loudness"
                title="Measure this clip's source loudness and set Volume dB so it plays at the streaming standard (−14 LUFS)"
                onClick={() => void useTimelineStore.getState().normalizeLoudness([selectedId])}
              >
                Normalize to −14 LUFS
              </button>
            )}
            {connectedClip !== undefined &&
              titleData === undefined &&
              effectiveRole(connectedClip) === 'music' && (
                <DuckControls clipId={selectedId} sequence={sequence} fx={fx} />
              )}
          </>
        )}
        {activeTab === 'title' && titleData !== undefined && (
          <TitleFields clipId={selectedId} titleData={titleData} />
        )}
        {activeTab === 'captions' && <CaptionFields sequence={sequence} />}
      </div>
    </Panel>
  )
}

/** Auto-duck buttons for a selected music-role bed. */
function DuckControls({
  clipId,
  sequence,
  fx
}: {
  clipId: string
  sequence: Sequence
  fx: ClipFx
}): ReactNode {
  const { snapshot } = useLibrary()
  const ducked = fx.duck !== undefined && fx.duck.ranges.length > 0
  return (
    <>
      <button
        type="button"
        data-testid="duck-music"
        title="Find where dialogue is speaking and dip this bed −12 dB under it"
        onClick={() => {
          if (snapshot === null) return
          void ensureEnvelopes(sequence, snapshot).then((envelopes) => {
            const plans = planDucking(sequence, envelopes).filter((plan) => plan.clipId === clipId)
            useTimelineStore.getState().applyDuckPlans(plans, DUCK_AMOUNT_DB)
          })
        }}
      >
        Duck under dialogue (−12 dB)
      </button>
      {ducked && (
        <button
          type="button"
          data-testid="duck-clear"
          onClick={() => {
            const cleared = { ...fx }
            delete cleared.duck
            useTimelineStore.getState().setFx(clipId, cleared)
          }}
        >
          Clear ducking ({fx.duck!.ranges.length} dip{fx.duck!.ranges.length === 1 ? '' : 's'})
        </button>
      )}
    </>
  )
}

const MARKER_COLORS: MarkerColor[] = ['blue', 'green', 'orange', 'red']

/**
 * Editor for the marker under the playhead (within half a frame). Clicking a
 * ruler diamond seeks to it, which brings this editor up — no context menus.
 */
function MarkerFields({ sequence }: { sequence: Sequence }): ReactNode {
  const playheadFlicks = useTimelineStore((state) => state.playheadFlicks)
  const half = flicksPerFrame(sequence.fps) / 2
  const atPlayhead = visibleMarkers(sequence).find(
    (entry) => Math.abs(entry.seqFlicks - playheadFlicks) <= half
  )
  if (atPlayhead === undefined) return null
  const marker = atPlayhead.marker
  const applyOp = useTimelineStore.getState().applyOp
  return (
    <div className="inspector-marker" data-testid="inspector-marker">
      <div className="inspector-section">Marker</div>
      <label className="fx-field">
        <span>Note</span>
        <input
          type="text"
          data-testid="marker-text"
          value={marker.text}
          placeholder="What needs attention here?"
          onChange={(event) =>
            applyOp((seq) => updateMarker(seq, { markerId: marker.id, text: event.target.value }))
          }
        />
      </label>
      <label className="fx-field">
        <span>Color</span>
        <span className="marker-colors">
          {MARKER_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              data-testid={`marker-color-${color}`}
              className={`marker-swatch marker-${color}${marker.color === color ? ' active' : ''}`}
              title={color}
              onClick={() => applyOp((seq) => updateMarker(seq, { markerId: marker.id, color }))}
            />
          ))}
        </span>
      </label>
      <button
        type="button"
        data-testid="marker-delete"
        onClick={() => applyOp((seq) => removeMarker(seq, { markerId: marker.id }))}
      >
        Delete Marker
      </button>
    </div>
  )
}

function TitleFields({ clipId, titleData }: { clipId: string; titleData: TitleData }): ReactNode {
  const update = (patch: Partial<TitleData>): void =>
    useTimelineStore.getState().setTitle(clipId, { ...titleData, ...patch })
  return (
    <>
      <div className="inspector-section">Title</div>
      <label className="fx-field">
        <span>Text</span>
        <input
          type="text"
          data-testid="title-text"
          value={titleData.text}
          onChange={(event) => update({ text: event.target.value })}
        />
      </label>
      <label className="fx-field">
        <span>Size px</span>
        <input
          type="number"
          step={4}
          data-testid="title-size"
          value={titleData.sizePx}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value) && value > 0) update({ sizePx: value })
          }}
        />
      </label>
      <label className="fx-field">
        <span>Color</span>
        <input
          type="text"
          data-testid="title-color"
          value={titleData.color}
          onChange={(event) => update({ color: event.target.value })}
        />
      </label>
      <label className="fx-field">
        <span>X</span>
        <input
          type="number"
          step={10}
          data-testid="title-x"
          value={titleData.x}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) update({ x: value })
          }}
        />
      </label>
      <label className="fx-field">
        <span>Y</span>
        <input
          type="number"
          step={10}
          data-testid="title-y"
          value={titleData.y}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) update({ y: value })
          }}
        />
      </label>
    </>
  )
}

/** Sequence-level burned-in captions: toggle, style, and sidecar export. */
function CaptionFields({ sequence }: { sequence: Sequence }): ReactNode {
  const { snapshot } = useLibrary()
  const [destination, setDestination] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const captions = sequence.captions ?? DEFAULT_CAPTIONS
  const update = (patch: Partial<CaptionSettings>): void =>
    useTimelineStore.getState().setCaptions({ ...captions, ...patch })

  const exportSidecar = async (format: 'srt' | 'vtt'): Promise<void> => {
    if (snapshot === null) return
    try {
      let dest = destination.trim()
      if (dest === '') {
        const picked = await window.api.captionsPickDestination(format)
        if (picked === null) return
        dest = picked
        setDestination(picked)
      }
      const transcripts = await ensureTranscripts(sequence, snapshot)
      const cues = buildCues(projectTranscript(sequence, transcripts))
      if (cues.length === 0) {
        setNote(
          transcripts.size === 0
            ? 'No transcripts available — transcribe the clips first (Browser > Transcript).'
            : 'No caption cues to export — the transcripts have no words inside the sequence.'
        )
        return
      }
      await window.api.captionsWriteSidecar(dest, format === 'srt' ? toSrt(cues) : toVtt(cues))
      setNote(`Saved ${cues.length} cues to ${dest}`)
    } catch (error) {
      setNote(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <>
      <div className="inspector-section">Captions</div>
      <label className="fx-field">
        <span>Enabled</span>
        <input
          type="checkbox"
          data-testid="captions-enabled"
          checked={captions.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
      </label>
      <label className="fx-field">
        <span>Style</span>
        <select
          data-testid="captions-preset"
          value={captions.preset}
          onChange={(event) => update({ preset: event.target.value as CaptionSettings['preset'] })}
        >
          <option value="pop-in">Pop-in</option>
          <option value="karaoke">Karaoke</option>
          <option value="block">Block</option>
        </select>
      </label>
      <label className="fx-field">
        <span>Position</span>
        <select
          data-testid="captions-position"
          value={captions.position}
          onChange={(event) =>
            update({ position: event.target.value as CaptionSettings['position'] })
          }
        >
          <option value="bottom">Bottom</option>
          <option value="middle">Middle</option>
          <option value="top">Top</option>
        </select>
      </label>
      <label className="fx-field">
        <span>Size px</span>
        <input
          type="number"
          step={4}
          data-testid="captions-size"
          value={captions.sizePx}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value) && value > 0) update({ sizePx: value })
          }}
        />
      </label>
      <label className="fx-field">
        <span>Font</span>
        <input
          type="text"
          data-testid="captions-font"
          value={captions.font}
          onChange={(event) => update({ font: event.target.value })}
        />
      </label>
      <label className="fx-field">
        <span>Color</span>
        <input
          type="text"
          data-testid="captions-color"
          value={captions.color}
          onChange={(event) => update({ color: event.target.value })}
        />
      </label>
      <label className="fx-field">
        <span>Highlight</span>
        <input
          type="text"
          data-testid="captions-highlight"
          value={captions.highlightColor}
          onChange={(event) => update({ highlightColor: event.target.value })}
        />
      </label>
      <div className="inspector-section">Sidecar export</div>
      <label className="fx-field">
        <span>Save to</span>
        <input
          type="text"
          data-testid="captions-destination"
          placeholder="Ask where to save"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
        />
      </label>
      <div className="export-actions">
        <button
          type="button"
          data-testid="captions-export-srt"
          onClick={() => void exportSidecar('srt')}
        >
          Export SRT…
        </button>
        <button
          type="button"
          data-testid="captions-export-vtt"
          onClick={() => void exportSidecar('vtt')}
        >
          Export VTT…
        </button>
      </div>
      {note !== null && (
        <div className="export-estimate" data-testid="captions-export-note">
          {note}
        </div>
      )}
    </>
  )
}
