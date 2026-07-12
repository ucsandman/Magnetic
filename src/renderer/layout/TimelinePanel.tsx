import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { flicksToTimecode } from '../../shared/timecode'
import { spineEditPoints } from '../../shared/timeline/model'
import { AgentProposalBanner } from '../copilot/AgentProposalBanner'
import { playbackEngine } from '../playback/engine'
import { goToSequenceEnd, seekSequence, toggleSequencePlayback } from '../playback/transport'
import { isEditableTarget, registerShortcut } from '../shortcuts'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore, type SourceClip } from '../state/timeline-store'
import { TimelineCanvas } from '../timeline/TimelineCanvas'

// Space/JKL/Home/End belong to the source viewer while it is focused; the
// sequence (timeline) owns them otherwise, and always in sequence mode.
function sourceViewerNotFocused(): boolean {
  if (useTimelineStore.getState().viewerMode === 'sequence') return true
  const viewer = document.querySelector('[data-testid="panel-viewer"]')
  return !(viewer?.contains(document.activeElement) ?? false)
}

export function TimelinePanel(): ReactNode {
  const { snapshot, selectedIds, markedRange, openAsset } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const playheadFlicks = useTimelineStore((state) => state.playheadFlicks)
  const snapping = useTimelineStore((state) => state.snapping)
  const skimming = useTimelineStore((state) => state.skimming)
  const zoomPxPerSec = useTimelineStore((state) => state.zoomPxPerSec)
  const tool = useTimelineStore((state) => state.tool)
  const load = useTimelineStore((state) => state.load)

  useEffect(() => {
    void load()
  }, [load])

  // Edit menu Undo/Redo (accelerators are swallowed by the menu when focused)
  useEffect(() => {
    return window.api.onEditCommand((command) => {
      const store = useTimelineStore.getState()
      if (command === 'undo') store.undo()
      else store.redo()
    })
  }, [])

  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])
  const openAssetRef = useRef(openAsset)
  useEffect(() => {
    openAssetRef.current = openAsset
  }, [openAsset])

  // Sequence transport: space toggles, L plays, K/J pause (no reverse decode).
  // Gated off while the SOURCE viewer is focused — its own JKL applies there.
  useEffect(() => {
    const togglePlayback = (): void => {
      const store = useTimelineStore.getState()
      if (toggleSequencePlayback(store.sequence, snapshotRef.current)) return
      // Nothing on the timeline: play the browser selection instead of
      // going dead (FCP plays the browser selection from the browser).
      const selectedId = selectedIdsRef.current[0]
      if (selectedId !== undefined) {
        openAssetRef.current(selectedId, { autoplay: true })
        document.querySelector<HTMLElement>('[data-testid="panel-viewer"]')?.focus()
      }
    }
    const unsubscribers = [
      registerShortcut('timeline-play-toggle', {
        combo: 'space',
        description: 'Play / pause the sequence',
        when: sourceViewerNotFocused,
        handler: togglePlayback
      }),
      registerShortcut('timeline-play-l', {
        combo: 'l',
        description: 'Play the sequence',
        when: sourceViewerNotFocused,
        handler: () => {
          if (!playbackEngine.isPlaying) togglePlayback()
        }
      }),
      registerShortcut('timeline-pause-k', {
        combo: 'k',
        description: 'Pause the sequence',
        when: sourceViewerNotFocused,
        handler: () => playbackEngine.pause()
      }),
      registerShortcut('timeline-pause-j', {
        combo: 'j',
        description: 'Pause the sequence (reverse playback is not supported)',
        when: sourceViewerNotFocused,
        handler: () => playbackEngine.pause()
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

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
    const notEditable = (): boolean => !isEditableTarget(document.activeElement)
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
        when: sourceViewerNotFocused,
        handler: () => seekSequence(store().sequence, snapshotRef.current, 0)
      }),
      registerShortcut('timeline-end', {
        combo: 'end',
        description: 'Move the playhead to the end',
        when: sourceViewerNotFocused,
        handler: () => goToSequenceEnd(store().sequence)
      }),
      registerShortcut('timeline-prev-edit', {
        combo: 'arrowup',
        description: 'Move the playhead to the previous edit point',
        when: () =>
          sourceViewerNotFocused() && !(document.activeElement instanceof HTMLSelectElement),
        handler: () => {
          const seq = store().sequence
          if (seq === null) return
          const playhead = store().playheadFlicks
          const prev = spineEditPoints(seq)
            .reverse()
            .find((point) => point < playhead)
          if (prev !== undefined) seekSequence(seq, snapshotRef.current, prev)
        }
      }),
      registerShortcut('timeline-next-edit', {
        combo: 'arrowdown',
        description: 'Move the playhead to the next edit point',
        when: () =>
          sourceViewerNotFocused() && !(document.activeElement instanceof HTMLSelectElement),
        handler: () => {
          const seq = store().sequence
          if (seq === null) return
          const playhead = store().playheadFlicks
          const next = spineEditPoints(seq).find((point) => point > playhead)
          if (next !== undefined) seekSequence(seq, snapshotRef.current, next)
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
      }),
      registerShortcut('timeline-tool-select', {
        combo: 'a',
        description: 'Select tool',
        handler: () => store().setTool('select')
      }),
      registerShortcut('timeline-tool-blade', {
        combo: 'b',
        description: 'Blade tool',
        handler: () => store().setTool('blade')
      }),
      registerShortcut('timeline-tool-trim', {
        combo: 't',
        description: 'Trim tool (edges ripple, edit points roll, body slips)',
        handler: () => store().setTool('trim')
      }),
      registerShortcut('timeline-blade-playhead', {
        combo: 'ctrl+b',
        description: 'Blade at the playhead (selected clips, or the clip under it)',
        handler: () => store().bladeAtPlayhead()
      }),
      registerShortcut('timeline-add-transition', {
        combo: 'ctrl+t',
        description: 'Add a 1 s cross dissolve at the edit point nearest the playhead',
        handler: () => store().addTransitionAtPlayhead()
      }),
      // Clipboard combos shadow the Edit-menu copy/paste roles (their menu
      // accelerators are unregistered, see menu.ts). Text fields keep native
      // copy/paste: the registry skips editable targets, belt-and-braces here.
      registerShortcut('timeline-copy', {
        combo: 'ctrl+c',
        description: 'Copy the selected clips',
        when: notEditable,
        handler: () => store().copySelection()
      }),
      registerShortcut('timeline-paste', {
        combo: 'ctrl+v',
        description: 'Paste clips at the playhead (insert)',
        when: notEditable,
        handler: () => store().pasteAtPlayhead('insert')
      }),
      registerShortcut('timeline-paste-connect', {
        combo: 'ctrl+shift+v',
        description: 'Paste clips connected above the spine at the playhead',
        when: notEditable,
        handler: () => store().pasteAtPlayhead('connect')
      }),
      registerShortcut('timeline-duplicate', {
        combo: 'ctrl+d',
        description: 'Duplicate the selected clips after the selection',
        when: notEditable,
        handler: () => store().duplicateSelection()
      }),
      registerShortcut('timeline-paste-attributes', {
        combo: 'ctrl+alt+v',
        description: 'Paste the copied clip’s effects onto the selected clips',
        when: notEditable,
        handler: () => store().pasteAttributes()
      }),
      registerShortcut('timeline-detach-audio', {
        combo: 'ctrl+shift+s',
        description: 'Detach audio from the selected spine clip into the lane below',
        handler: () => {
          const { sequence, selection } = store()
          if (sequence === null) return
          const target = selection.clipIds.find((id) =>
            sequence.spine.some((item) => item.id === id && item.kind === 'clip')
          )
          if (target !== undefined) store().detachAudio(target)
        }
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [buildSource])

  const fps = sequence?.fps ?? { num: 30, den: 1 }
  return (
    <section className="panel panel-timeline" data-testid="panel-timeline">
      <header className="panel-header">Timeline</header>
      <AgentProposalBanner />
      <div className="panel-toolbar timeline-toolbar">
        <span className="timeline-tc" data-testid="timeline-playhead-tc">
          {flicksToTimecode(playheadFlicks, fps)}
        </span>
        <span className="timeline-tools">
          {(
            [
              ['select', 'A', 'Select — drag bodies to rearrange, edges to ripple trim'],
              ['blade', 'B', 'Blade — click a clip to cut it'],
              ['trim', 'T', 'Trim — edges ripple, edit points roll, clip body slips']
            ] as const
          ).map(([id, key, title]) => (
            <button
              key={id}
              type="button"
              className={tool === id ? 'active' : ''}
              data-testid={`tool-${id}`}
              title={`${title} (${key})`}
              onClick={() => useTimelineStore.getState().setTool(id)}
            >
              {key}
            </button>
          ))}
        </span>
        <span className="timeline-role-mutes">
          {(
            [
              ['dialogue', 'Dia'],
              ['music', 'Mus'],
              ['sfx', 'SFX']
            ] as const
          ).map(([role, label]) => {
            const muted = sequence?.mutedRoles?.includes(role) ?? false
            return (
              <button
                key={role}
                type="button"
                className={muted ? 'role-muted' : ''}
                data-testid={`role-mute-${role}`}
                title={`${muted ? 'Unmute' : 'Mute'} every ${role} clip in the mix`}
                onClick={() => {
                  const current = useTimelineStore.getState().sequence?.mutedRoles ?? []
                  useTimelineStore
                    .getState()
                    .setRoleMutes(
                      muted ? current.filter((r) => r !== role) : [...current, role]
                    )
                }}
              >
                {muted ? `${label} ✕` : label}
              </button>
            )
          })}
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
