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
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-11')

interface ScreensTestState {
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

function getState(page: Page): Promise<ScreensTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): ScreensTestState }).__magneticState()
  )
}

/** Final evidence set: one representative screenshot per major surface. */
test('final screenshots: browser, viewer, timeline, inspector, transcript, export', async () => {
  test.setTimeout(300_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-screens-'))
  const app = await launchApp(join(tempRoot, 'Screens.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [
      join(FIXTURES, 'speech.wav'),
      join(FIXTURES, 'red-720p25.mp4'),
      join(FIXTURES, 'bars-1080p30.mp4')
    ]
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- browser: filmstrips + waveform generated ----
  await expect
    .poll(
      async () => {
        const snap = await page.evaluate(() => window.api.getLibrary())
        return Object.values(snap.assets).every(
          (asset) =>
            (asset.video === undefined || asset.filmstrip !== undefined) &&
            (asset.audio === undefined || asset.waveform !== undefined)
        )
      },
      { timeout: 120_000 }
    )
    .toBe(true)
  await page.screenshot({ path: join(EVIDENCE, 'browser.png') })

  // ---- viewer: open a clip, step into it ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(EVIDENCE, 'viewer.png') })

  // ---- timeline with an edit: two clips + a cross dissolve at the cut ----
  await page.keyboard.press('e') // append bars
  await page.getByTestId('asset-cell-red-720p25.mp4').click()
  await page.keyboard.press('e') // append red
  for (let i = 0; i < 6; i++) await page.keyboard.press('-') // fit the sequence
  await page.keyboard.press('n') // snapping off: pixel-driven trims
  let state = await getState(page)
  expect(state.sequence!.spine.length).toBeGreaterThanOrEqual(2)
  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const spineY = bounds.y + 26 + 4 + 36 + 24
  const zoom = state.zoomPxPerSec
  const xAt = (sec: number): number => bounds.x + sec * zoom
  // Ctrl+T needs handle media on both sides of the cut: trim bars' tail
  // 2 s left, then red's head 1 s right (same recipe as effects.spec)
  let cutSec = state.sequence!.spine[0].durationFlicks / 705_600_000
  await page.mouse.move(xAt(cutSec) - 4, spineY)
  await page.mouse.down()
  await page.mouse.move(xAt(cutSec) - 4 - 2 * zoom, spineY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  cutSec = state.sequence!.spine[0].durationFlicks / 705_600_000
  await page.mouse.move(xAt(cutSec) + 4, spineY)
  await page.mouse.down()
  await page.mouse.move(xAt(cutSec) + 4 + 1 * zoom, spineY, { steps: 6 })
  await page.mouse.up()
  await page.mouse.click(xAt(cutSec), bounds.y + 10) // playhead at the cut
  await page.keyboard.press('Control+t') // 1 s cross dissolve
  state = await getState(page)
  expect(state.sequence!.transitions ?? []).toHaveLength(1)
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(EVIDENCE, 'timeline-with-edit.png') })

  // ---- inspector: select the red spine clip, show the color board ----
  await page.mouse.click(xAt(cutSec + 2), spineY)
  state = await getState(page)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(EVIDENCE, 'inspector.png') })

  // ---- transcript panel: speech clip appended, whisper transcript shown ----
  await page.waitForFunction(
    async () => {
      const lib = await window.api.getLibrary()
      return Object.values(lib.assets).some((asset) => asset.transcriptUrl !== undefined)
    },
    undefined,
    { timeout: 180_000 }
  )
  await page.getByTestId('asset-cell-speech.wav').click()
  await page.keyboard.press('e')
  await page.keyboard.press('Control+Shift+T')
  await expect(page.getByTestId('transcript-panel')).toBeVisible()
  await expect(page.getByTestId('transcript-words')).not.toHaveText('', { timeout: 30_000 })
  await page.screenshot({ path: join(EVIDENCE, 'transcript.png') })
  await page.keyboard.press('Control+Shift+T')

  // ---- export dialog ----
  await page.keyboard.press('Control+e')
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  await page.screenshot({ path: join(EVIDENCE, 'export-dialog.png') })

  console.log(`final screenshot set saved to ${EVIDENCE}`)
  await app.close()
})
