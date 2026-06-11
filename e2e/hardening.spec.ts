import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-11')

interface HardeningTestState {
  sequence: Sequence | null
  playheadFlicks: number
}

function getState(page: Page): Promise<HardeningTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): HardeningTestState }).__magneticState()
  )
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

/** Background ffmpeg jobs hold media files open on Windows — retry until released. */
async function renameWhenUnlocked(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= 40) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

test('hardening: startup, states, edges, a11y, 500 clips', async () => {
  test.setTimeout(420_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-harden-'))
  // edge: library path containing spaces
  const libraryPath = join(tempRoot, 'My Library Folder', 'Spaced Library.mglib')
  mkdirSync(join(tempRoot, 'My Library Folder'), { recursive: true })

  // ---- startup-to-interactive < 3 s ----
  const launchStart = Date.now()
  const app = await launchApp(libraryPath)
  const page = await app.firstWindow()
  await expect(page.getByTestId('browser-assets')).toBeVisible()
  const startupMs = Date.now() - launchStart
  console.log(`startup-to-interactive: ${startupMs}ms (budget 3000ms)`)
  expect(startupMs).toBeLessThan(3000)

  // ---- empty library shows a friendly import CTA ----
  await expect(page.getByText('No media — File → Import Media… or drop files here')).toBeVisible()

  // ---- unicode filename import (and spaced library path working at all) ----
  const unicodePath = join(tempRoot, '日本語クリップ.mp4')
  copyFileSync(join(FIXTURES, 'red-720p25.mp4'), unicodePath)
  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [unicodePath, join(FIXTURES, 'bars-1080p30.mp4'), join(FIXTURES, 'green-prores.mov')]
  )
  expect(imported.errors).toEqual([])
  // import-in-progress: cells shimmer with "processing…" until background jobs land
  await expect(page.getByTestId('asset-pending').first()).toBeVisible()
  console.log('import progress: processing indicator shown while jobs run')
  await expect(page.getByTestId('asset-cell-日本語クリップ.mp4')).toBeVisible()
  console.log('unicode filename imported and rendered; spaced library path functional')
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- missing media: alert badge + relink (duration must match) ----
  // wait for filmstrip/waveform/transcribe jobs so no ffmpeg holds the file
  await expect
    .poll(
      async () => {
        const snap = await page.evaluate(() => window.api.getLibrary())
        return Object.values(snap.assets).every(
          (asset) =>
            (asset.video === undefined || asset.filmstrip !== undefined) &&
            (asset.audio === undefined || asset.waveform !== undefined) &&
            (asset.audio === undefined || asset.transcriptUrl !== undefined)
        )
      },
      { timeout: 120_000 }
    )
    .toBe(true)
  await expect(page.getByTestId('asset-pending')).toHaveCount(0) // indicators cleared
  const library = await page.evaluate(() => window.api.getLibrary())
  const unicodeAsset = Object.values(library.assets).find(
    (asset) => asset.fileName === '日本語クリップ.mp4'
  )!
  const mediaAbs = join(libraryPath, unicodeAsset.libraryRelPath)
  await renameWhenUnlocked(mediaAbs, `${mediaAbs}.gone`)
  await page.evaluate((id) => window.api.setAssetRating(id, 'favorite'), unicodeAsset.id) // refresh snapshot
  await expect(page.getByTestId('asset-relink')).toBeVisible({ timeout: 15_000 })
  console.log('missing media: alert badge shown')
  // wrong-duration replacement rejects
  const wrongRelink = await page
    .evaluate(
      ({ id, path }) => window.api.__test!.relinkPath(id, path),
      { id: unicodeAsset.id, path: join(FIXTURES, 'bars-1080p30.mp4') } // 10s vs 8s
    )
    .then(() => 'accepted')
    .catch((error) => String(error))
  expect(wrongRelink).toContain('duration mismatch')
  // correct replacement relinks and clears the badge
  await page.evaluate(({ id, path }) => window.api.__test!.relinkPath(id, path), {
    id: unicodeAsset.id,
    path: join(FIXTURES, 'red-720p25.mp4')
  })
  await expect(page.getByTestId('asset-relink')).toHaveCount(0, { timeout: 15_000 })
  console.log('relink: wrong duration rejected; matching file relinked, badge cleared')

  // ---- unsupported codec → proxy badge with explanation ----
  const green = Object.values(library.assets).find(
    (asset) => asset.fileName === 'green-prores.mov'
  )!
  await page.evaluate((id) => window.api.ensureProxy(id), green.id)
  await expect(page.getByTestId('asset-proxy')).toBeVisible({ timeout: 30_000 })
  const proxyTitle = await page.getByTestId('asset-proxy').getAttribute('title')
  expect(proxyTitle).toContain('H.264 preview proxy')
  console.log(`unsupported codec message: "${proxyTitle}"`)

  // ---- a11y: shortcuts suppressed while typing in inputs ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  const spineBefore = (await getState(page)).sequence!.spine.length
  await page.getByTestId('browser-search').click()
  await page.getByTestId('browser-search').type('events')
  const spineAfter = (await getState(page)).sequence!.spine.length
  expect(spineAfter).toBe(spineBefore) // 'e' did not append while typing
  await page.getByTestId('browser-search').fill('')
  console.log('shortcut suppression: typing "events" in search appended nothing')

  // ---- '?' overlay enumerates the live registry ----
  await page.getByTestId('browser-assets').focus()
  await page.keyboard.press('Shift+?')
  await expect(page.getByTestId('shortcut-overlay')).toBeVisible()
  const rows = await page.getByTestId('shortcut-row').count()
  expect(rows).toBeGreaterThanOrEqual(25)
  await expect(page.getByText('Blade tool')).toBeVisible()
  console.log(`shortcut overlay: ${rows} live registry bindings listed`)
  await page.screenshot({ path: join(EVIDENCE, 'shortcut-overlay.png') })
  await page.getByTestId('shortcut-overlay-close').click()

  // ---- zero-length transcript selection is a safe no-op ----
  await page.keyboard.press('Control+Shift+T')
  await expect(page.getByTestId('transcript-panel')).toBeVisible()
  const durationBefore = (await getState(page)).sequence!.spine.reduce(
    (sum, item) => sum + item.durationFlicks,
    0
  )
  await page.getByTestId('transcript-words').click()
  await page.keyboard.press('Delete')
  const durationAfter = (await getState(page)).sequence!.spine.reduce(
    (sum, item) => sum + item.durationFlicks,
    0
  )
  expect(durationAfter).toBe(durationBefore)
  await page.keyboard.press('Control+Shift+T')

  // ---- 500-clip timeline: opens, scrubs, median frame < 33 ms ----
  await page.evaluate(
    ({ assetId, durationFlicks }) => {
      const hooks = window as unknown as {
        __magneticTimeline: {
          buildPerfSequence(
            count: number,
            asset: {
              assetId: string
              mediaInFlicks: number
              durationFlicks: number
              sourceDurationFlicks: number
            }
          ): void
        }
      }
      hooks.__magneticTimeline.buildPerfSequence(500, {
        assetId,
        mediaInFlicks: 0,
        durationFlicks: Math.floor(durationFlicks / 5),
        sourceDurationFlicks: durationFlicks
      })
    },
    (() => {
      const bars = Object.values(library.assets).find(
        (asset) => asset.fileName === 'bars-1080p30.mp4'
      )!
      return { assetId: bars.id, durationFlicks: bars.durationFlicks }
    })()
  )
  const state = await getState(page)
  expect(state.sequence!.spine.length).toBeGreaterThanOrEqual(500)
  const stats = await page.evaluate(() => {
    const hooks = window as unknown as {
      __magneticTimeline: { measureDraws(n: number): Promise<{ medianMs: number; maxMs: number }> }
    }
    return hooks.__magneticTimeline.measureDraws(60)
  })
  console.log(`500-clip timeline: median ${stats.medianMs}ms, max ${stats.maxMs}ms (budget 33ms)`)
  expect(stats.medianMs).toBeLessThan(33)
  // scrub interactively: ruler click moves the playhead and renders a still
  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const scrubStart = Date.now()
  await page.mouse.click(bounds.x + 300, bounds.y + 10)
  const scrubbed = await getState(page)
  expect(scrubbed.playheadFlicks).toBeGreaterThan(0)
  console.log(`500-clip scrub: ruler click handled in ${Date.now() - scrubStart}ms`)
  await page.screenshot({ path: join(EVIDENCE, 'timeline-500-clips.png') })

  await app.close()
})

test('soak: 5-minute playback, RSS growth < 25%', async () => {
  test.setTimeout(480_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-soak-'))
  const app = await launchApp(join(tempRoot, 'Soak.mglib'))
  const page = await app.firstWindow()
  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'bars-1080p30.mp4')]
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  // 200 × 2 s = 400 s of timeline (longer than the soak window)
  const library = await page.evaluate(() => window.api.getLibrary())
  await page.evaluate(
    ({ assetId, durationFlicks }) => {
      const hooks = window as unknown as {
        __magneticTimeline: {
          buildPerfSequence(
            count: number,
            asset: {
              assetId: string
              mediaInFlicks: number
              durationFlicks: number
              sourceDurationFlicks: number
            }
          ): void
        }
      }
      hooks.__magneticTimeline.buildPerfSequence(200, {
        assetId,
        mediaInFlicks: 0,
        durationFlicks: Math.floor(durationFlicks / 5),
        sourceDurationFlicks: durationFlicks
      })
    },
    (() => {
      const first = Object.values(library.assets)[0]
      return { assetId: first.id, durationFlicks: first.durationFlicks }
    })()
  )
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('sequence-playing')).toHaveText('playing')
  const baseline = await page.evaluate(() => window.api.diagMemory())
  const samples: number[] = [baseline.rss]
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(30_000)
    const memory = await page.evaluate(() => window.api.diagMemory())
    samples.push(memory.rss)
    const state = await getState(page)
    expect(state.playheadFlicks).toBeGreaterThan(0) // still progressing/alive
  }
  await page.keyboard.press('Space')
  const growth = samples[samples.length - 1] / samples[0]
  console.log(
    `soak (5 min playback): rss ${samples.map((value) => (value / 1e6).toFixed(0)).join(' → ')} MB; growth ×${growth.toFixed(3)} (budget ×1.25)`
  )
  expect(growth).toBeLessThan(1.25)
  await app.close()
})
