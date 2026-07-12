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

// Fixture: tone – gap – tone – gap – tone. At the default 50% aggressiveness
// (−36 dB, 0.75 s min run, 100 ms pad) each 1.5 s gap detects as one cut of
// 1.3 s, so the plan has TWO cuts — enough to prove per-cut reject keeps the
// other one.
const TONE_SEC = 2
const GAP_SEC = 1.5
const PAD_SEC = 0.1
const CUT_SPAN = (GAP_SEC - 2 * PAD_SEC) * FLICKS_PER_SECOND // 1.3 s
const WINDOW_SLACK = 2 * 0.05 * FLICKS_PER_SECOND

interface RoughCutTestState {
  sequence: Sequence | null
  silenceRanges: { fromFlicks: number; toFlicks: number }[] | null
  roughCutCuts: { flicks: number; reason: string; removedFlicks: number }[] | null
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<RoughCutTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): RoughCutTestState }).__magneticState()
  )
}

async function totalDuration(page: Page): Promise<number> {
  const state = await getState(page)
  return state.sequence!.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
}

/** Deterministic tone–gap–tone–gap–tone wav from the bundled ffmpeg. */
function makeFixture(dir: string): string {
  const fixture = join(dir, 'talking-head.wav')
  const t1 = TONE_SEC
  const g1 = t1 + GAP_SEC
  const t2 = g1 + TONE_SEC
  const g2 = t2 + GAP_SEC
  const total = g2 + TONE_SEC
  const tone = '0.5*sin(880*2*PI*t)'
  const expr = `if(lt(t,${t1}),${tone},if(lt(t,${g1}),0,if(lt(t,${t2}),${tone},if(lt(t,${g2}),0,${tone}))))`
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${expr}':s=8000:d=${total}`,
    fixture
  ])
  return fixture
}

test('rough cut: one button, per-cut reject keeps the rest, one-step undo', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-roughcut-'))
  const fixture = makeFixture(tempRoot)
  const app = await launchApp(join(tempRoot, 'RoughCut.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- append to the spine, then wait for the background envelope job ----
  await page.getByTestId('asset-cell-talking-head.wav').click()
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

  // ---- open the Rough Cut tab: two planned cuts, previewed as bands ----
  await page.getByTestId('browser-tab-roughcut').click()
  await expect(page.getByTestId('roughcut-panel')).toBeVisible()
  await expect(page.getByTestId('roughcut-row-1')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('roughcut-summary')).toContainText('2 cuts')
  state = await getState(page)
  expect(state.silenceRanges).toHaveLength(2)
  expect(state.roughCutCuts).toBeNull()

  // ---- one button applies both cuts and enters review mode ----
  const beforeCut = await totalDuration(page)
  await page.getByTestId('roughcut-apply').click()
  await expect(page.getByTestId('roughcut-review-summary')).toContainText('2 cuts')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  expect(state.roughCutCuts).toHaveLength(2)
  // planning bands cleared once applied — the review list owns the surface now
  expect(state.silenceRanges).toBeNull()
  const afterCut = await totalDuration(page)
  expect(Math.abs(beforeCut - afterCut - 2 * CUT_SPAN)).toBeLessThanOrEqual(
    2 * WINDOW_SLACK + FRAME_FLICKS
  )
  console.log(`applied 2 cuts: removed ${((beforeCut - afterCut) / FLICKS_PER_SECOND).toFixed(3)}s`)

  // ---- reject the FIRST cut: it restores, the second stays ----
  await page.getByTestId('roughcut-reject-0').click()
  await expect(page.getByTestId('roughcut-review-summary')).toContainText('1 cut')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)
  expect(state.roughCutCuts).toHaveLength(1)
  const afterReject = await totalDuration(page)
  expect(Math.abs(beforeCut - afterReject - CUT_SPAN)).toBeLessThanOrEqual(
    WINDOW_SLACK + FRAME_FLICKS
  )
  console.log(`rejected cut 0: sequence back to ${(afterReject / FLICKS_PER_SECOND).toFixed(3)}s`)

  // ---- ONE Ctrl+Z reverts the remaining pass entirely ----
  await page.keyboard.press('Control+z')
  expect(await totalDuration(page)).toBe(beforeCut)
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  // provenance is ephemeral: once the pass is undone the badges are gone
  await expect(page.getByTestId('roughcut-apply')).toBeVisible()
  console.log('one undo restored the sequence byte-exactly')

  await app.close()
})
