import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SpikeResult } from '../src/renderer/playback/decoder/spike'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

async function openInViewer(page: Page, fileName: string): Promise<void> {
  await page.getByTestId(`asset-cell-${fileName}`).dblclick()
  await expect(page.getByTestId('viewer-video')).toBeVisible()
  // metadata loaded -> duration timecode rendered
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="viewer-video"]')
    return video !== null && video.readyState >= 1
  })
}

function timecode(page: Page): Promise<string> {
  return page.getByTestId('viewer-timecode').innerText()
}

test('viewer: open, play/pause, JKL, frame step, I/O marks, decoder spike', async () => {
  test.setTimeout(180_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-viewer-'))
  const app = await launchApp(join(tempRoot, 'Viewer.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'bars-1080p30.mp4'), join(FIXTURES, 'red-720p25.mp4')]
  )
  expect(imported.errors).toEqual([])

  // ---- Open the 30fps fixture; duration shows 10s at 30fps ----
  await openInViewer(page, 'bars-1080p30.mp4')
  await expect(page.getByTestId('viewer-duration')).toHaveText('00:00:10:00')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:00')

  // ---- Frame step at 30 fps: exactly one frame per press ----
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:01')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:02')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:01')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:11')

  // ---- L plays forward: time advances, K pauses cleanly ----
  await page.keyboard.press('l')
  await page.waitForTimeout(1000)
  await page.keyboard.press('k')
  const afterPlay = await timecode(page)
  expect(afterPlay > '00:00:00:11').toBe(true) // advanced past the stepped position
  await page.waitForTimeout(400)
  expect(await timecode(page)).toBe(afterPlay) // paused = no further movement

  // ---- LL doubles the rate ----
  await page.keyboard.press('l')
  await page.keyboard.press('l')
  const rate = await page
    .getByTestId('viewer-video')
    .evaluate((el) => (el as HTMLVideoElement).playbackRate)
  expect(rate).toBe(2)
  const beforeFast = await page
    .getByTestId('viewer-video')
    .evaluate((el) => (el as HTMLVideoElement).currentTime)
  await page.waitForTimeout(1000)
  const afterFast = await page
    .getByTestId('viewer-video')
    .evaluate((el) => (el as HTMLVideoElement).currentTime)
  expect(afterFast - beforeFast).toBeGreaterThan(1.4) // ~2 media-seconds per wall-second
  await page.keyboard.press('k')

  // ---- J reverses: timecode moves backward ----
  const beforeReverse = await timecode(page)
  await page.keyboard.press('j')
  await page.waitForTimeout(700)
  await page.keyboard.press('k')
  const afterReverse = await timecode(page)
  expect(afterReverse < beforeReverse).toBe(true)

  // ---- I/O marks render as a range; X clears ----
  await page.keyboard.press('i')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('o')
  const ioRange = page.getByTestId('viewer-io-range')
  await expect(ioRange).toBeVisible()
  const rangeBox = (await ioRange.boundingBox())!
  expect(rangeBox.width).toBeGreaterThan(2)
  await page.keyboard.press('x')
  await expect(ioRange).toHaveCount(0)

  // ---- Screenshot evidence (paused on a visible frame) ----
  const evidenceDir = join(ROOT, '.supergoal', 'evidence', 'phase-3')
  mkdirSync(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, 'viewer.png') })

  // ---- Esc returns focus to the browser ----
  await page.keyboard.press('Escape')
  const focusedTestId = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? ''
  )
  expect(focusedTestId).toBe('browser-assets')

  // ---- Frame step at 25 fps ----
  await openInViewer(page, 'red-720p25.mp4')
  await expect(page.getByTestId('viewer-duration')).toHaveText('00:00:08:00')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:01')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('viewer-timecode')).toHaveText('00:00:00:02')

  // ---- WebCodecs spike: decode >= 60 frames of the H.264 fixture ----
  const spike: SpikeResult = await page.evaluate(async (count) => {
    const snapshot = await window.api.getLibrary()
    const asset = Object.values(snapshot.assets).find(
      (candidate) => candidate.fileName === 'bars-1080p30.mp4'
    )!
    return window.__decoderSpike!.decodeFrames(asset.mediaUrl, count)
  }, 60)
  expect(spike.frameCount).toBeGreaterThanOrEqual(60)
  expect(spike.displayWidth).toBe(1920)
  expect(spike.displayHeight).toBe(1080)
  // coded size is macroblock-aligned (>= display size)
  expect(spike.codedWidth).toBeGreaterThanOrEqual(1920)
  expect(spike.codedHeight).toBeGreaterThanOrEqual(1080)
  expect(spike.maxQueued).toBeLessThanOrEqual(8) // backpressure held

  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
})
