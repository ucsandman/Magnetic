import type { ReactNode } from 'react'
import type { ClipFx } from '../../shared/timeline/model'
import { DEFAULT_FX } from '../../shared/timeline/ops'
import { useTimelineStore } from '../state/timeline-store'
import { Panel } from './Panel'

const FIELDS: { key: keyof ClipFx; label: string; step: number }[] = [
  { key: 'posX', label: 'Position X', step: 10 },
  { key: 'posY', label: 'Position Y', step: 10 },
  { key: 'scale', label: 'Scale %', step: 5 },
  { key: 'rotation', label: 'Rotation °', step: 1 },
  { key: 'opacity', label: 'Opacity %', step: 5 }
]

/** Video tab: transform scrubbers for the selected clip (kernel-undoable). */
export function InspectorPanel(): ReactNode {
  const selection = useTimelineStore((state) => state.selection)
  const sequence = useTimelineStore((state) => state.sequence)

  const selectedId = selection.clipIds.length === 1 ? selection.clipIds[0] : null
  const clip =
    selectedId === null || sequence === null
      ? null
      : ((sequence.spine.find((item) => item.id === selectedId && item.kind === 'clip') as
          | { fx?: ClipFx }
          | undefined) ??
        sequence.connected.find((cc) => cc.id === selectedId) ??
        null)

  if (clip === null || selectedId === null) {
    return (
      <Panel title="Inspector" testId="panel-inspector" className="panel-inspector">
        <span>Nothing selected</span>
      </Panel>
    )
  }

  const fx = clip.fx ?? DEFAULT_FX
  return (
    <Panel title="Inspector" testId="panel-inspector" className="panel-inspector">
      <div className="inspector-video">
        <div className="inspector-section">Video — Transform</div>
        {FIELDS.map(({ key, label, step }) => (
          <label key={key} className="fx-field">
            <span>{label}</span>
            <input
              type="number"
              step={step}
              data-testid={`fx-${key}`}
              value={fx[key]}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value)) return
                useTimelineStore.getState().setFx(selectedId, { ...fx, [key]: value })
              }}
            />
          </label>
        ))}
      </div>
    </Panel>
  )
}
