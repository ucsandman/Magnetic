import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { AssetView } from '../../shared/types'
import {
  flicksPerFrame,
  flicksToFrame,
  flicksToSeconds,
  flicksToTimecode,
  frameToFlicks,
  secondsToFlicks,
  type Rational
} from '../../shared/timecode'
import { registerShortcut } from '../shortcuts'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { GridPlayer } from './GridPlayer'
import { SequencePlayer } from './SequencePlayer'
import { TimecodeInput } from './TimecodeInput'
import { useMediaUrl } from './use-media-url'

const MAX_RATE = 8
const FALLBACK_FPS: Rational = { num: 25, den: 1 }

export function ViewerPanel(): ReactNode {
  const { snapshot, openedAssetId, gridAssetIds, selectedIds, openAsset, autoplayAssetId } =
    useLibrary()
  const viewerMode = useTimelineStore((state) => state.viewerMode)
  const previousAssetRef = useRef(openedAssetId)
  // opening a (different) source clip pulls the single viewer back to source
  // mode — as does re-opening the current one with autoplay (play-selection)
  useEffect(() => {
    if (
      openedAssetId !== null &&
      (openedAssetId !== previousAssetRef.current || autoplayAssetId === openedAssetId)
    ) {
      useTimelineStore.getState().setViewerMode('source')
    }
    previousAssetRef.current = openedAssetId
  }, [openedAssetId, autoplayAssetId])

  const asset =
    openedAssetId !== null && snapshot !== null ? (snapshot.assets[openedAssetId] ?? null) : null

  if (gridAssetIds !== null) return <GridPlayer assetIds={gridAssetIds} />

  if (viewerMode === 'sequence') return <SequencePlayer />

  if (asset === null) {
    const playable = selectedIds.length > 0
    return (
      <section className="panel panel-viewer" data-testid="panel-viewer" tabIndex={0}>
        <header className="panel-header">Viewer</header>
        <div className="panel-toolbar">
          <span className="viewer-tc">--:--:--:--</span>
        </div>
        <div className="panel-body">
          <div className="viewer-screen">
            <span data-testid="viewer-selected">
              {playable
                ? 'Press play to watch the selected clip'
                : 'No clip open — select or double-click a clip'}
            </span>
          </div>
        </div>
        <div className="viewer-transport">
          <button
            type="button"
            data-testid="viewer-play-pause"
            title={playable ? 'Play the selected clip (Space)' : 'Select a clip to play'}
            disabled={!playable}
            onClick={() => openAsset(selectedIds[0], { autoplay: true })}
          >
            ▶
          </button>
        </div>
      </section>
    )
  }
  return <ViewerContent key={asset.id} asset={asset} />
}

type PlayState = 'paused' | 'forward' | 'reverse'

function ViewerContent({ asset }: { asset: AssetView }): ReactNode {
  const { setMarkedRange, skimTarget, autoplayAssetId, clearAutoplay } = useLibrary()
  const loopPlayback = useTimelineStore((state) => state.loopPlayback)
  const fps = asset.video?.fps ?? FALLBACK_FPS
  const durationFlicks = asset.durationFlicks
  const sectionRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scrubberRef = useRef<HTMLDivElement>(null)

  const [mediaError, setMediaError] = useState<string | null>(null)
  const sourceUrl = useMediaUrl(asset)
  const [timecode, setTimecode] = useState('00:00:00:00')
  const [positionRatio, setPositionRatio] = useState(0)
  const [playState, setPlayState] = useState<PlayState>('paused')
  const [markIn, setMarkIn] = useState<number | null>(null)
  const [markOut, setMarkOut] = useState<number | null>(null)

  const playStateRef = useRef<PlayState>('paused')
  const rateRef = useRef(1)
  const reverseRafRef = useRef<number | null>(null)

  // The placeholder section is replaced by this one when a clip opens, which
  // drops DOM focus — re-take it so JKL shortcuts work immediately.
  useEffect(() => {
    sectionRef.current?.focus()
  }, [])

  // Timecode + playhead readout loop.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const video = videoRef.current
      if (video !== null) {
        const flicks = secondsToFlicks(video.currentTime)
        setTimecode(flicksToTimecode(flicks, fps))
        setPositionRatio(durationFlicks === 0 ? 0 : Math.min(1, flicks / durationFlicks))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fps is stable per asset (keyed component)
  }, [])

  const stopReverse = useCallback((): void => {
    if (reverseRafRef.current !== null) {
      cancelAnimationFrame(reverseRafRef.current)
      reverseRafRef.current = null
    }
  }, [])

  const setState = useCallback((state: PlayState): void => {
    playStateRef.current = state
    setPlayState(state)
  }, [])

  const pause = useCallback((): void => {
    stopReverse()
    videoRef.current?.pause()
    rateRef.current = 1
    setState('paused')
  }, [stopReverse, setState])

  const playForward = useCallback(
    (rate: number): void => {
      const video = videoRef.current
      if (video === null) return
      stopReverse()
      rateRef.current = rate
      video.playbackRate = rate
      void video.play()
      setState('forward')
    },
    [stopReverse, setState]
  )

  const playReverse = useCallback(
    (rate: number): void => {
      const video = videoRef.current
      if (video === null) return
      video.pause()
      stopReverse()
      rateRef.current = rate
      setState('reverse')
      let last = performance.now()
      const step = (now: number): void => {
        const v = videoRef.current
        if (v === null) return
        const dt = (now - last) / 1000
        last = now
        const next = v.currentTime - dt * rateRef.current
        if (next <= 0) {
          v.currentTime = 0
          pause()
          return
        }
        v.currentTime = next
        reverseRafRef.current = requestAnimationFrame(step)
      }
      reverseRafRef.current = requestAnimationFrame(step)
    },
    [stopReverse, setState, pause]
  )

  const seekToFlicks = useCallback(
    (flicks: number): void => {
      const video = videoRef.current
      if (video === null) return
      const fpf = flicksPerFrame(fps)
      const frame = flicksToFrame(Math.max(0, Math.min(flicks, durationFlicks - 1)), fps)
      video.currentTime = flicksToSeconds(frameToFlicks(frame, fps) + Math.floor(fpf / 2))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fps/duration stable per asset
    []
  )

  const stepFrames = useCallback(
    (count: number): void => {
      const video = videoRef.current
      if (video === null) return
      pause()
      const frame = flicksToFrame(secondsToFlicks(video.currentTime), fps)
      const maxFrame = Math.max(0, flicksToFrame(durationFlicks - 1, fps))
      const target = Math.max(0, Math.min(maxFrame, frame + count))
      seekToFlicks(frameToFlicks(target, fps))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fps/duration stable per asset
    [pause, seekToFlicks]
  )

  const currentFrameFlicks = useCallback((): number => {
    const video = videoRef.current
    if (video === null) return 0
    return frameToFlicks(flicksToFrame(secondsToFlicks(video.currentTime), fps), fps)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fps stable per asset
  }, [])

  // Autoplay (placeholder ▶ or Space with a browser selection): start as
  // soon as the media can play.
  useEffect(() => {
    if (autoplayAssetId !== asset.id) return
    const video = videoRef.current
    if (video === null) return
    const start = (): void => {
      clearAutoplay()
      playForward(1)
    }
    if (video.readyState >= 2) {
      start()
      return
    }
    video.addEventListener('canplay', start, { once: true })
    return () => video.removeEventListener('canplay', start)
  }, [autoplayAssetId, asset.id, clearAutoplay, playForward])

  // Publish I/O marks so timeline edit commands (E/W/Q/D) can use the range.
  useEffect(() => {
    setMarkedRange({ assetId: asset.id, inFlicks: markIn, outFlicks: markOut })
  }, [asset.id, markIn, markOut, setMarkedRange])

  // Timeline skim drives a static frame preview of the clip under the skimmer.
  useEffect(() => {
    if (skimTarget !== null && skimTarget.assetId === asset.id) {
      seekToFlicks(skimTarget.mediaFlicks)
    }
  }, [skimTarget, asset.id, seekToFlicks])

  // Keyboard transport (JKL etc.) — active while focus is inside the viewer.
  useEffect(() => {
    const focused = (): boolean => sectionRef.current?.contains(document.activeElement) ?? false
    const unsubscribers = [
      registerShortcut('viewer-l', {
        combo: 'l',
        description: 'Play forward (again: faster)',
        when: focused,
        handler: () => {
          const rate =
            playStateRef.current === 'forward' ? Math.min(rateRef.current * 2, MAX_RATE) : 1
          playForward(rate)
        }
      }),
      registerShortcut('viewer-k', {
        combo: 'k',
        description: 'Pause',
        when: focused,
        handler: () => pause()
      }),
      registerShortcut('viewer-j', {
        combo: 'j',
        description: 'Play reverse (again: faster)',
        when: focused,
        handler: () => {
          const rate =
            playStateRef.current === 'reverse' ? Math.min(rateRef.current * 2, MAX_RATE) : 1
          playReverse(rate)
        }
      }),
      registerShortcut('viewer-space', {
        combo: 'space',
        description: 'Play / pause',
        when: focused,
        handler: () => {
          if (playStateRef.current === 'paused') playForward(1)
          else pause()
        }
      }),
      registerShortcut('viewer-step-back', {
        combo: 'arrowleft',
        description: 'Step back one frame',
        when: focused,
        handler: () => stepFrames(-1)
      }),
      registerShortcut('viewer-step-fwd', {
        combo: 'arrowright',
        description: 'Step forward one frame',
        when: focused,
        handler: () => stepFrames(1)
      }),
      registerShortcut('viewer-step-back-10', {
        combo: 'shift+arrowleft',
        description: 'Step back 10 frames',
        when: focused,
        handler: () => stepFrames(-10)
      }),
      registerShortcut('viewer-step-fwd-10', {
        combo: 'shift+arrowright',
        description: 'Step forward 10 frames',
        when: focused,
        handler: () => stepFrames(10)
      }),
      registerShortcut('viewer-home', {
        combo: 'home',
        description: 'Go to the start of the clip',
        when: focused,
        handler: () => seekToFlicks(0)
      }),
      registerShortcut('viewer-end', {
        combo: 'end',
        description: 'Go to the end of the clip',
        when: focused,
        handler: () => {
          pause()
          seekToFlicks(durationFlicks - 1)
        }
      }),
      registerShortcut('viewer-mark-in', {
        combo: 'i',
        description: 'Mark in point',
        when: focused,
        handler: () => setMarkIn(currentFrameFlicks())
      }),
      registerShortcut('viewer-mark-out', {
        combo: 'o',
        description: 'Mark out point',
        when: focused,
        handler: () => setMarkOut(currentFrameFlicks())
      }),
      registerShortcut('viewer-clear-marks', {
        combo: 'x',
        description: 'Clear in/out points',
        when: focused,
        handler: () => {
          setMarkIn(null)
          setMarkOut(null)
        }
      }),
      registerShortcut('viewer-escape', {
        combo: 'escape',
        description: 'Return focus to browser',
        when: focused,
        handler: () => {
          document.querySelector<HTMLElement>('[data-testid="browser-assets"]')?.focus()
        }
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [
    playForward,
    playReverse,
    pause,
    stepFrames,
    seekToFlicks,
    currentFrameFlicks,
    durationFlicks
  ])

  const onScrub = (event: PointerEvent<HTMLDivElement>): void => {
    const scrubber = scrubberRef.current
    if (scrubber === null) return
    const rect = scrubber.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    seekToFlicks(Math.floor(ratio * durationFlicks))
  }

  const rangeStart = markIn ?? 0
  const rangeEnd = markOut ?? durationFlicks
  const showRange = (markIn !== null || markOut !== null) && rangeEnd > rangeStart

  return (
    <section
      className="panel panel-viewer"
      data-testid="panel-viewer"
      tabIndex={0}
      ref={sectionRef}
    >
      <header className="panel-header">
        Viewer
        <span className="panel-header-note">non-drop TC</span>
      </header>
      <div className="panel-toolbar viewer-toolbar">
        <TimecodeInput
          display={timecode}
          fps={fps}
          durationFlicks={durationFlicks}
          onSeek={(flicks) => seekToFlicks(flicks)}
          testId="viewer-timecode"
        />
        <span className="spacer" />
        <span className="viewer-name">{asset.fileName}</span>
        <span className="spacer" />
        <span className="viewer-tc viewer-tc-dim" data-testid="viewer-duration">
          {flicksToTimecode(durationFlicks, fps)}
        </span>
      </div>
      <div className="viewer-stage">
        <video
          ref={videoRef}
          data-testid="viewer-video"
          src={sourceUrl}
          loop={loopPlayback && (markIn === null || markOut === null)}
          onPause={() => {
            // Keep the transport UI in sync when the element pauses on its own
            // (end of media, fatal error). Reverse mode pauses intentionally.
            if (playStateRef.current === 'forward') setState('paused')
          }}
          onEnded={pause}
          onError={() => {
            const error = videoRef.current?.error
            setMediaError(
              error?.message === '' || error == null ? 'cannot decode this media' : error.message
            )
          }}
          onLoadedData={() => setMediaError(null)}
        />
        {mediaError !== null && (
          <div className="viewer-media-error" data-testid="viewer-media-error">
            Preview unavailable — {mediaError}
          </div>
        )}
      </div>
      <div
        className="viewer-scrubber"
        data-testid="viewer-scrubber"
        ref={scrubberRef}
        onPointerDown={onScrub}
        onPointerMove={(event) => {
          if (event.buttons > 0) onScrub(event)
        }}
      >
        {showRange && (
          <div
            className="viewer-io-range"
            data-testid="viewer-io-range"
            style={{
              left: `${(rangeStart / durationFlicks) * 100}%`,
              width: `${((rangeEnd - rangeStart) / durationFlicks) * 100}%`
            }}
          />
        )}
        <div className="viewer-playhead" style={{ left: `${positionRatio * 100}%` }} />
      </div>
      <div className="viewer-transport">
        <button
          type="button"
          data-testid="viewer-go-start"
          title="Go to start (Home)"
          onClick={() => seekToFlicks(0)}
        >
          ⇤
        </button>
        <button
          type="button"
          data-testid="viewer-step-back"
          title="Step back one frame (←)"
          onClick={() => stepFrames(-1)}
        >
          ⏮
        </button>
        <button
          type="button"
          data-testid="viewer-play-pause"
          title="Play / pause (Space)"
          onClick={() => (playState === 'paused' ? playForward(1) : pause())}
        >
          {playState === 'paused' ? '▶' : '⏸'}
        </button>
        <button
          type="button"
          data-testid="viewer-step-fwd"
          title="Step forward one frame (→)"
          onClick={() => stepFrames(1)}
        >
          ⏭
        </button>
        <span className="transport-sep" />
        <button
          type="button"
          data-testid="viewer-mark-in-btn"
          onClick={() => setMarkIn(currentFrameFlicks())}
        >
          In
        </button>
        <button
          type="button"
          data-testid="viewer-mark-out-btn"
          onClick={() => setMarkOut(currentFrameFlicks())}
        >
          Out
        </button>
        <button
          type="button"
          data-testid="viewer-clear-marks-btn"
          onClick={() => {
            setMarkIn(null)
            setMarkOut(null)
          }}
        >
          Clear
        </button>
        <span className="transport-sep" />
        <button
          type="button"
          data-testid="loop-toggle"
          title="Loop playback (Ctrl+L)"
          aria-pressed={loopPlayback}
          onClick={() => useTimelineStore.getState().setLoopPlayback(!loopPlayback)}
        >
          🔁
        </button>
      </div>
    </section>
  )
}
