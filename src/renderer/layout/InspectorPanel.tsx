import { useState, type ReactNode } from 'react'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { ClipFx, TitleData } from '../../shared/timeline/model'
import { DEFAULT_FX } from '../../shared/timeline/ops'
import { useTimelineStore } from '../state/timeline-store'
import { Panel } from './Panel'

type Tab = 'video' | 'color' | 'audio' | 'title'

interface FieldDef {
  key: keyof ClipFx
  label: string
  step: number
}

const VIDEO_FIELDS: FieldDef[] = [
  { key: 'posX', label: 'Position X', step: 10 },
  { key: 'posY', label: 'Position Y', step: 10 },
  { key: 'scale', label: 'Scale %', step: 5 },
  { key: 'rotation', label: 'Rotation °', step: 1 },
  { key: 'opacity', label: 'Opacity %', step: 5 }
]

const COLOR_FIELDS: FieldDef[] = [
  { key: 'exposure', label: 'Exposure', step: 0.1 },
  { key: 'contrast', label: 'Contrast', step: 0.1 },
  { key: 'saturation', label: 'Saturation', step: 0.1 },
  { key: 'temperature', label: 'Temperature', step: 0.1 }
]

const AUDIO_FIELDS: FieldDef[] = [
  { key: 'volumeDb', label: 'Volume dB', step: 1 },
  { key: 'pan', label: 'Pan', step: 0.1 }
]

/** Inspector: Video / Color / Audio (+ Title for titles), bound to selection. */
export function InspectorPanel(): ReactNode {
  const selection = useTimelineStore((state) => state.selection)
  const sequence = useTimelineStore((state) => state.sequence)
  const [tab, setTab] = useState<Tab>('video')

  const selectedId = selection.clipIds.length === 1 ? selection.clipIds[0] : null
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

  if (clip === undefined || selectedId === null) {
    return (
      <Panel title="Inspector" testId="panel-inspector" className="panel-inspector">
        <span>Nothing selected</span>
      </Panel>
    )
  }

  const fx: ClipFx = { ...DEFAULT_FX, ...(clip.fx ?? {}) }
  const setFx = (patch: Partial<ClipFx>): void =>
    useTimelineStore.getState().setFx(selectedId, { ...fx, ...patch })

  const tabs: Tab[] =
    titleData === undefined ? ['video', 'color', 'audio'] : ['video', 'color', 'audio', 'title']
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
        {activeTab === 'video' && (
          <>
            <div className="inspector-section">Video — Transform</div>
            {VIDEO_FIELDS.map(numberField)}
          </>
        )}
        {activeTab === 'color' && (
          <>
            <div className="inspector-section">Color Board</div>
            {COLOR_FIELDS.map(numberField)}
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
          </>
        )}
        {activeTab === 'title' && titleData !== undefined && (
          <TitleFields clipId={selectedId} titleData={titleData} />
        )}
      </div>
    </Panel>
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
