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
import type { Sequence, Transition } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-8')
const FLICKS_PER_SECOND = 705_600_000

interface EffectsTestState {
  sequence: (Sequence & { transitions?: Transition[] }) | null
  selection: { clipIds: string[] }
  playheadFlicks: number
  zoomPxPerSec: number
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<EffectsTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): EffectsTestState }).__magneticState()
  )
}

async function sampleRgb(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const hooks = window as unknown as {
        __magneticTimeline: {
          playback: { readPixels(x: number, y: number, w: number, h: number): number[] }
        }
      }
      const data = hooks.__magneticTimeline.playback.readPixels(x, y, 4, 4)
      if (data.length === 0) return [-1, -1, -1] as [number, number, number]
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
      }
      const n = data.length / 4
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as [number, number, number]
    },
    { x, y }
  )
}

/** Count pixels in a region whose channels all exceed `floor` (white-ish text). */
async function countBright(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
  floor = 200
): Promise<number> {
  return page.evaluate(
    ({ x, y, w, h, floor }) => {
      const hooks = window as unknown as {
        __magneticTimeline: {
          playback: { readPixels(x: number, y: number, w: number, h: number): number[] }
        }
      }
      const data = hooks.__magneticTimeline.playback.readPixels(x, y, w, h)
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > floor && data[i + 1] > floor && data[i + 2] > floor) count++
      }
      return count
    },
    { x, y, w, h, floor }
  )
}

const rgbClose = (a: [number, number, number], b: [number, number, number], tol = 25): boolean =>
  a.every((c, i) => Math.abs(c - b[i]) <= tol)

test('effects: transitions, title, color board, inspector binding', async () => {
  test.setTimeout(300_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-effects-'))
  const app = await launchApp(join(tempRoot, 'Effects.mglib'))
  const page = await app.firstWindow()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [
      join(FIXTURES, 'bars-1080p30.mp4'),
      join(FIXTURES, 'red-720p25.mp4'),
      join(FIXTURES, 'green-prores.mov')
    ]
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- spine: bars(10s) | red(8s) | green(4s) ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-red-720p25.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-green-prores.mov').click()
  await page.keyboard.press('e')
  for (let i = 0; i < 6; i++) await page.keyboard.press('-')
  await page.keyboard.press('n') // snapping off: pixel-driven trims
  await page.keyboard.press('s') // skimming off: stills follow ONLY the playhead
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  const [, redId] = state.sequence!.spine.map((item) => item.id)

  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const rulerY = bounds.y + 10
  const spineY = bounds.y + 26 + 4 + 36 + 24
  const zoom = state.zoomPxPerSec
  const xAt = (sec: number): number => bounds.x + sec * zoom

  // ---- handles for the red|green cut: red tail −2s, green head +1s ----
  const redGreenCut = 18
  await page.mouse.move(xAt(redGreenCut) - 2, spineY)
  await page.mouse.down()
  await page.mouse.move(xAt(redGreenCut) - 2 - 2 * zoom, spineY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  const cutSec =
    state.sequence!.spine.slice(0, 2).reduce((sum, item) => sum + item.durationFlicks, 0) /
    FLICKS_PER_SECOND
  await page.mouse.move(xAt(cutSec) + 2, spineY)
  await page.mouse.down()
  await page.mouse.move(xAt(cutSec) + 2 + 1 * zoom, spineY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  const green = state.sequence!.spine[2]
  expect(green.kind === 'clip' && green.mediaInFlicks > 0).toBe(true) // head handle exists

  // ---- Ctrl+T: default 1 s dissolve at the edit point nearest the playhead ----
  await page.mouse.click(xAt(cutSec), rulerY)
  await page.keyboard.press('Control+t')
  state = await getState(page)
  expect(state.sequence!.transitions).toHaveLength(1)
  const transition = state.sequence!.transitions![0]
  expect(transition.kind).toBe('dissolve')
  expect(transition.afterClipId).toBe(redId)
  expect(transition.durationFlicks).toBeLessThanOrEqual(FLICKS_PER_SECOND)
  console.log(
    `Ctrl+T added: kind=${transition.kind} duration=${transition.durationFlicks / FLICKS_PER_SECOND}s after=${transition.afterClipId === redId ? 'red' : '?'}`
  )

  // ---- pure A/B anchors (uniform-color fixtures: exact blend math) ----
  const settle = async (): Promise<void> => {
    await page.waitForTimeout(600)
  }
  await page.mouse.click(xAt(cutSec - 0.8), rulerY)
  await expect(page.getByTestId('sequence-canvas')).toBeVisible()
  await expect
    .poll(async () => (await sampleRgb(page, 958, 538))[0], { timeout: 30_000 })
    .toBeGreaterThan(200) // red side
  const redSample = await sampleRgb(page, 958, 538)
  await page.mouse.click(xAt(cutSec + 0.8), rulerY)
  await expect
    .poll(async () => (await sampleRgb(page, 958, 538))[1], { timeout: 60_000 })
    .toBeGreaterThan(80) // green side (via H.264 proxy)
  const greenSample = await sampleRgb(page, 958, 538)
  console.log(`anchors: red=${redSample.join(',')} green=${greenSample.join(',')}`)

  // ---- dissolve mid-point: exactly the average of both sides ----
  const expectedMid: [number, number, number] = [
    Math.round((redSample[0] + greenSample[0]) / 2),
    Math.round((redSample[1] + greenSample[1]) / 2),
    Math.round((redSample[2] + greenSample[2]) / 2)
  ]
  await page.mouse.click(xAt(cutSec), rulerY)
  await expect
    .poll(async () => rgbClose(await sampleRgb(page, 958, 538), expectedMid), {
      timeout: 30_000
    })
    .toBe(true)
  const midSample = await sampleRgb(page, 958, 538)
  console.log(
    `dissolve mid: got=${midSample.join(',')} expected≈${expectedMid.join(',')} (±25/ch) — neither pure A ${redSample.join(',')} nor pure B ${greenSample.join(',')}`
  )
  await page.screenshot({ path: join(EVIDENCE, 'transition.png') })

  // ---- wipeL at p=0.5: left half = B (green), right half = A (red) ----
  const badgeX = xAt(cutSec)
  const badgeY = bounds.y + 26 + 4 + 36 + 2 + 7 // spineY + 2 + h/2
  await page.mouse.click(badgeX, badgeY, { button: 'right' }) // dissolve → wipeL
  await settle()
  await expect
    .poll(async () => (await sampleRgb(page, 480, 540))[1], { timeout: 15_000 })
    .toBeGreaterThan(80)
  expect((await sampleRgb(page, 1440, 540))[0]).toBeGreaterThan(200)
  console.log(
    `wipeL p=0.5: left(480,540)=${(await sampleRgb(page, 480, 540)).join(',')} right(1440,540)=${(await sampleRgb(page, 1440, 540)).join(',')}`
  )

  // ---- wipeR at p=0.5: right half = B (green), left half = A (red) ----
  await page.mouse.click(badgeX, badgeY, { button: 'right' }) // wipeL → wipeR
  await settle()
  await expect
    .poll(async () => (await sampleRgb(page, 1440, 540))[1], { timeout: 15_000 })
    .toBeGreaterThan(80)
  expect((await sampleRgb(page, 480, 540))[0]).toBeGreaterThan(200)
  console.log(
    `wipeR p=0.5: right(1440,540)=${(await sampleRgb(page, 1440, 540)).join(',')} left(480,540)=${(await sampleRgb(page, 480, 540)).join(',')}`
  )

  // ---- fadeBlack at p=0.5: black frame ----
  await page.mouse.click(badgeX, badgeY, { button: 'right' }) // wipeR → fadeBlack
  await settle()
  await expect
    .poll(
      async () => {
        const rgb = await sampleRgb(page, 958, 538)
        return rgb[0] <= 25 && rgb[1] <= 25 && rgb[2] <= 25
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  console.log(`fadeBlack p=0.5: center=${(await sampleRgb(page, 958, 538)).join(',')} (≤25/ch)`)

  // ---- title over bars: bright-pixel diff vs no-title baseline ----
  await page.mouse.click(xAt(3), rulerY) // playhead at 3 s (bars clip)
  await settle()
  const beforeTitle = await countBright(page, 660, 460, 600, 160)
  await page.getByTestId('title-preset-basic').dblclick()
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(1)
  const titleId = state.sequence!.connected[0].id
  await page.mouse.click(xAt(3.2), rulerY) // re-render with the title active
  await expect
    .poll(async () => countBright(page, 660, 460, 600, 160), { timeout: 20_000 })
    .toBeGreaterThan(beforeTitle + 500)
  const afterTitle = await countBright(page, 660, 460, 600, 160)
  console.log(`title diff: bright pixels in text region ${beforeTitle} → ${afterTitle}`)
  await page.screenshot({ path: join(EVIDENCE, 'title.png') })

  // ---- inspector binds to selection: title tab live-updates ----
  const laneY = bounds.y + 26 + 4 + 16
  await page.mouse.click(xAt(3.5), laneY) // select the title's connected clip
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([titleId])
  await page.getByTestId('inspector-tab-title').click()
  await page.getByTestId('title-color').fill('#ff00ff')
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hooks = window as unknown as {
            __magneticTimeline: {
              playback: { readPixels(x: number, y: number, w: number, h: number): number[] }
            }
          }
          const data = hooks.__magneticTimeline.playback.readPixels(660, 460, 600, 160)
          let magenta = 0
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] > 200) magenta++
          }
          return magenta
        }),
      { timeout: 20_000 }
    )
    .toBeGreaterThan(200)
  console.log('inspector live: title color → magenta pixels rendered')

  // ---- color board on the uniform red clip (deterministic at any time) ----
  await page.mouse.click(xAt(12), rulerY) // red clip, outside the transition window
  await settle()
  await page.mouse.click(xAt(12), spineY) // select the red spine clip
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([redId])
  await page.getByTestId('inspector-tab-color').click()
  const centerBefore = await sampleRgb(page, 958, 538) // (255,24,0)-ish
  await page.getByTestId('fx-exposure').fill('1')
  // exposure +1 = ×2 linear gain: G doubles (R already clamps at 255)
  await expect
    .poll(async () => (await sampleRgb(page, 958, 538))[1], { timeout: 15_000 })
    .toBeGreaterThan(centerBefore[1] + 15)
  const brightened = await sampleRgb(page, 958, 538)
  console.log(`exposure +1 on red: ${centerBefore.join(',')} → ${brightened.join(',')}`)
  await page.getByTestId('color-reset').click()
  await expect
    .poll(async () => rgbClose(await sampleRgb(page, 958, 538), centerBefore, 15), {
      timeout: 15_000
    })
    .toBe(true)

  // saturation 0 turns pure red into its luma gray: R≈G≈B within ±6
  await page.getByTestId('fx-saturation').fill('0')
  await expect
    .poll(
      async () => {
        const rgb = await sampleRgb(page, 958, 538)
        return Math.max(...rgb) - Math.min(...rgb)
      },
      { timeout: 15_000 }
    )
    .toBeLessThanOrEqual(6)
  const grayed = await sampleRgb(page, 958, 538)
  console.log(`saturation 0 on red: → ${grayed.join(',')} (span ≤ 6)`)
  await page.screenshot({ path: join(EVIDENCE, 'inspector.png') })

  expect(pageErrors).toEqual([])
  await app.close()
})
