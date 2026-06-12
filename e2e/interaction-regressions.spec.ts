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
import type { Selection } from '../src/shared/timeline/select'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000

interface TimelineState {
  sequence: Sequence | null
  selection: Selection
  playheadFlicks: number
  zoomPxPerSec: number
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<TimelineState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): TimelineState }).__magneticState()
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

function xForTime(state: TimelineState, flicks: number): number {
  return (flicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
}

test('source viewer play button uses preview proxy for unsupported imports', async () => {
  test.setTimeout(120_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-source-proxy-'))
  const app = await launchApp(join(tempRoot, 'SourceProxy.mglib'))
  const page = await app.firstWindow()

  await importFixtures(page, ['green-prores.mov'])
  await page.getByTestId('asset-cell-green-prores.mov').dblclick()
  const video = page.getByTestId('viewer-video')
  await expect(video).toBeVisible()
  await expect
    .poll(
      () =>
        video.evaluate((el) => {
          const media = el as HTMLVideoElement
          return (
            media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && Number.isFinite(media.duration)
          )
        }),
      { timeout: 45_000 }
    )
    .toBe(true)

  await page.getByTestId('viewer-play-pause').click()
  await expect
    .poll(
      () =>
        video.evaluate((el) => {
          const media = el as HTMLVideoElement
          return { currentTime: media.currentTime, paused: media.paused, ended: media.ended }
        }),
      { timeout: 15_000 }
    )
    .toMatchObject({ paused: false, ended: false })
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime), { timeout: 15_000 })
    .toBeGreaterThan(0.7)

  await app.close()
})

test('title presets connect on click and right-click menus expose edit actions', async () => {
  test.setTimeout(120_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-context-menu-'))
  const app = await launchApp(join(tempRoot, 'ContextMenus.mglib'))
  const page = await app.firstWindow()

  await importFixtures(page, ['bars-1080p30.mp4'])
  await waitForTimeline(page)

  const assetCell = page.getByTestId('asset-cell-bars-1080p30.mp4')
  await assetCell.click()
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)

  await page.getByTestId('title-preset-basic').click()
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(1)
  expect(state.sequence!.connected[0].titleData?.preset).toBe('basic')

  await assetCell.click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.getByTestId('context-favorite').click()
  await expect(assetCell).toHaveAttribute('data-rating', 'favorite')

  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  state = await getState(page)
  const spineCenterY = bounds.y + 26 + 4 + 36 + 24
  await page.mouse.click(bounds.x + xForTime(state, FLICKS_PER_SECOND), spineCenterY, {
    button: 'right'
  })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await expect(page.getByTestId('context-blade')).toBeVisible()
  await expect(page.getByTestId('context-ripple-delete')).toBeVisible()
  await expect(page.getByTestId('context-lift-delete')).toBeVisible()
  await page.getByTestId('context-ripple-delete').click()
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(0)

  await app.close()
})

test('browser context menu deletes uploaded media and removes timeline uses', async () => {
  test.setTimeout(120_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-delete-media-'))
  const app = await launchApp(join(tempRoot, 'DeleteMedia.mglib'))
  const page = await app.firstWindow()

  await importFixtures(page, ['bars-1080p30.mp4'])
  await waitForTimeline(page)

  const assetCell = page.getByTestId('asset-cell-bars-1080p30.mp4')
  await assetCell.click()
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)

  page.once('dialog', (dialog) => dialog.accept())
  await assetCell.click({ button: 'right' })
  await page.getByTestId('context-delete-media').click()

  await expect(assetCell).toHaveCount(0)
  const library = await page.evaluate(() => window.api.getLibrary())
  expect(Object.values(library.assets)).toHaveLength(0)
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(0)

  await app.close()
})
