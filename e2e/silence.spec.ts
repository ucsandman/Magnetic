import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const FLICKS_PER_SECOND = 705_600_000
const FRAME_FLICKS = FLICKS_PER_SECOND / 30

// Fixture: 2 s tone + 1.5 s true silence + 2 s tone. With the defaults
// (−34 dB, 0.5 s min, 100 ms pad) detection yields ONE range [2.1 s, 3.4 s].
const TONE_SEC = 2
const GAP_SEC = 1.5
const PAD_SEC = 0.1
const EXPECTED_SPAN = (GAP_SEC - 2 * PAD_SEC) * FLICKS_PER_SECOND // 1.3 s
// envelope windows are 50 ms; allow ±2 windows of quantization slack
const WINDOW_SLACK = 2 * 0.05 * FLICKS_PER_SECOND

interface SilenceTestState {
  sequence: Sequence | null
  silenceRanges: { fromFlicks: number; toFlicks: number }[] | null
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<SilenceTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): SilenceTestState }).__magneticState()
  )
}

async function totalDuration(page: Page): Promise<number> {
  const state = await getState(page)
  return state.sequence!.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
}

/** Deterministic tone–silence–tone wav from the bundled ffmpeg (8 kHz: no resample). */
function makeFixture(dir: string): string {
  const fixture = join(dir, 'tone-gap-tone.wav')
  const toneEnd = TONE_SEC
  const gapEnd = TONE_SEC + GAP_SEC
  const expr = `if(lt(t,${toneEnd}),0.5*sin(880*2*PI*t),if(lt(t,${gapEnd}),0,0.5*sin(880*2*PI*t)))`
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${expr}':s=8000:d=${TONE_SEC + GAP_SEC + TONE_SEC}`,
    fixture
  ])
  return fixture
}

test('auto silence removal: detect, tune, preview, one-click cut, one-step undo', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-silence-'))
  const fixture = makeFixture(tempRoot)
  const app = await launchApp(join(tempRoot, 'Silence.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- append to the spine, then wait for the background envelope job ----
  await page.getByTestId('asset-cell-tone-gap-tone.wav').click()
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  await page.waitForFunction(
    async () => {
      const lib = await window.api.getLibrary()
      return Object.values(lib.assets).some((asset) => asset.envelopeUrl !== undefined)
    },
    undefined,
    { timeout: 120_000 }
  )
  console.log('envelope job completed')

  // ---- open the Silence tab: exactly one gap, highlighted on the timeline ----
  await page.getByTestId('browser-tab-silence').click()
  await expect(page.getByTestId('silence-panel')).toBeVisible()
  await expect(page.getByTestId('silence-row-0')).toBeVisible({ timeout: 20_000 })
  expect(await page.locator('.silence-row').count()).toBe(1)
  await expect(page.getByTestId('silence-summary')).toContainText('1 gap')

  state = await getState(page)
  expect(state.silenceRanges).toHaveLength(1)
  const range = state.silenceRanges![0]
  const span = range.toFlicks - range.fromFlicks
  console.log(
    `detected gap: ${(range.fromFlicks / FLICKS_PER_SECOND).toFixed(3)}s → ${(range.toFlicks / FLICKS_PER_SECOND).toFixed(3)}s (span ${(span / FLICKS_PER_SECOND).toFixed(3)}s)`
  )
  expect(Math.abs(range.fromFlicks - (TONE_SEC + PAD_SEC) * FLICKS_PER_SECOND)).toBeLessThanOrEqual(
    WINDOW_SLACK
  )
  expect(Math.abs(span - EXPECTED_SPAN)).toBeLessThanOrEqual(WINDOW_SLACK)

  // ---- tunability: instant re-threshold from the cached envelope ----
  await page.getByTestId('silence-min-duration').fill('2')
  await expect(page.getByTestId('silence-summary')).toContainText('0 gaps')
  await page.getByTestId('silence-min-duration').fill('0.5')
  await expect(page.getByTestId('silence-summary')).toContainText('1 gap')
  await page.getByTestId('silence-threshold').fill('-100') // below the silence floor
  await expect(page.getByTestId('silence-summary')).toContainText('0 gaps')
  await page.getByTestId('silence-threshold').fill('-34')
  await expect(page.getByTestId('silence-summary')).toContainText('1 gap')

  // ---- one click cuts the gap; two clips remain with correct durations ----
  const beforeCut = await totalDuration(page)
  await page.getByTestId('silence-apply').click()
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)
  const afterCut = await totalDuration(page)
  const removed = beforeCut - afterCut
  console.log(
    `cut: removed ${(removed / FLICKS_PER_SECOND).toFixed(3)}s vs detected span ${(span / FLICKS_PER_SECOND).toFixed(3)}s (Δ ${(Math.abs(removed - span) / FRAME_FLICKS).toFixed(2)} frames)`
  )
  expect(Math.abs(removed - span)).toBeLessThanOrEqual(FRAME_FLICKS)
  for (const item of state.sequence!.spine) {
    // each remaining clip ≈ tone + padding kept on its side of the cut
    expect(
      Math.abs(item.durationFlicks - (TONE_SEC + PAD_SEC) * FLICKS_PER_SECOND)
    ).toBeLessThanOrEqual(WINDOW_SLACK + FRAME_FLICKS)
  }
  // the panel re-detects against the cut sequence: nothing left to remove
  await expect(page.getByTestId('silence-summary')).toContainText('0 gaps')

  // ---- ONE Ctrl+Z restores the whole cut (single undo group) ----
  await page.keyboard.press('Control+z')
  expect(await totalDuration(page)).toBe(beforeCut)
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  await expect(page.getByTestId('silence-summary')).toContainText('1 gap')
  console.log('one undo restored the sequence byte-exactly')

  await app.close()
})
