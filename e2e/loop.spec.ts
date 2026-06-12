import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000

// canvas layout constants mirrored from src/renderer/timeline/render.ts
const RULER_H = 26
const LANE_H = 32
const SPINE_H = 48
const GUTTER = 4

interface LoopTestState {
  sequence: Sequence | null
  playheadFlicks: number
  zoomPxPerSec: number
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<LoopTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): LoopTestState }).__magneticState()
  )
}

async function waitForTimeline(page: Page): Promise<void> {
  await expect(page.getByTestId('timeline-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
}

function xForTime(state: LoopTestState, flicks: number): number {
  return (flicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
}

/** rowLayout math mirrored from render.ts, derived from CURRENT state. */
function laneCenterY(state: LoopTestState, lane: number): number {
  let maxVideo = 1
  for (const cc of state.sequence!.connected) {
    if (cc.lane > maxVideo) maxVideo = cc.lane
  }
  const spineY = RULER_H + GUTTER + maxVideo * (LANE_H + GUTTER)
  if (lane === 0) return spineY + SPINE_H / 2
  if (lane > 0) return RULER_H + GUTTER + (maxVideo - lane) * (LANE_H + GUTTER) + LANE_H / 2
  return spineY + SPINE_H + GUTTER + (-lane - 1) * (LANE_H + GUTTER) + LANE_H / 2
}

function audioRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hooks = window as unknown as { __magneticTimeline: { playback: { rms(): number } } }
    return hooks.__magneticTimeline.playback.rms()
  })
}

test('loop-to-fill: context menu loops a music bed across the spine, audible past the source, one undo, persists', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-loop-'))
  const libraryPath = join(tempRoot, 'Loop.mglib')
  let app = await launchApp(libraryPath)
  let page = await app.firstWindow()

  // red-720p25 has NO audio stream — the looped tone is the only audible source
  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'red-720p25.mp4'), join(FIXTURES, 'tone.wav')]
  )
  expect(imported.errors).toEqual([])
  await waitForTimeline(page)
  await expect(page.getByTestId('asset-strip')).toHaveCount(1, { timeout: 60_000 })

  const library = await page.evaluate(() => window.api.getLibrary())
  const red = Object.values(library.assets).find((a) => a.fileName === 'red-720p25.mp4')!
  const tone = Object.values(library.assets).find((a) => a.fileName === 'tone.wav')!

  // ---- spine: red ×3 (24 s, silent); tone (5 s) connected at playhead 0 ----
  await page.getByTestId(`asset-cell-${red.fileName}`).click()
  for (let i = 0; i < 3; i++) await page.keyboard.press('e')
  await page.getByTestId(`asset-cell-${tone.fileName}`).click()
  await page.keyboard.press('q')
  for (let i = 0; i < 4; i++) await page.keyboard.press('-') // whole spine on screen
  let state = await getState(page)
  const total = 3 * red.durationFlicks
  expect(state.sequence!.spine).toHaveLength(3)
  expect(state.sequence!.connected).toHaveLength(1)
  const music = state.sequence!.connected[0]
  expect(music.durationFlicks).toBe(tone.durationFlicks)
  expect(music.loop).toBeUndefined()
  const preLoop = state.sequence

  // ---- right-click the connected clip → "Loop to End of Spine" ----
  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  await page.mouse.click(
    bounds.x + xForTime(state, tone.durationFlicks / 2),
    bounds.y + laneCenterY(state, music.lane),
    { button: 'right' }
  )
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await expect(page.getByTestId('context-loop')).toHaveText('Loop to End of Spine')
  await expect(page.getByTestId('context-loop')).toBeEnabled()
  await page.getByTestId('context-loop').click()
  state = await getState(page)
  let looped = state.sequence!.connected[0]
  expect(looped.loop).toBe(true)
  expect(looped.durationFlicks).toBe(total) // stretched to the spine end
  const postLoop = state.sequence

  // ---- ONE Ctrl+Z reverts BOTH the flag and the stretch (grouped undo) ----
  await page.keyboard.press('Control+z')
  state = await getState(page)
  expect(state.sequence).toEqual(preLoop)
  await page.keyboard.press('Control+Shift+z')
  state = await getState(page)
  expect(state.sequence).toEqual(postLoop)

  // ---- audible past the source duration: only the looped tone can sound ----
  // warm-up play from 0: PCM extraction + decode happen off the measured path
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await expect.poll(() => audioRms(page), { timeout: 30_000 }).toBeGreaterThan(0.005)
  await page.keyboard.press('k')
  await expect.poll(() => audioRms(page), { timeout: 10_000 }).toBeLessThan(0.005)
  // seek to 12 s — well past tone.wav's 5 s of source media
  const seekTarget = Math.round(total / 2)
  await page.mouse.click(bounds.x + xForTime(state, seekTarget), bounds.y + 10)
  state = await getState(page)
  expect(state.playheadFlicks).toBeGreaterThan(tone.durationFlicks)
  await page.keyboard.press('Space')
  await expect
    .poll(
      async () => {
        const probe = await page.evaluate(() => {
          const hooks = window as unknown as {
            __magneticTimeline: { playback: { rms(): number } }
            __magneticState(): { playheadFlicks: number }
          }
          return {
            rms: hooks.__magneticTimeline.playback.rms(),
            playheadFlicks: hooks.__magneticState().playheadFlicks
          }
        })
        if (probe.rms > 0.005) {
          // audible while inside the looped span and beyond the source length
          expect(probe.playheadFlicks).toBeGreaterThan(tone.durationFlicks)
          expect(probe.playheadFlicks).toBeLessThan(total)
          return true
        }
        return false
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await page.keyboard.press('k')
  await expect.poll(() => audioRms(page), { timeout: 10_000 }).toBeLessThan(0.005)

  // ---- relaunch: loop=true and the stretched duration survived saveSequence ----
  await page.waitForTimeout(900) // renderer debounce (250ms) + main autosave (500ms)
  await app.close()
  app = await launchApp(libraryPath)
  page = await app.firstWindow()
  await waitForTimeline(page)
  const restored = await getState(page)
  expect(restored.sequence).toEqual(postLoop)
  looped = restored.sequence!.connected[0]
  expect(looped.loop).toBe(true)
  expect(looped.durationFlicks).toBe(total)
  await app.close()
})
