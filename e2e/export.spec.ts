import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-9')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const FFPROBE = join(ROOT, 'resources', 'bin', 'ffprobe.exe')
const FLICKS_PER_SECOND = 705_600_000
const FRAME_FLICKS = FLICKS_PER_SECOND / 30

interface ExportTestState {
  sequence: Sequence | null
  playheadFlicks: number
  zoomPxPerSec: number
}

/** Grid of sample points used for the WYSIWYG comparison (sequence space). */
const GRID: [number, number][] = []
for (const y of [135, 540, 945]) {
  for (const x of [160, 480, 960, 1440, 1760]) GRID.push([x, y])
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<ExportTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): ExportTestState }).__magneticState()
  )
}

/** 4×4 average RGB at each grid point from the live compositor. */
async function sampleGrid(page: Page): Promise<[number, number, number][]> {
  return page.evaluate((grid) => {
    const hooks = window as unknown as {
      __magneticTimeline: {
        playback: { readPixels(x: number, y: number, w: number, h: number): number[] }
      }
    }
    return grid.map(([x, y]) => {
      const data = hooks.__magneticTimeline.playback.readPixels(x, y, 4, 4)
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
      }
      const n = data.length / 4
      return [r / n, g / n, b / n] as [number, number, number]
    })
  }, GRID)
}

test('export: WYSIWYG mp4 with audio, progress, cancel, error surfaces', async () => {
  test.setTimeout(420_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-export-e2e-'))
  const outDir = mkdtempSync(join(tmpdir(), 'magnetic-export-out-'))
  const destination = join(outDir, 'out.mp4')
  const app = await launchApp(join(tempRoot, 'Export.mglib'))
  const page = await app.firstWindow()

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

  // ---- 5 s sequence: bars(→2s) | red(→2s, head-trimmed) | green(→1s) ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-red-720p25.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-green-prores.mov').click()
  await page.keyboard.press('e')
  for (let i = 0; i < 4; i++) await page.keyboard.press('-')
  await page.keyboard.press('n')
  await page.keyboard.press('s')
  let state = await getState(page)
  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const rulerY = bounds.y + 10
  const spineY = bounds.y + 26 + 4 + 36 + 24
  const zoom = state.zoomPxPerSec
  const xAt = (sec: number): number => bounds.x + sec * zoom
  const dragTail = async (fromSec: number, toSec: number): Promise<void> => {
    // grab 4px left of the boundary: integer mouse rounding at -2px can land
    // ON the boundary and grab the next clip's HEAD instead (observed flake)
    await page.mouse.move(xAt(fromSec) - 4, spineY)
    await page.mouse.down()
    await page.mouse.move(xAt(toSec), spineY, { steps: 8 })
    await page.mouse.up()
  }
  const logDurations = async (label: string): Promise<void> => {
    const current = await getState(page)
    console.log(
      `${label}: [${current
        .sequence!.spine.map((item) => (item.durationFlicks / FLICKS_PER_SECOND).toFixed(2))
        .join(', ')}]`
    )
  }
  // bars 10s → ~2s
  await dragTail(10, 2)
  await logDurations('after bars tail trim')
  state = await getState(page)
  let cut1 = state.sequence!.spine[0].durationFlicks / FLICKS_PER_SECOND
  // red head +1s (handle for the dissolve), then tail → ~2s
  await page.mouse.move(xAt(cut1) + 2, spineY)
  await page.mouse.down()
  await page.mouse.move(xAt(cut1) + 2 + zoom, spineY, { steps: 6 })
  await page.mouse.up()
  await logDurations('after red head trim')
  state = await getState(page)
  cut1 = state.sequence!.spine[0].durationFlicks / FLICKS_PER_SECOND
  const redEnd = cut1 + state.sequence!.spine[1].durationFlicks / FLICKS_PER_SECOND
  await dragTail(redEnd, cut1 + 2)
  await logDurations('after red tail trim')
  state = await getState(page)
  const cut2 =
    state.sequence!.spine.slice(0, 2).reduce((sum, item) => sum + item.durationFlicks, 0) /
    FLICKS_PER_SECOND
  const greenEnd = cut2 + state.sequence!.spine[2].durationFlicks / FLICKS_PER_SECOND
  await dragTail(greenEnd, cut2 + 1)
  await logDurations('after green tail trim')
  state = await getState(page)
  const totalFlicks = state.sequence!.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
  console.log(`sequence built: ${(totalFlicks / FLICKS_PER_SECOND).toFixed(3)} s, 3 clips`)

  // dissolve at cut1 + title over the red clip
  await page.mouse.click(xAt(cut1), rulerY)
  await page.keyboard.press('Control+t')
  state = await getState(page)
  expect(state.sequence!.transitions).toHaveLength(1)
  await page.mouse.click(xAt(cut1 + 1), rulerY)
  await page.getByTestId('title-preset-lowerThird').dblclick()
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(1)

  // ---- live WYSIWYG reference frame at t=1 s (bars clip) ----
  await page.mouse.click(xAt(1), rulerY)
  await expect(page.getByTestId('sequence-canvas')).toBeVisible()
  await page.waitForTimeout(1200) // paused still settles
  const liveGrid = await sampleGrid(page)
  state = await getState(page)
  const wysiwygFrame = Math.ceil(state.playheadFlicks / FRAME_FLICKS - 1e-9)
  console.log(`live reference frame n=${wysiwygFrame} at playhead ${state.playheadFlicks}`)

  // ---- export via the dialog ----
  await page.keyboard.press('Control+e')
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  page.on('pageerror', (error) => console.log(`PAGEERROR: ${String(error)}`))
  await page.getByTestId('export-destination').fill(destination)
  await page.getByTestId('export-start').click()
  setTimeout(() => {
    void page
      .getByTestId('export-dialog')
      .innerText()
      .then((text) => console.log(`dialog after 12s: ${text.replace(/\s+/g, ' ')}`))
      .catch(() => undefined)
  }, 12_000)
  const progressSamples: number[] = []
  await expect
    .poll(
      async () => {
        const errorBox = page.getByTestId('export-error')
        if ((await errorBox.count()) > 0) {
          throw new Error(`export surfaced an error: ${await errorBox.innerText()}`)
        }
        const progress = page.getByTestId('export-progress')
        if ((await progress.count()) > 0) {
          const text = await progress.innerText()
          const done = Number(text.split('/')[0].trim())
          if (Number.isFinite(done)) progressSamples.push(done)
          if (progressSamples.length === 3) {
            await page.screenshot({ path: join(EVIDENCE, 'export.png') })
          }
        }
        return (await page.getByTestId('export-success').count()) > 0
      },
      { timeout: 180_000, intervals: [250] }
    )
    .toBe(true)
  for (let i = 1; i < progressSamples.length; i++) {
    expect(progressSamples[i]).toBeGreaterThanOrEqual(progressSamples[i - 1])
  }
  expect(progressSamples.length).toBeGreaterThan(1)
  expect(progressSamples[progressSamples.length - 1]).toBeGreaterThan(0)
  console.log(`progress samples (frames done): ${progressSamples.join(' → ')}`)
  expect(existsSync(destination)).toBe(true)
  expect(existsSync(`${destination}.part`)).toBe(false)
  await page.getByTestId('export-close').click()

  // ---- ffprobe: streams, resolution, fps, duration ±1 frame ----
  const probe = JSON.parse(
    execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', destination],
      { encoding: 'utf8' }
    )
  ) as {
    format: { duration: string }
    streams: {
      codec_type: string
      codec_name: string
      width?: number
      height?: number
      r_frame_rate?: string
    }[]
  }
  console.log(`ffprobe: ${JSON.stringify(probe, null, 1)}`)
  const video = probe.streams.find((s) => s.codec_type === 'video')!
  const audio = probe.streams.find((s) => s.codec_type === 'audio')!
  expect(video.codec_name).toBe('h264')
  expect(audio.codec_name).toBe('aac')
  expect(video.width).toBe(1920)
  expect(video.height).toBe(1080)
  expect(video.r_frame_rate).toBe('30/1')
  const expectedSec = (Math.ceil(totalFlicks / FRAME_FLICKS) * FRAME_FLICKS) / FLICKS_PER_SECOND
  expect(Math.abs(Number(probe.format.duration) - expectedSec)).toBeLessThanOrEqual(1 / 30 + 0.05)

  // ---- audio present and non-silent (volumedetect reports on stderr) ----
  const probeRun = spawnSync(
    FFMPEG,
    ['-i', destination, '-af', 'volumedetect', '-f', 'null', 'NUL'],
    { encoding: 'utf8' }
  )
  const stderrProbe = `${probeRun.stdout ?? ''}${probeRun.stderr ?? ''}`
  const meanMatch = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderrProbe)
  expect(meanMatch).not.toBeNull()
  const meanVolume = Number(meanMatch![1])
  console.log(`volumedetect mean_volume = ${meanVolume} dB`)
  expect(meanVolume).toBeGreaterThan(-70)

  // ---- WYSIWYG: extract the same frame from the export, compare the grid ----
  const rawPath = join(outDir, 'frame.raw')
  execFileSync(
    FFMPEG,
    [
      '-y',
      '-i',
      destination,
      '-vf',
      `select=eq(n\\,${wysiwygFrame})`,
      '-vsync',
      '0',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      rawPath
    ],
    { stdio: 'ignore' }
  )
  const raw = readFileSync(rawPath)
  expect(raw.length).toBe(1920 * 1080 * 4)
  let totalDiff = 0
  let samples = 0
  for (let p = 0; p < GRID.length; p++) {
    const [gx, gy] = GRID[p]
    let r = 0
    let g = 0
    let b = 0
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const offset = ((gy + dy) * 1920 + gx + dx) * 4
        r += raw[offset]
        g += raw[offset + 1]
        b += raw[offset + 2]
      }
    }
    const exported: [number, number, number] = [r / 16, g / 16, b / 16]
    const live = liveGrid[p]
    totalDiff +=
      Math.abs(exported[0] - live[0]) +
      Math.abs(exported[1] - live[1]) +
      Math.abs(exported[2] - live[2])
    samples += 3
  }
  const meanDiff = totalDiff / samples
  console.log(
    `WYSIWYG: mean abs per-channel diff over ${GRID.length} grid points = ${meanDiff.toFixed(2)}/255 (tolerance 8; veryfast preset under MAGNETIC_TEST)`
  )
  expect(meanDiff).toBeLessThanOrEqual(8)

  // ---- cancel mid-export: no destination, no .part ----
  const destination2 = join(outDir, 'cancelled.mp4')
  await page.keyboard.press('Control+e')
  await page.getByTestId('export-destination').fill(destination2)
  await page.getByTestId('export-start').click()
  await expect
    .poll(async () => {
      const progress = page.getByTestId('export-progress')
      if ((await progress.count()) === 0) return 0
      return Number((await progress.innerText()).split('/')[0].trim())
    })
    .toBeGreaterThan(3)
  await page.getByTestId('export-cancel').click()
  await expect(page.getByTestId('export-dialog')).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(800)
  expect(existsSync(destination2)).toBe(false)
  expect(existsSync(`${destination2}.part`)).toBe(false)
  console.log('cancel: ffmpeg terminated, no destination, no .part')

  // ---- locked destination surfaces a readable error, not a crash ----
  const destination3 = join(outDir, 'locked.mp4')
  mkdirSync(`${destination3}.part`) // a directory where ffmpeg wants its output file
  await page.keyboard.press('Control+e')
  await page.getByTestId('export-destination').fill(destination3)
  await page.getByTestId('export-start').click()
  await expect(page.getByTestId('export-error')).toBeVisible({ timeout: 60_000 })
  const errorText = await page.getByTestId('export-error').innerText()
  console.log(`error surfaced: ${errorText.slice(0, 140)}`)
  await page.getByTestId('export-close').click()

  await app.close()
})
