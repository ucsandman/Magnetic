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
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-10')
const FLICKS_PER_SECOND = 705_600_000
const FRAME_FLICKS = FLICKS_PER_SECOND / 30
const HUNDRED_MS = FLICKS_PER_SECOND / 10

interface TranscriptTestState {
  sequence: Sequence | null
  playheadFlicks: number
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<TranscriptTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): TranscriptTestState }).__magneticState()
  )
}

async function totalDuration(page: Page): Promise<number> {
  const state = await getState(page)
  return state.sequence!.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
}

test('edit-by-transcript: seek, delete-to-cut, undo, fillers, search, background job', async () => {
  test.setTimeout(300_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-transcript-'))
  const app = await launchApp(join(tempRoot, 'Transcript.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'speech.wav')]
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- transcription runs in the BACKGROUND: the UI stays interactive ----
  const interactStart = Date.now()
  await page.getByTestId('asset-cell-speech.wav').click()
  await page.keyboard.press('e') // append to the timeline while whisper runs
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  const interactMs = Date.now() - interactStart
  console.log(`background job: select+append round-trip took ${interactMs}ms during transcription`)
  expect(interactMs).toBeLessThan(5_000)

  // transcript lands when the job finishes
  await page.waitForFunction(
    async () => {
      const lib = await window.api.getLibrary()
      return Object.values(lib.assets).some((asset) => asset.transcriptUrl !== undefined)
    },
    undefined,
    { timeout: 180_000 }
  )
  console.log('transcript job completed')

  // ---- open the transcript tab; words project from the sequence ----
  await page.keyboard.press('Control+Shift+T')
  await expect(page.getByTestId('transcript-panel')).toBeVisible()
  await expect(page.getByTestId('transcript-word-0')).toBeVisible({ timeout: 20_000 })
  const wordCount = await page.locator('[data-word-index]').count()
  expect(wordCount).toBeGreaterThan(40)
  await page.screenshot({ path: join(EVIDENCE, 'transcript.png') })

  // ---- click a word: playhead seeks within ±100 ms of the word start ----
  const word10 = page.getByTestId('transcript-word-10')
  const word10Start = Number(await word10.getAttribute('data-start'))
  await word10.click()
  state = await getState(page)
  const seekError = Math.abs(state.playheadFlicks - word10Start)
  console.log(
    `click-to-seek: word start ${word10Start}, playhead ${state.playheadFlicks}, error ${(seekError / FLICKS_PER_SECOND) * 1000}ms`
  )
  expect(seekError).toBeLessThanOrEqual(HUNDRED_MS)

  // ---- delete a sentence: duration shrinks by its span ±1 frame ----
  const beforeDelete = await totalDuration(page)
  const fromIndex = 15
  const toIndex = 24
  const sentenceStart = Number(
    await page.getByTestId(`transcript-word-${fromIndex}`).getAttribute('data-start')
  )
  const sentenceEnd = Number(
    await page.getByTestId(`transcript-word-${toIndex}`).getAttribute('data-end')
  )
  const fromBox = (await page.getByTestId(`transcript-word-${fromIndex}`).boundingBox())!
  const toBox = (await page.getByTestId(`transcript-word-${toIndex}`).boundingBox())!
  await page.mouse.move(fromBox.x + 4, fromBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(toBox.x + 4, toBox.y + 4, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.press('Delete')
  const afterDelete = await totalDuration(page)
  const removed = beforeDelete - afterDelete
  const expected = sentenceEnd - sentenceStart
  console.log(
    `delete-to-cut: removed ${(removed / FLICKS_PER_SECOND).toFixed(3)}s vs selected span ${(expected / FLICKS_PER_SECOND).toFixed(3)}s (Δ ${(Math.abs(removed - expected) / FRAME_FLICKS).toFixed(2)} frames)`
  )
  expect(Math.abs(removed - expected)).toBeLessThanOrEqual(FRAME_FLICKS)
  const wordsAfterDelete = await page.locator('[data-word-index]').count()
  expect(wordsAfterDelete).toBeLessThanOrEqual(wordCount - (toIndex - fromIndex + 1) + 2)

  // ---- one undo restores timeline AND transcript exactly ----
  await page.keyboard.press('Control+z')
  expect(await totalDuration(page)).toBe(beforeDelete)
  await expect.poll(() => page.locator('[data-word-index]').count()).toBe(wordCount)

  // ---- remove all fillers in ONE step; one undo restores all ----
  const fillerCount = await page.locator('[data-filler]').count()
  console.log(`fillers detected: ${fillerCount}`)
  expect(fillerCount).toBeGreaterThanOrEqual(3)
  const beforeFillers = await totalDuration(page)
  await page.getByTestId('transcript-remove-fillers').click()
  await expect.poll(() => page.locator('[data-filler]').count()).toBe(0)
  const afterFillers = await totalDuration(page)
  expect(afterFillers).toBeLessThan(beforeFillers)
  console.log(
    `remove fillers: ${(beforeFillers / FLICKS_PER_SECOND).toFixed(3)}s → ${(afterFillers / FLICKS_PER_SECOND).toFixed(3)}s in one step`
  )
  await page.keyboard.press('Control+z') // one undo: it was one group
  expect(await totalDuration(page)).toBe(beforeFillers)
  await expect.poll(() => page.locator('[data-filler]').count()).toBe(fillerCount)

  // ---- search highlights matches and jumps the playhead ----
  await page.getByTestId('transcript-search').fill('fox')
  await expect(page.locator('.transcript-word.match').first()).toBeVisible()
  const foxStart = Number(
    await page.locator('.transcript-word.match').first().getAttribute('data-start')
  )
  await page.getByTestId('transcript-search').press('Enter')
  state = await getState(page)
  expect(Math.abs(state.playheadFlicks - foxStart)).toBeLessThanOrEqual(HUNDRED_MS)
  console.log(`search: "fox" highlighted and playhead jumped to ${state.playheadFlicks}`)

  await app.close()
})
