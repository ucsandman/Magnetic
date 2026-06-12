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

interface TimelineTestState {
  sequence: Sequence | null
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
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
}

test('play affordances: placeholder ▶, Space plays the browser selection, sequence transport bar', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-ux-'))
  const app = await launchApp(join(tempRoot, 'Ux.mglib'))
  const page = await app.firstWindow()
  await importFixtures(page, ['bars-1080p30.mp4', 'red-720p25.mp4'])

  // ---- placeholder viewer: no selection -> ▶ disabled with a hint ----
  await expect(page.getByTestId('viewer-selected')).toHaveText(
    'No clip open — select or double-click a clip'
  )
  await expect(page.getByTestId('viewer-play-pause')).toBeDisabled()

  // ---- single click + placeholder ▶ opens and PLAYS the clip ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await expect(page.getByTestId('viewer-play-pause')).toBeEnabled()
  await page.getByTestId('viewer-play-pause').click()
  await expect(page.getByTestId('viewer-video')).toBeVisible()
  await expect
    .poll(async () => page.getByTestId('viewer-timecode').innerText(), { timeout: 20_000 })
    .not.toBe('00:00:00:00')

  // ---- viewer go-to-start button rewinds to frame 0 ----
  await page.keyboard.press('k') // pause
  await page.getByTestId('viewer-go-start').click()
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:00')

  // ---- Home/End in the focused viewer ----
  await page.keyboard.press('End')
  await expect
    .poll(() => page.getByTestId('viewer-timecode').innerText(), { timeout: 10_000 })
    .not.toBe('00:00:00:00')
  await page.keyboard.press('Home')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:00')

  // ---- Space in the browser with an EMPTY timeline plays the selection ----
  await page.keyboard.press('Escape') // focus back to the browser
  await page.keyboard.press(' ')
  await expect
    .poll(() => page.getByTestId('viewer-timecode').innerText(), { timeout: 20_000 })
    .not.toBe('00:00:00:00')
  await page.keyboard.press('k')

  // ---- build a 2-clip sequence; the sequence viewer has a transport bar ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-red-720p25.mp4').click()
  await page.keyboard.press('e')
  await page.keyboard.press(' ') // play the sequence (browser focus)
  await expect(page.getByTestId('viewer-mode')).toHaveText('sequence')
  await expect(page.getByTestId('sequence-playing')).toHaveText('playing')

  // ---- ⏸ button pauses, ▶ resumes, ⇤ goes back to the start ----
  await page.getByTestId('sequence-play-pause').click()
  await expect(page.getByTestId('sequence-playing')).toHaveText('paused')
  await page.getByTestId('sequence-go-start').click()
  await expect(page.getByTestId('sequence-timecode')).toHaveText('00:00:00:00')

  // ---- next/prev edit buttons land on the cut (10 s at 30 fps) ----
  await page.getByTestId('sequence-next-edit').click()
  await expect(page.getByTestId('sequence-timecode')).toHaveText('00:00:10:00')
  await page.getByTestId('sequence-next-edit').click() // sequence end (10s + 8s)
  await expect(page.getByTestId('sequence-timecode')).toHaveText('00:00:18:00')
  await page.getByTestId('sequence-prev-edit').click()
  await expect(page.getByTestId('sequence-timecode')).toHaveText('00:00:10:00')

  // ---- Up/Down arrows do the same from the timeline ----
  await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 8 } })
  await page.keyboard.press('ArrowDown')
  const afterDown = await getState(page)
  expect(afterDown.playheadFlicks).toBeGreaterThan(0)
  await page.keyboard.press('ArrowUp')
  const afterUp = await getState(page)
  expect(afterUp.playheadFlicks).toBeLessThan(afterDown.playheadFlicks)

  await app.close()
})

test('review grid: watch two clips at once, solo audio, promote to viewer', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-ux-grid-'))
  const app = await launchApp(join(tempRoot, 'UxGrid.mglib'))
  const page = await app.firstWindow()
  await importFixtures(page, ['bars-1080p30.mp4', 'red-720p25.mp4'])

  // select both clips (click + shift-click), open the grid
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.getByTestId('asset-cell-red-720p25.mp4').click({ modifiers: ['Shift'] })
  await page.getByTestId('browser-grid-preview').click()
  await expect(page.getByTestId('viewer-mode')).toHaveText('grid')

  // both cells render videos and play (muted)
  const barsCell = page.getByTestId('grid-cell-bars-1080p30.mp4')
  const redCell = page.getByTestId('grid-cell-red-720p25.mp4')
  await expect(barsCell.locator('video')).toBeVisible()
  await expect(redCell.locator('video')).toBeVisible()
  await expect
    .poll(
      () =>
        barsCell.locator('video').evaluate((el) => {
          const video = el as HTMLVideoElement
          return video.currentTime > 0 && !video.paused
        }),
      { timeout: 20_000 }
    )
    .toBe(true)

  // click solos the cell's audio
  await barsCell.click()
  await expect(barsCell.getByTestId('grid-cell-audio')).toBeVisible()
  expect(await barsCell.locator('video').evaluate((el) => (el as HTMLVideoElement).muted)).toBe(
    false
  )
  expect(await redCell.locator('video').evaluate((el) => (el as HTMLVideoElement).muted)).toBe(true)

  // pause-all stops both
  await page.getByTestId('grid-play-pause').click()
  expect(await redCell.locator('video').evaluate((el) => (el as HTMLVideoElement).paused)).toBe(
    true
  )

  // double-click promotes the clip into the source viewer
  await redCell.dblclick()
  await expect(page.getByTestId('viewer-video')).toBeVisible()
  await expect(page.getByTestId('viewer-duration')).toHaveText('00:00:08:00')

  await app.close()
})

test('layout: splitter drag resizes the browser, Reset Layout restores defaults, Shift+Z fits', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-ux-layout-'))
  const app = await launchApp(join(tempRoot, 'UxLayout.mglib'))
  const page = await app.firstWindow()
  await importFixtures(page, ['bars-1080p30.mp4'])

  const browserWidth = async (): Promise<number> =>
    (await page.getByTestId('panel-browser').boundingBox())!.width

  expect(Math.round(await browserWidth())).toBe(340)
  await expect(page.getByTestId('reset-layout')).toBeDisabled()

  // drag the browser splitter 80px right
  const splitter = (await page.getByTestId('splitter-browser').boundingBox())!
  const startX = splitter.x + splitter.width / 2
  const startY = splitter.y + splitter.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 80, startY, { steps: 8 })
  await page.mouse.up()
  expect(Math.round(await browserWidth())).toBe(420)

  // reset restores the default width and disables itself again
  await page.getByTestId('reset-layout').click()
  expect(Math.round(await browserWidth())).toBe(340)
  await expect(page.getByTestId('reset-layout')).toBeDisabled()

  // ---- Shift+Z zooms the timeline to fit the sequence ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  for (let i = 0; i < 8; i++) await page.keyboard.press('=') // zoom far in
  const zoomedIn = await getState(page)
  await page.keyboard.press('Shift+z')
  const fitted = await getState(page)
  expect(fitted.zoomPxPerSec).toBeLessThan(zoomedIn.zoomPxPerSec)
  const canvasWidth = (await page.getByTestId('timeline-canvas').boundingBox())!.width
  const contentWidth = fitted.zoomPxPerSec * 10 // 10 s fixture
  expect(contentWidth).toBeLessThanOrEqual(canvasWidth)
  expect(contentWidth).toBeGreaterThan(canvasWidth * 0.5)

  await app.close()
})
