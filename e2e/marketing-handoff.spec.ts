import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000
// Brief's stated tolerance for marker-position ↔ segment-boundary comparisons.
const FRAME_SEC = 1 / 30

interface HandoffTestState {
  sequence: Sequence | null
  playheadFlicks: number
}

/**
 * segments.json shape check mirroring the animations repo's consumer
 * (scripts/lib/wrap-contract.mjs `validateManifest`) verbatim — this spec is
 * the cross-repo contract drift-guard, so it must fail the same way that
 * validator would if the two ever diverge.
 */
function validateManifestShape(json: unknown): asserts json is {
  version: number
  video: string
  captions: string
  fps: number
  exportedAt: string
  segments: { id: string; title: string; startSec: number; endSec: number }[]
} {
  const manifest = json as Record<string, unknown>
  expect(manifest.version).toBe(1)
  for (const field of ['video', 'captions', 'fps', 'exportedAt', 'segments']) {
    expect(field in manifest).toBe(true)
  }
  expect(Array.isArray(manifest.segments)).toBe(true)
  const seenIds = new Set<string>()
  for (const segment of manifest.segments as Record<string, unknown>[]) {
    expect(typeof segment.id).toBe('string')
    expect(typeof segment.title).toBe('string')
    expect(Number.isFinite(segment.startSec)).toBe(true)
    expect(segment.startSec as number).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(segment.endSec)).toBe(true)
    expect(segment.endSec as number).toBeGreaterThanOrEqual(0)
    expect(segment.endSec as number).toBeGreaterThan(segment.startSec as number)
    expect(seenIds.has(segment.id as string)).toBe(false)
    seenIds.add(segment.id as string)
  }
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<HandoffTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): HandoffTestState }).__magneticState()
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

test('marketing handoff: real dialog round-trip writes 4 files, segments.json matches the clip: markers', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-handoff-'))
  const outDir = mkdtempSync(join(tmpdir(), 'magnetic-handoff-out-'))
  const app = await launchApp(join(tempRoot, 'Handoff.mglib'))
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.log(`PAGEERROR: ${String(error)}`))

  await importFixtures(page, ['bars-1080p30.mp4', 'red-720p25.mp4'])
  await waitForTimeline(page)

  const library = await page.evaluate(() => window.api.getLibrary())
  const assets = Object.values(library.assets)
  const bars = assets.find((asset) => asset.fileName === 'bars-1080p30.mp4')!
  const red = assets.find((asset) => asset.fileName === 'red-720p25.mp4')!

  // ---- build a 2-clip sequence ----
  await page.getByTestId(`asset-cell-${bars.fileName}`).click()
  await page.keyboard.press('e')
  await page.getByTestId(`asset-cell-${red.fileName}`).click()
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)
  expect(state.playheadFlicks).toBe(0) // appending never moves the playhead
  const clip1DurationFlicks = state.sequence!.spine[0].durationFlicks

  // ---- marker 1: "clip: First look" at the sequence start ----
  await page.keyboard.press('m')
  state = await getState(page)
  expect(state.sequence!.markers).toHaveLength(1)
  await page.getByTestId('marker-text').fill('clip: First look')
  await page.keyboard.press('Tab') // blur the text field so shortcuts fire again

  // ---- marker 2: "end" at the exact clip1/clip2 boundary (an edit point) ----
  await page.keyboard.press('ArrowDown') // playhead → next edit point
  state = await getState(page)
  expect(state.playheadFlicks).toBe(clip1DurationFlicks)
  await page.keyboard.press('m')
  state = await getState(page)
  expect(state.sequence!.markers).toHaveLength(2)
  await page.getByTestId('marker-text').fill('end')
  await page.keyboard.press('Tab')

  // ---- drive the handoff export through the real dialog UI ----
  await page.keyboard.press('Control+e')
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  const handoffMode = page.getByTestId('export-mode-handoff')
  await expect(handoffMode).toBeEnabled() // segments derived → option unlocked
  await handoffMode.click()
  await page.getByTestId('export-destination').fill(outDir)
  await page.getByTestId('handoff-start').click()

  await expect
    .poll(
      async () => {
        const errorBox = page.getByTestId('export-error')
        if ((await errorBox.count()) > 0) {
          throw new Error(`handoff export surfaced an error: ${await errorBox.innerText()}`)
        }
        return (await page.getByTestId('export-success').count()) > 0
      },
      { timeout: 240_000, intervals: [250] }
    )
    .toBe(true)
  await page.getByTestId('export-close').click()
  await app.close()

  // ---- 4 files landed ----
  for (const name of ['video.mp4', 'captions.srt', 'captions.vtt', 'segments.json']) {
    expect(existsSync(join(outDir, name))).toBe(true)
  }

  // ---- segments.json: parses, passes the wrap-contract shape, matches the markers ----
  const manifest = JSON.parse(readFileSync(join(outDir, 'segments.json'), 'utf8')) as unknown
  validateManifestShape(manifest)
  expect(manifest.video).toBe('video.mp4')
  expect(manifest.captions).toBe('captions.srt')
  expect(manifest.segments).toHaveLength(1)
  expect(manifest.segments[0].id).toBe('first-look')
  expect(manifest.segments[0].title).toBe('First look')
  expect(Math.abs(manifest.segments[0].startSec - 0)).toBeLessThan(FRAME_SEC)
  const expectedEndSec = clip1DurationFlicks / FLICKS_PER_SECOND
  expect(Math.abs(manifest.segments[0].endSec - expectedEndSec)).toBeLessThan(FRAME_SEC)
})

test('marketing handoff: disabled with a hint when the sequence has no clip: markers', async () => {
  test.setTimeout(120_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-handoff-empty-'))
  const app = await launchApp(join(tempRoot, 'HandoffEmpty.mglib'))
  const page = await app.firstWindow()

  await importFixtures(page, ['bars-1080p30.mp4'])
  await waitForTimeline(page)

  const library = await page.evaluate(() => window.api.getLibrary())
  const bars = Object.values(library.assets).find((asset) => asset.fileName === 'bars-1080p30.mp4')!
  await page.getByTestId(`asset-cell-${bars.fileName}`).click()
  await page.keyboard.press('e')
  const state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  expect(state.sequence!.markers ?? []).toHaveLength(0)

  await page.keyboard.press('Control+e')
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  const handoffMode = page.getByTestId('export-mode-handoff')
  await expect(handoffMode).toBeDisabled()
  await expect(handoffMode).toHaveAttribute('title', 'Add clip: markers to define segments')

  await app.close()
})
