import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Selection } from '../src/shared/timeline/select'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-5')
const FLICKS_PER_SECOND = 705_600_000

interface TimelineTestState {
  sequence: Sequence | null
  selection: Selection
  playheadFlicks: number
  zoomPxPerSec: number
  snapping: boolean
  skimming: boolean
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<TimelineTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): TimelineTestState }).__magneticState()
  )
}

async function importFixtures(page: Page, files: string[]): Promise<void> {
  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    files.map((file) => join(FIXTURES, file))
  )
  expect(imported.errors).toEqual([])
}

async function waitForTimeline(page: Page): Promise<void> {
  await expect(page.getByTestId('timeline-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
}

function spineIds(state: TimelineTestState): string[] {
  return state.sequence!.spine.map((item) => item.id)
}

function spineDurations(state: TimelineTestState): number[] {
  return state.sequence!.spine.map((item) => item.durationFlicks)
}

function totalDuration(state: TimelineTestState): number {
  return spineDurations(state).reduce((a, b) => a + b, 0)
}

/** Canvas-local x for a sequence time at the current zoom (scrollX assumed 0). */
function xForTime(state: TimelineTestState, flicks: number): number {
  return (flicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
}

test('timeline: E/W/Q/D edits, deletes, drag, snapping, zoom, persistence', async () => {
  test.setTimeout(240_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-timeline-'))
  const libraryPath = join(tempRoot, 'Timeline.mglib')
  let app = await launchApp(libraryPath)
  let page = await app.firstWindow()

  await importFixtures(page, ['bars-1080p30.mp4', 'red-720p25.mp4', 'tone.wav'])
  await waitForTimeline(page)
  // filmstrips ready for both video assets (zoom screenshot needs painted strips)
  await expect(page.getByTestId('asset-strip')).toHaveCount(2, { timeout: 60_000 })
  // waveform peaks ready for the audio asset
  await page.waitForFunction(
    async () => {
      const lib = await window.api.getLibrary()
      return Object.values(lib.assets)
        .filter((asset) => asset.video === undefined)
        .every((asset) => asset.waveform !== undefined)
    },
    undefined,
    { timeout: 60_000 }
  )

  const library = await page.evaluate(() => window.api.getLibrary())
  const assets = Object.values(library.assets)
  const bars = assets.find((asset) => asset.fileName === 'bars-1080p30.mp4')!
  const red = assets.find((asset) => asset.fileName === 'red-720p25.mp4')!

  // ---- E twice: two bars clips appended ----
  await page.getByTestId(`asset-cell-${bars.fileName}`).click()
  await page.keyboard.press('e')
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(spineDurations(state)).toEqual([bars.durationFlicks, bars.durationFlicks])

  // ---- W: insert red at playhead 0 → prepended, downstream rippled ----
  await page.getByTestId(`asset-cell-${red.fileName}`).click()
  await page.keyboard.press('w')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  expect(spineDurations(state)).toEqual([
    red.durationFlicks,
    bars.durationFlicks,
    bars.durationFlicks
  ])
  const [insertedId, clipA, clipB] = spineIds(state)

  // ---- D: overwrite at playhead 0 with red → replaces the head clip exactly ----
  await page.keyboard.press('d')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  expect(totalDuration(state)).toBe(red.durationFlicks + 2 * bars.durationFlicks)
  const overwrittenId = spineIds(state)[0]
  expect(overwrittenId).not.toBe(insertedId)
  expect(spineIds(state).slice(1)).toEqual([clipA, clipB])

  // ---- Q: connect bars at playhead 0 on lane 1 above the spine ----
  await page.getByTestId(`asset-cell-${bars.fileName}`).click()
  await page.keyboard.press('q')
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(1)
  const connected = state.sequence!.connected[0]
  expect(connected.lane).toBe(1) // above the spine (video lane)
  expect(connected.parentClipId).toBe(overwrittenId)
  expect(connected.offsetFlicks).toBe(0)

  // ---- audio clip on the spine so zoom/evidence screenshots include a waveform ----
  await page.getByTestId('asset-cell-tone.wav').click()
  await page.keyboard.press('e')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(4)
  const toneId = spineIds(state)[3]
  await page.waitForTimeout(400) // let the renderer fetch peaks and repaint

  // ---- Zoom: px-per-second changes and the canvas re-renders differently ----
  const canvas = page.getByTestId('timeline-canvas')
  const zoomBefore = state.zoomPxPerSec
  const shotBefore = await canvas.screenshot()
  await page.keyboard.press('=')
  state = await getState(page)
  expect(state.zoomPxPerSec).toBeGreaterThan(zoomBefore)
  const shotAfter = await canvas.screenshot()
  expect(shotBefore.equals(shotAfter)).toBe(false)

  // ---- Zoom out so the whole sequence fits for drag interactions ----
  for (let i = 0; i < 5; i++) await page.keyboard.press('-')
  state = await getState(page)

  // evidence screenshot: full sequence with filmstrips, waveform clip, connected lane, playhead
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(EVIDENCE, 'timeline.png') })
  const bounds = (await canvas.boundingBox())!
  const spineCenterY = bounds.y + 26 + 4 + 36 + 24 // ruler + gutter + one video lane + half spine

  // ---- Remove the audio clip again (click-select + ripple delete) ----
  const toneStart = red.durationFlicks + 2 * bars.durationFlicks
  await page.mouse.click(bounds.x + xForTime(state, toneStart) + 10, spineCenterY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([toneId])
  await page.keyboard.press('Delete')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)

  // ---- Drag the connected clip's parent to the end: connected moves with it ----
  const dragFromX = bounds.x + xForTime(state, red.durationFlicks / 2)
  const dragToX = bounds.x + xForTime(state, totalDuration(state)) - 2
  await page.mouse.move(dragFromX, spineCenterY)
  await page.mouse.down()
  await page.mouse.move(dragToX, spineCenterY, { steps: 12 })
  await page.mouse.up()
  state = await getState(page)
  expect(spineIds(state)).toEqual([clipA, clipB, overwrittenId])
  const movedParentStart = 2 * bars.durationFlicks
  // connected clip traveled with its parent to the new absolute position
  expect(state.sequence!.connected[0].parentClipId).toBe(overwrittenId)
  expect(state.sequence!.connected[0].offsetFlicks).toBe(0)
  const parentStart = spineDurations(state)
    .slice(0, 2)
    .reduce((a, b) => a + b, 0)
  expect(parentStart).toBe(movedParentStart)

  // ---- Ripple delete clipB: total shrinks by exactly its duration ----
  state = await getState(page)
  const clipBStart = bars.durationFlicks // clipA occupies [0, bars)
  await page.mouse.click(bounds.x + xForTime(state, clipBStart) + 20, spineCenterY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([clipB])
  const totalBeforeDelete = totalDuration(state)
  await page.keyboard.press('Delete')
  state = await getState(page)
  expect(spineIds(state)).toEqual([clipA, overwrittenId])
  expect(totalDuration(state)).toBe(totalBeforeDelete - bars.durationFlicks)

  // ---- Lift delete clipA: a gap of identical duration remains ----
  await page.mouse.click(bounds.x + xForTime(state, 0) + 20, spineCenterY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([clipA])
  const totalBeforeLift = totalDuration(state)
  await page.keyboard.press('Shift+Delete')
  state = await getState(page)
  expect(state.sequence!.spine[0].kind).toBe('gap')
  expect(state.sequence!.spine[0].durationFlicks).toBe(bars.durationFlicks)
  expect(totalDuration(state)).toBe(totalBeforeLift)

  // ---- Snapping: trim drag lands exactly on the playhead with N on, off it with N off ----
  // playhead two seconds before the sequence end, via ruler click
  const total = totalDuration(state)
  const playheadTarget = total - 2 * FLICKS_PER_SECOND
  await page.mouse.click(bounds.x + xForTime(state, playheadTarget), bounds.y + 10)
  state = await getState(page)
  const playhead = state.playheadFlicks
  expect(Math.abs(playhead - playheadTarget)).toBeLessThan(FLICKS_PER_SECOND / 4)
  expect(state.snapping).toBe(true)

  // drag the last clip's tail edge to 4px right of the playhead → snaps onto it
  const endX = bounds.x + xForTime(state, total)
  await page.mouse.move(endX - 2, spineCenterY)
  await page.mouse.down()
  await page.mouse.move(bounds.x + xForTime(state, playhead) + 4, spineCenterY, { steps: 8 })
  await page.mouse.up()
  state = await getState(page)
  expect(totalDuration(state)).toBe(playhead) // exact snap onto the playhead

  // N toggles snapping off; same gesture now lands off the snap point
  await page.keyboard.press('n')
  state = await getState(page)
  expect(state.snapping).toBe(false)
  const endX2 = bounds.x + xForTime(state, totalDuration(state))
  await page.mouse.move(endX2 - 2, spineCenterY)
  await page.mouse.down()
  await page.mouse.move(endX2 + 14, spineCenterY, { steps: 8 })
  await page.mouse.up()
  state = await getState(page)
  expect(totalDuration(state)).not.toBe(playhead) // free trim, no snap-back
  expect(totalDuration(state)).toBeGreaterThan(playhead)

  // ---- Relaunch restores the sequence exactly ----
  const savedSequence = state.sequence
  await page.waitForTimeout(900) // renderer debounce (250ms) + main autosave (500ms)
  await app.close()
  app = await launchApp(libraryPath)
  page = await app.firstWindow()
  await waitForTimeline(page)
  const restored = await getState(page)
  expect(restored.sequence).toEqual(savedSequence)
  await app.close()
})

test('timeline perf: 100 clips render under 33ms median frame time', async () => {
  test.setTimeout(180_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-perf-'))
  const app = await launchApp(join(tempRoot, 'Perf.mglib'))
  const page = await app.firstWindow()

  await importFixtures(page, ['bars-1080p30.mp4'])
  await waitForTimeline(page)
  await expect(page.getByTestId('asset-strip')).toHaveCount(1, { timeout: 60_000 })

  const library = await page.evaluate(() => window.api.getLibrary())
  const bars = Object.values(library.assets)[0]

  await page.evaluate(
    ({ assetId, durationFlicks }) => {
      const hooks = window as unknown as {
        __magneticTimeline: {
          buildPerfSequence(
            count: number,
            asset: {
              assetId: string
              mediaInFlicks: number
              durationFlicks: number
              sourceDurationFlicks: number
            }
          ): void
        }
      }
      hooks.__magneticTimeline.buildPerfSequence(100, {
        assetId,
        mediaInFlicks: 0,
        durationFlicks: Math.floor(durationFlicks / 5),
        sourceDurationFlicks: durationFlicks
      })
    },
    { assetId: bars.id, durationFlicks: bars.durationFlicks }
  )

  const state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(100)

  const stats = await page.evaluate(() => {
    const hooks = window as unknown as {
      __magneticTimeline: {
        measureDraws(n: number): Promise<{ count: number; medianMs: number; maxMs: number }>
      }
    }
    return hooks.__magneticTimeline.measureDraws(60)
  })
  console.log(
    `perf: 100-clip timeline, ${stats.count} draws — median ${stats.medianMs.toFixed(2)}ms, max ${stats.maxMs.toFixed(2)}ms`
  )
  expect(stats.medianMs).toBeLessThan(33)
  await app.close()
})
