import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Transcript } from '../../shared/types'
import { useLibrary } from '../state/LibraryContext'
import { useTimelineStore } from '../state/timeline-store'
import { ensureTranscripts } from './cache'
import { fillerRanges, projectTranscript, type SequenceWord } from './projection'

/**
 * Timeline transcript: a pure projection of the sequence. Click a word to
 * seek; select words and press Delete to ripple-cut their time range; remove
 * every filler in one undoable step; search and cycle matches.
 */
export function TranscriptPanel(): ReactNode {
  const { snapshot } = useLibrary()
  const sequence = useTimelineStore((state) => state.sequence)
  const playheadFlicks = useTimelineStore((state) => state.playheadFlicks)
  const [transcripts, setTranscripts] = useState<Map<string, Transcript>>(new Map())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // fetch transcripts for every asset the sequence references (shared cache,
  // also warmed for the playback engine's burned-in captions)
  useEffect(() => {
    if (sequence === null || snapshot === null) return
    let disposed = false
    void ensureTranscripts(sequence, snapshot).then((map) => {
      if (!disposed) setTranscripts(map)
    })
    return () => {
      disposed = true
    }
  }, [sequence, snapshot])

  const words = useMemo(
    () => (sequence === null ? [] : projectTranscript(sequence, transcripts)),
    [sequence, transcripts]
  )
  const fillers = useMemo(() => fillerRanges(words), [words])
  const matches = useMemo(() => {
    if (search.trim() === '') return []
    const needle = search.trim().toLowerCase()
    return words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => word.text.toLowerCase().includes(needle))
  }, [words, search])

  const selectionRange = useMemo(() => {
    if (anchor === null || focus === null) return null
    const lo = Math.min(anchor, focus)
    const hi = Math.max(anchor, focus)
    return { lo, hi }
  }, [anchor, focus])

  // word selection ↔ timeline range band
  useEffect(() => {
    const store = useTimelineStore.getState()
    if (selectionRange === null || words.length === 0) {
      store.setTimeRange(null)
      return
    }
    store.setTimeRange(
      words[selectionRange.lo].seqStartFlicks,
      words[selectionRange.hi].seqEndFlicks
    )
  }, [selectionRange, words])

  const seekTo = (flicks: number): void => {
    const store = useTimelineStore.getState()
    store.setViewerMode('sequence')
    store.setPlayhead(flicks)
  }

  const deleteSelection = (): void => {
    if (selectionRange === null || words.length === 0) return
    const from = words[selectionRange.lo].seqStartFlicks
    const to = words[selectionRange.hi].seqEndFlicks
    useTimelineStore.getState().deleteRanges([{ fromFlicks: from, toFlicks: to }])
    setAnchor(null)
    setFocus(null)
  }

  const removeFillers = (): void => {
    useTimelineStore.getState().deleteRanges(fillers)
    setAnchor(null)
    setFocus(null)
  }

  const cycleSearch = (): void => {
    if (matches.length === 0) return
    const target = matches[searchCursor % matches.length]
    seekTo(target.word.seqStartFlicks)
    setSearchCursor((cursor) => cursor + 1)
    containerRef.current
      ?.querySelector(`[data-word-index="${target.index}"]`)
      ?.scrollIntoView({ block: 'center' })
  }

  const matchIndexes = useMemo(() => new Set(matches.map(({ index }) => index)), [matches])

  return (
    <div className="transcript-panel" data-testid="transcript-panel">
      <div className="transcript-toolbar">
        <input
          type="search"
          data-testid="transcript-search"
          placeholder="Search transcript"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setSearchCursor(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') cycleSearch()
          }}
        />
        <button
          type="button"
          data-testid="transcript-cut-selection"
          disabled={selectionRange === null}
          title="Ripple-delete the selected words' time range (Delete)"
          onClick={deleteSelection}
        >
          Cut selection
          {selectionRange !== null ? ` (${selectionRange.hi - selectionRange.lo + 1})` : ''}
        </button>
        <button
          type="button"
          data-testid="transcript-remove-fillers"
          disabled={fillers.length === 0}
          title="Ripple-delete every detected filler word (one undo step)"
          onClick={removeFillers}
        >
          Remove fillers ({fillers.length})
        </button>
      </div>
      <div
        ref={containerRef}
        className="transcript-words"
        data-testid="transcript-words"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            event.stopPropagation() // keep the global ripple-delete shortcut out
            deleteSelection()
          }
        }}
      >
        {words.length === 0 && (
          <div className="browser-empty">
            No transcript yet — add clips with audio to the timeline (transcription runs in the
            background after import)
          </div>
        )}
        {words.map((word, index) => (
          <span key={`${word.clipId}-${index}`} className="transcript-token">
            {word.clipBoundary && index > 0 && <span className="transcript-boundary">¦</span>}
            <span
              data-testid={`transcript-word-${index}`}
              data-word-index={index}
              data-start={word.seqStartFlicks}
              data-end={word.seqEndFlicks}
              data-filler={word.isFiller ? '1' : undefined}
              className={wordClassName(word, index, selectionRange, matchIndexes, playheadFlicks)}
              onMouseDown={(event) => {
                event.preventDefault()
                containerRef.current?.focus()
                setAnchor(index)
                setFocus(index)
              }}
              onMouseEnter={(event) => {
                if (event.buttons === 1 && anchor !== null) setFocus(index)
              }}
              onClick={() => seekTo(word.seqStartFlicks)}
            >
              {word.text}
            </span>{' '}
          </span>
        ))}
      </div>
    </div>
  )
}

function wordClassName(
  word: SequenceWord,
  index: number,
  selectionRange: { lo: number; hi: number } | null,
  matchIndexes: Set<number>,
  playheadFlicks: number
): string {
  const classes = ['transcript-word']
  if (word.isFiller) classes.push('filler')
  if (selectionRange !== null && index >= selectionRange.lo && index <= selectionRange.hi) {
    classes.push('selected')
  }
  if (matchIndexes.has(index)) classes.push('match')
  if (playheadFlicks >= word.seqStartFlicks && playheadFlicks < word.seqEndFlicks) {
    classes.push('current')
  }
  return classes.join(' ')
}
