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
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-7')
const FLICKS_PER_SECOND = 705_600_000

interface PlaybackTestState {
  sequence: Sequence | null
  selection: { clipIds: string[] }
  playheadFlicks: number
  zoomPxPerSec: number
  isSequencePlaying?: boolean
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<PlaybackTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): PlaybackTestState }).__magneticState()
  )
}

/** 4×4 average RGB at top-left-origin sequence coordinates (1920×1080 space). */
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

const isRed = (rgb: [number, number, number]): boolean => rgb[0] > 200 && rgb[1] < 40 && rgb[2] < 40
const isGreen = (rgb: [number, number, number]): boolean =>
  rgb[1] > 80 && rgb[0] < 50 && rgb[2] < 50

test('sequence playback: cuts, scrub pixels, overlay, transforms, drift, stability, proxy', async () => {
  test.setTimeout(420_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-playback-'))
  const app = await launchApp(join(tempRoot, 'Playback.mglib'))
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

  // ---- sequence: bars(10s) | red(8s) | bars(10s) | bars(10s) = 38 s, cuts at 10/18/28 ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-red-720p25.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(4)
  for (let i = 0; i < 6; i++) await page.keyboard.press('-')
  state = await getState(page)

  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const rulerY = bounds.y + 10
  const xForTime = (sec: number): number =>
    bounds.x + (sec * FLICKS_PER_SECOND * state.zoomPxPerSec) / FLICKS_PER_SECOND

  // ---- scrub: red spine clip at 14 s shows pure red ----
  await page.mouse.click(xForTime(14), rulerY)
  await expect(page.getByTestId('sequence-canvas')).toBeVisible()
  await expect
    .poll(async () => isRed(await sampleRgb(page, 958, 538)), { timeout: 30_000 })
    .toBe(true)
  const redSample = await sampleRgb(page, 958, 538)
  console.log(`scrub @14s (red spine clip) center RGB = ${redSample.join(',')}`)

  // ---- scrub: bars clip at 9 s differs strongly from red ----
  await page.mouse.click(xForTime(9), rulerY)
  await expect
    .poll(async () => isRed(await sampleRgb(page, 958, 538)), { timeout: 30_000 })
    .toBe(false)
  const barsSample = await sampleRgb(page, 958, 538)
  const distance =
    Math.abs(barsSample[0] - redSample[0]) +
    Math.abs(barsSample[1] - redSample[1]) +
    Math.abs(barsSample[2] - redSample[2])
  expect(distance).toBeGreaterThan(60)
  console.log(`scrub @9s (bars clip) center RGB = ${barsSample.join(',')} (Δ vs red = ${distance})`)

  // ---- baseline: bare spine pixels at t=5 s (testsrc2 content, captured for
  //      exact-match comparison once the overlay's transform reveals them) ----
  const stableSample = async (x: number, y: number): Promise<[number, number, number]> => {
    let previous: [number, number, number] = [-2, -2, -2]
    await expect
      .poll(
        async () => {
          const current = await sampleRgb(page, x, y)
          const stable = current[0] >= 0 && current.every((c, i) => Math.abs(c - previous[i]) <= 2)
          previous = current
          return stable
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    return previous
  }
  const rgbClose = (
    a: [number, number, number],
    b: [number, number, number],
    tolerance = 15
  ): boolean => a.every((c, i) => Math.abs(c - b[i]) <= tolerance)

  await page.mouse.click(xForTime(5), rulerY)
  const baselineCorner = await stableSample(200, 150)
  const baselineLeft = await stableSample(700, 540)

  // ---- connected overlay: red composites above the spine at 5 s ----
  await page.keyboard.press('Home')
  await page.getByTestId('asset-cell-red-720p25.mp4').click()
  await page.keyboard.press('q')
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(1)
  const connectedId = state.sequence!.connected[0].id
  await page.mouse.click(xForTime(5), rulerY)
  await expect
    .poll(async () => isRed(await sampleRgb(page, 958, 538)), { timeout: 30_000 })
    .toBe(true)
  // overlay (1280×720 fitted to 1920×1080) covers the corner too
  await expect
    .poll(async () => isRed(await sampleRgb(page, 200, 150)), { timeout: 15_000 })
    .toBe(true)
  console.log(
    `overlay @5s: center=${(await sampleRgb(page, 958, 538)).join(',')} (red above bars spine)`
  )

  // ---- transform: scale 50% reveals the exact spine pixels at the corner ----
  const laneCenterY = bounds.y + 26 + 4 + 16 // first video lane row
  await page.mouse.click(xForTime(4), laneCenterY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([connectedId])
  await expect(page.getByTestId('fx-scale')).toBeVisible()
  await page.getByTestId('fx-scale').fill('50')
  await expect
    .poll(async () => isRed(await sampleRgb(page, 958, 538)), { timeout: 15_000 })
    .toBe(true) // center still red (scaled overlay covers it)
  await expect
    .poll(async () => rgbClose(await sampleRgb(page, 200, 150), baselineCorner), {
      timeout: 15_000
    })
    .toBe(true) // corner = exact bare-spine pixels again
  console.log(
    `transform scale50: center=${(await sampleRgb(page, 958, 538)).join(',')} corner=${(await sampleRgb(page, 200, 150)).join(',')} (baseline ${baselineCorner.join(',')})`
  )

  // ---- reposition: overlay shifts right; left half shows spine, right half red ----
  await page.getByTestId('fx-posX').fill('480')
  await expect
    .poll(async () => isRed(await sampleRgb(page, 1500, 540)), { timeout: 15_000 })
    .toBe(true) // overlay now occupies [960,1920]
  await expect
    .poll(async () => rgbClose(await sampleRgb(page, 700, 540), baselineLeft), {
      timeout: 15_000
    })
    .toBe(true) // (700,540) left the overlay → exact spine pixels
  console.log(
    `transform posX480: right=${(await sampleRgb(page, 1500, 540)).join(',')} left=${(await sampleRgb(page, 700, 540)).join(',')} (baseline ${baselineLeft.join(',')})`
  )
  // restore default transform (undo the two fx ops)
  await page.evaluate(() =>
    (
      window as unknown as { __magneticTimeline: { undoTimes(n: number): number } }
    ).__magneticTimeline.undoTimes(2)
  )

  // evidence screenshot: composited still with overlay
  await page.mouse.click(xForTime(5), rulerY)
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(EVIDENCE, 'playback.png') })

  // ---- play end-to-end across all cuts; playhead monotonic; drift < 50 ms ----
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('sequence-playing')).toHaveText('playing')
  // audio is audibly playing (bars sine) — RMS above silence
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hooks = window as unknown as {
            __magneticTimeline: { playback: { rms(): number } }
          }
          return hooks.__magneticTimeline.playback.rms()
        }),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0.005)
  const samples: number[] = []
  const totalFlicks = 38 * FLICKS_PER_SECOND
  for (let i = 0; i < 150; i++) {
    state = await getState(page)
    samples.push(state.playheadFlicks)
    if (state.isSequencePlaying === false && samples.length > 5) break
    await page.waitForTimeout(400)
  }
  // monotonically non-decreasing playhead, played through to the end
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1])
  }
  expect(samples[samples.length - 1]).toBeGreaterThan(totalFlicks - FLICKS_PER_SECOND)
  expect(samples.some((value) => value > 10 * FLICKS_PER_SECOND)).toBe(true) // crossed cut 1
  expect(samples.some((value) => value > 18 * FLICKS_PER_SECOND)).toBe(true) // crossed cut 2
  expect(samples.some((value) => value > 28 * FLICKS_PER_SECOND)).toBe(true) // crossed cut 3
  console.log(
    `playback: ${samples.length} samples, monotonic, finished at ${(samples[samples.length - 1] / FLICKS_PER_SECOND).toFixed(2)}s of ${totalFlicks / FLICKS_PER_SECOND}s`
  )

  const drift = await page.evaluate(() => {
    const hooks = window as unknown as {
      __magneticTimeline: {
        playback: { drift(): { samples: { atSec: number; driftMs: number }[]; maxAbsMs: number } }
      }
    }
    return hooks.__magneticTimeline.playback.drift()
  })
  console.log(
    `drift series (s→ms): ${drift.samples.map((sample) => `${sample.atSec}:${sample.driftMs}`).join(' ')}`
  )
  console.log(`max |drift| = ${drift.maxAbsMs} ms over ${drift.samples.length} samples`)
  expect(drift.samples.length).toBeGreaterThanOrEqual(30)
  expect(drift.maxAbsMs).toBeLessThan(50)

  // paused → silent (analyser RMS)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hooks = window as unknown as {
            __magneticTimeline: { playback: { rms(): number } }
          }
          return hooks.__magneticTimeline.playback.rms()
        }),
      { timeout: 10_000 }
    )
    .toBeLessThan(0.005)

  // ---- pause/resume/seek 20×: stable, no crash, memory steady ----
  const memoryBefore = await page.evaluate(() => window.api.diagMemory())
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Space') // play
    await page.waitForTimeout(180)
    await page.keyboard.press('Space') // pause
    await page.mouse.click(xForTime(3 + (i % 5) * 6), rulerY) // seek
    await page.waitForTimeout(120)
  }
  const memoryAfter = await page.evaluate(() => window.api.diagMemory())
  const rssRatio = memoryAfter.rss / memoryBefore.rss
  console.log(
    `memory rss: before=${(memoryBefore.rss / 1e6).toFixed(1)}MB after=${(memoryAfter.rss / 1e6).toFixed(1)}MB ratio=${rssRatio.toFixed(3)}`
  )
  expect(rssRatio).toBeGreaterThan(0.8)
  expect(rssRatio).toBeLessThan(1.2)
  expect(pageErrors).toEqual([])

  // ---- proxy fallback: ProRes asset transcodes to H.264 and still plays ----
  await page.keyboard.press('End')
  await page.getByTestId('asset-cell-green-prores.mov').click()
  await page.keyboard.press('e')
  state = await getState(page)
  const greenStartSec =
    state.sequence!.spine.slice(0, -1).reduce((sum, item) => sum + item.durationFlicks, 0) /
    FLICKS_PER_SECOND
  await page.mouse.click(xForTime(greenStartSec + 2), rulerY)
  await expect
    .poll(async () => isGreen(await sampleRgb(page, 958, 538)), { timeout: 60_000 })
    .toBe(true)
  console.log(
    `proxy fallback: green ProRes frame via H.264 proxy, center RGB = ${(await sampleRgb(page, 958, 538)).join(',')}`
  )
  await expect(page.getByTestId('asset-proxy')).toBeVisible({ timeout: 15_000 })
  expect(pageErrors).toEqual([])

  await app.close()
})
