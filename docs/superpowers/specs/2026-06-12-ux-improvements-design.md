# UX improvements: play affordances, layout, multi-clip preview — design

Date: 2026-06-12
Status: implementing (user requested autonomous research + implementation)

## Problem

Four user reports, all rooted in the app being keyboard-only where beginners
expect visible controls:

1. **"I can't hit play to watch the clip."** The sequence viewer
   (`SequencePlayer.tsx`) renders only a canvas and a "playing/paused" label —
   no transport controls at all. The source viewer placeholder ("No clip open —
   double-click a clip") also has no play button, and pressing Space in that
   state with an empty timeline does nothing.
2. **No "back to start" button.** `Home` exists for the timeline only; the
   source viewer has no go-to-start binding or button.
3. **No layout reset.** The app shell is a fixed CSS grid (340px browser /
   300px inspector / 280px timeline) — panels can't be resized, so there's
   nothing to reset _and_ no way to adapt the layout to a task.
4. **No way to watch several clips at once** (review a shoot quickly).

## Assumptions

- "Reset layout" implies panels should be _resizable first_ (splitters),
  with reset restoring the shipped defaults.
- The multi-clip grid is a _review_ tool (which take is good?), not an
  editing surface — muted by default, click to solo audio, double-click to
  promote a cell to the real viewer.
- Space behavior stays conservative: existing contextual rules unchanged;
  the new "play the browser selection" path only triggers where Space was
  previously dead (no clip open, empty sequence).

## Design

### 1. Transport everywhere (`viewer-transport` bar)

- **Sequence viewer** gets the same transport bar as the source viewer:
  go-to-start `|◀`, play/pause `▶/⏸`, go-to-end `▶|`, plus the sequence
  timecode it already shows. Buttons drive a new shared
  `src/renderer/playback/transport.ts` (`toggleSequencePlayback(seq, snap)`,
  `seekSequence(flicks)`) used by both the TimelinePanel shortcuts and the
  SequencePlayer buttons — one code path for Space and the button.
- **Source viewer** transport gains go-to-start `|◀` (seek frame 0; keeps
  playing if playing) and `Home`/`End` keyboard parity while the viewer is
  focused.
- **Placeholder viewer** (no clip open): shows a real ▶ button — enabled when
  the browser has a selection; clicking opens the first selected asset and
  autoplays (autoplay flows through `LibraryContext.openAsset(id, { autoplay })`).
- **Space rescue:** in `togglePlayback`, if the sequence is empty and a
  browser selection exists, open + autoplay the selection instead of doing
  nothing (FCP's "Space plays the browser selection" behavior, scoped to the
  previously-dead case).

### 2. Resizable layout + Reset Layout

- Grid sizes become CSS variables on `.app-shell`:
  `--browser-w` (default 340px, clamp 240–560), `--inspector-w` (default
  300px, clamp 240–480), `--timeline-h` (default 280px, clamp 160–60vh).
- Three 5px-wide splitter divs (browser/viewer, viewer/inspector,
  middle/timeline) with pointer-capture drag; double-click a splitter resets
  that one dimension.
- Sizes persist to `localStorage["magnetic.layout.v1"]`; a **Reset Layout**
  button in the topbar (next to Inspector) restores defaults and clears the
  key. Defaults are identical to today's fixed sizes so existing E2E
  geometry is unchanged.
- `TimelineCanvas` already redraws via `ResizeObserver`, so live resize is
  safe.

### 3. Multi-clip preview grid ("Review Grid")

- Entry: browser toolbar button **Grid-preview (N)** appears when ≥2 assets
  are selected; opens grid mode in the viewer panel (a third `viewerMode`
  is _not_ added to the timeline store — grid is local viewer state in
  `LibraryContext` (`gridAssetIds: string[] | null`) so sequence playback
  state is untouched).
- Layout: 2→1×2, 3–4→2×2, 5–6→2×3, 7–9→3×3; hard cap 9 cells (first 9 of
  the selection; toolbar label says "first 9" when over).
- Cells are `<video>` elements over the loopback media server
  (`asset.mediaUrl`, or proxy via the same `needsProxy`/`ensureProxy` logic
  as the source viewer), `loop` + `muted` + autoplay.
- Audio: all muted; **click a cell to solo** its audio (click again to
  mute); **double-click promotes** the cell to the normal source viewer.
- Grid toolbar: play/pause-all, restart-all (back-to-start synergy), close
  (`Escape` also closes, returning focus to the browser).
- Missing/processing assets render a placeholder cell rather than breaking
  the grid.

### 4. Research-driven quick wins (from the NLE survey)

Implemented (small, high leverage):

- **Shift+Z — zoom timeline to fit** (FCP convention): computes
  `pxPerSec = timelineWidth / durationSec`, clamped to [4, 1000].
- **Up/Down — jump to previous/next edit point** (FCP convention): spine
  boundaries incl. 0 and sequence end.
- **Focused-panel indication**: `:focus-within` accent hairline on the
  panel headers, so the contextual Space/JKL rules become visible instead
  of mysterious.
- **L/Space dead-state fixes** above are themselves the top finding: every
  surveyed NLE (FCP, Premiere, Resolve, CapCut) keeps a visible transport
  under the monitor at all times.

Deferred (bigger than this pass): loop-playback toggle wired into the
engine, timecode click-to-type seeking, browser filmstrip audio scrubbing,
dual viewers.

## Testing

- Unit (vitest): transport helper logic (toggle from end restarts at 0;
  empty-sequence guard), grid layout math (N→rows×cols), layout clamp math.
- E2E (Playwright, patterns from `e2e/viewer.spec.ts`):
  - sequence transport: button play/pause toggles `sequence-playing`,
    go-to-start zeroes the playhead timecode
  - placeholder play button opens + plays the selected browser clip
  - resize browser splitter → width changes; Reset Layout restores 340px
  - grid: select 2 clips → grid button → 2 cells render and play; click
    solos audio; double-click opens the clip in the source viewer
  - Shift+Z fits a long sequence; Up/Down land on edit-point timecodes
