import { useCallback, useEffect, type ReactNode } from 'react'
import { flicksToTimecode } from '../../shared/timecode'
import { sequenceDuration } from '../../shared/timeline/model'
import { registerShortcut } from '../shortcuts'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore, type SourceClip } from '../state/timeline-store'
import { TimelineCanvas } from '../timeline/TimelineCanvas'

export function TimelinePanel(): ReactNode {
  const { snapshot, selectedIds, markedRange } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const playheadFlicks = useTimelineStore((state) => state.playheadFlicks)
  const snapping = useTimelineStore((state) => state.snapping)
  const skimming = useTimelineStore((state) => state.skimming)
  const zoomPxPerSec = useTimelineStore((state) => state.zoomPxPerSec)
  const load = useTimelineStore((state) => state.load)

  useEffect(() => {
    void load()
  }, [load])

  /** Source for E/W/Q/D: first browser-selected asset + viewer I/O range when it matches. */
  const buildSource = useCallback((): SourceClip | null => {
    const assetId = selectedIds[0]
    if (assetId === undefined || snapshot === null) return null
    const asset = snapshot.assets[assetId]
    if (asset === undefined) return null
    let mediaIn = 0
    let mediaOut = asset.durationFlicks
    if (markedRange !== null && markedRange.assetId === assetId) {
      mediaIn = markedRange.inFlicks ?? 0
      mediaOut = markedRange.outFlicks ?? asset.durationFlicks
    }
    if (mediaOut <= mediaIn) {
      mediaIn = 0
      mediaOut = asset.durationFlicks
    }
    return {
      assetId,
      mediaInFlicks: mediaIn,
      durationFlicks: mediaOut - mediaIn,
      sourceDurationFlicks: asset.durationFlicks,
      fps: asset.video?.fps ?? null
    }
  }, [selectedIds, snapshot, markedRange])

  useEffect(() => {
    const store = useTimelineStore.getState
    const withSource = (edit: (src: SourceClip) => void) => (): void => {
      const source = buildSource()
      if (source !== null) edit(source)
    }
    const unsubscribers = [
      registerShortcut('timeline-append', {
        combo: 'e',
        description: 'Append browser selection to the spine',
        handler: withSource((src) => store().appendSource(src))
      }),
      registerShortcut('timeline-insert', {
        combo: 'w',
        description: 'Insert browser selection at the playhead',
        handler: withSource((src) => store().insertSourceAtPlayhead(src))
      }),
      registerShortcut('timeline-connect', {
        combo: 'q',
        description: 'Connect browser selection at the playhead',
        handler: withSource((src) => store().connectSourceAtPlayhead(src))
      }),
      registerShortcut('timeline-overwrite', {
        combo: 'd',
        description: 'Overwrite at the playhead with browser selection',
        handler: withSource((src) => store().overwriteSourceAtPlayhead(src))
      }),
      registerShortcut('timeline-ripple-delete', {
        combo: 'delete',
        description: 'Ripple delete the selected clips',
        handler: () => store().deleteSelection('ripple')
      }),
      registerShortcut('timeline-lift-delete', {
        combo: 'shift+delete',
        description: 'Lift the selected clips, leaving a gap',
        handler: () => store().deleteSelection('lift')
      }),
      registerShortcut('timeline-snapping', {
        combo: 'n',
        description: 'Toggle snapping',
        handler: () => store().toggleSnapping()
      }),
      registerShortcut('timeline-skimming', {
        combo: 's',
        description: 'Toggle skimming',
        handler: () => store().toggleSkimming()
      }),
      registerShortcut('timeline-zoom-in', {
        combo: '=',
        description: 'Zoom the timeline in',
        handler: () => store().zoomBy(1.25)
      }),
      registerShortcut('timeline-zoom-out', {
        combo: '-',
        description: 'Zoom the timeline out',
        handler: () => store().zoomBy(0.8)
      }),
      registerShortcut('timeline-home', {
        combo: 'home',
        description: 'Move the playhead to the start',
        handler: () => store().setPlayhead(0)
      }),
      registerShortcut('timeline-end', {
        combo: 'end',
        description: 'Move the playhead to the end',
        handler: () => {
          const seq = store().sequence
          if (seq !== null) store().setPlayhead(sequenceDuration(seq))
        }
      }),
      registerShortcut('timeline-undo', {
        combo: 'ctrl+z',
        description: 'Undo',
        handler: () => store().undo()
      }),
      registerShortcut('timeline-redo', {
        combo: 'ctrl+shift+z',
        description: 'Redo',
        handler: () => store().redo()
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [buildSource])

  const fps = sequence?.fps ?? { num: 30, den: 1 }
  return (
    <section className="panel panel-timeline" data-testid="panel-timeline">
      <header className="panel-header">Timeline</header>
      <div className="panel-toolbar timeline-toolbar">
        <span className="timeline-tc" data-testid="timeline-playhead-tc">
          {flicksToTimecode(playheadFlicks, fps)}
        </span>
        <span className="spacer" />
        <span data-testid="timeline-zoom" className="timeline-indicator">
          {Math.round(zoomPxPerSec)} px/s
        </span>
        <button
          type="button"
          className={snapping ? 'active' : ''}
          data-testid="timeline-snapping"
          title="Toggle snapping (N)"
          onClick={() => useTimelineStore.getState().toggleSnapping()}
        >
          Snap
        </button>
        <button
          type="button"
          className={skimming ? 'active' : ''}
          data-testid="timeline-skimming"
          title="Toggle skimming (S)"
          onClick={() => useTimelineStore.getState().toggleSkimming()}
        >
          Skim
        </button>
      </div>
      <div className="panel-body timeline-body">
        {sequence === null ? <span>Loading project…</span> : <TimelineCanvas />}
      </div>
    </section>
  )
}
