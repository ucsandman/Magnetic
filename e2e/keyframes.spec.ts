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
import type { Clip, Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000

interface KeyframesTestState {
  sequence: Sequence | null
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

function getState(page: Page): Promise<KeyframesTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): KeyframesTestState }).__magneticState()
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

const isBlack = (rgb: [number, number, number]): boolean => rgb.every((c) => c <= 25)

test('keyframes: scale + opacity animate between keyframes, undo reverts', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-keyframes-'))
  const app = await launchApp(join(tempRoot, 'Keyframes.mglib'))
  const page = await app.firstWindow()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'green-prores.mov')]
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- spine: green (4 s, fills the 1080p frame at scale 100) ----
  await page.getByTestId('asset-cell-green-prores.mov').click()
  await page.keyboard.press('e')
  await page.keyboard.press('s') // skimming off: stills follow ONLY the playhead
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  const clipId = state.sequence!.spine[0].id
  const greenClip = (): Clip => state.sequence!.spine[0] as Clip

  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const rulerY = bounds.y + 10
  const spineY = bounds.y + 26 + 4 + 36 + 24
  const zoom = state.zoomPxPerSec
  const xAt = (sec: number): number => bounds.x + sec * zoom

  // select the clip — the inspector's Video tab binds to it
  await page.mouse.click(xAt(1), spineY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([clipId])

  // ---- keyframe scale: 100 near 0 s, 40 near 4 s (media time) ----
  await page.mouse.click(xAt(0.05), rulerY)
  await page.getByTestId('kf-toggle-scale').click()
  state = await getState(page)
  expect(greenClip().fx?.kf?.scale).toHaveLength(1)
  expect(greenClip().fx!.kf!.scale![0].value).toBe(100)

  await page.mouse.click(xAt(3.95), rulerY)
  await page.getByTestId('fx-scale').fill('40')
  state = await getState(page)
  const scaleTrack = greenClip().fx!.kf!.scale!
  expect(scaleTrack).toHaveLength(2)
  expect(scaleTrack[1].value).toBe(40)
  console.log(
    `scale track: ${scaleTrack.map((k) => `${(k.atMediaFlicks / FLICKS_PER_SECOND).toFixed(2)}s=${k.value}`).join(' ')}`
  )

  // ---- pixel proof of animation (uniform green fixture, black letterbox) ----
  await expect(page.getByTestId('sequence-canvas')).toBeVisible()

  // t≈0: scale 100 — green fills the frame, corner included
  await page.mouse.click(xAt(0.05), rulerY)
  await expect
    .poll(async () => (await sampleRgb(page, 150, 150))[1], { timeout: 60_000 })
    .toBeGreaterThan(80)
  console.log(`t=0: corner(150,150)=${(await sampleRgb(page, 150, 150)).join(',')} (full frame)`)

  // t≈2: mid-scale (~70%) — corner letterboxed black, but (400,300) still green
  await page.mouse.click(xAt(2), rulerY)
  await expect
    .poll(async () => isBlack(await sampleRgb(page, 150, 150)), { timeout: 30_000 })
    .toBe(true)
  expect((await sampleRgb(page, 400, 300))[1]).toBeGreaterThan(80)
  console.log(
    `t=2: corner=${(await sampleRgb(page, 150, 150)).join(',')} inner(400,300)=${(await sampleRgb(page, 400, 300)).join(',')} — intermediate scale, not a step`
  )

  // t≈3.9: near-final scale (~40%) — (400,300) letterboxed too, centre still green
  await page.mouse.click(xAt(3.9), rulerY)
  await expect
    .poll(async () => isBlack(await sampleRgb(page, 400, 300)), { timeout: 30_000 })
    .toBe(true)
  expect((await sampleRgb(page, 958, 538))[1]).toBeGreaterThan(80)
  console.log(
    `t=3.9: inner(400,300)=${(await sampleRgb(page, 400, 300)).join(',')} centre=${(await sampleRgb(page, 958, 538)).join(',')}`
  )

  // ---- opacity: 100 near 0 s → 0 near 3.9 s — centre fades to black ----
  await page.mouse.click(xAt(0.05), rulerY)
  await page.getByTestId('kf-toggle-opacity').click()
  await page.mouse.click(xAt(3.9), rulerY)
  await page.getByTestId('fx-opacity').fill('0')
  await expect
    .poll(async () => isBlack(await sampleRgb(page, 958, 538)), { timeout: 30_000 })
    .toBe(true)
  await page.mouse.click(xAt(0.2), rulerY)
  await expect
    .poll(async () => (await sampleRgb(page, 958, 538))[1], { timeout: 30_000 })
    .toBeGreaterThan(80)
  console.log('opacity keyframes: centre black at t=3.9, green again at t=0.2')

  state = await getState(page)
  expect(greenClip().fx?.kf?.opacity).toHaveLength(2)

  // ---- undo: one Ctrl+Z reverts the last keyframe write ----
  await page.mouse.click(xAt(1), rulerY) // shortcuts suspend while an input has focus
  await page.keyboard.press('Control+z')
  state = await getState(page)
  expect(greenClip().fx?.kf?.opacity).toHaveLength(1)
  expect(greenClip().fx!.kf!.opacity![0].value).toBe(100)
  expect(greenClip().fx!.kf!.scale).toHaveLength(2) // scale track untouched
  console.log('undo: opacity track reverted to its single seed keyframe')

  expect(pageErrors).toEqual([])
  await app.close()
})
