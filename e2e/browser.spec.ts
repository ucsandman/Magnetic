import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

test('import, skim, rate, search and persistence across relaunch', async () => {
  test.setTimeout(120_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-e2e-'))
  const libraryPath = join(tempRoot, 'Test.mglib')

  let app = await launchApp(libraryPath)
  let page = await app.firstWindow()

  // ---- Import the fixtures through the test hook ----
  const fixturePaths = [
    join(FIXTURES, 'bars-1080p30.mp4'),
    join(FIXTURES, 'red-720p25.mp4'),
    join(FIXTURES, 'tone.wav'),
    join(FIXTURES, 'speech.wav')
  ]
  const result = await page.evaluate((paths) => window.api.__test!.importPaths(paths), fixturePaths)
  expect(result.errors).toEqual([])
  expect(result.importedIds).toHaveLength(4)

  // ---- Non-blocking check: rate immediately, while background jobs run ----
  const bars = page.getByTestId('asset-cell-bars-1080p30.mp4')
  await bars.click()
  await page.getByTestId('browser-assets').focus()
  await page.keyboard.press('f')
  await expect(bars).toHaveAttribute('data-rating', 'favorite')

  // ---- Duration badges ----
  await expect(bars.getByTestId('asset-duration')).toHaveText('0:10')
  await expect(
    page.getByTestId('asset-cell-red-720p25.mp4').getByTestId('asset-duration')
  ).toHaveText('0:08')
  await expect(page.getByTestId('asset-cell-tone.wav').getByTestId('asset-duration')).toHaveText(
    '0:05'
  )
  await expect(page.getByTestId('asset-cell-speech.wav').getByTestId('asset-duration')).toHaveText(
    '0:34'
  )

  // ---- Hover-skim: pointer x changes the displayed filmstrip frame ----
  const strip = bars.getByTestId('asset-strip')
  await expect(strip).toBeVisible({ timeout: 30_000 })
  const box = (await strip.boundingBox())!
  await page.mouse.move(box.x + 3, box.y + box.height / 2)
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundPosition))
    .not.toBe('')
  const positionLeft = await strip.evaluate((el) => getComputedStyle(el).backgroundPosition)
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundPosition))
    .not.toBe(positionLeft)
  const positionRight = await strip.evaluate((el) => getComputedStyle(el).backgroundPosition)
  expect(positionLeft).not.toBe(positionRight)

  // ---- Reject + filters ----
  const red = page.getByTestId('asset-cell-red-720p25.mp4')
  await red.click()
  await page.getByTestId('browser-assets').focus()
  await page.keyboard.press('Delete')
  await expect(red).toHaveAttribute('data-rating', 'rejected')

  await page.getByTestId('browser-filter').selectOption('hideRejected')
  await expect(red).toHaveCount(0)
  await expect(bars).toBeVisible()

  await page.getByTestId('browser-filter').selectOption('favorites')
  await expect(page.locator('.asset-cell')).toHaveCount(1)
  await expect(bars).toBeVisible()

  await page.getByTestId('browser-filter').selectOption('all')
  await expect(page.locator('.asset-cell')).toHaveCount(4)

  // ---- Search ----
  await page.getByTestId('browser-search').fill('bars')
  await expect(page.locator('.asset-cell')).toHaveCount(1)
  await expect(bars).toBeVisible()
  await page.getByTestId('browser-search').fill('')
  await expect(page.locator('.asset-cell')).toHaveCount(4)

  // ---- Wait for all background jobs (audio waveforms too), then screenshot ----
  await expect(page.getByTestId('asset-cell-speech.wav').locator('.asset-waveform')).toBeVisible({
    timeout: 30_000
  })
  const evidenceDir = join(ROOT, '.supergoal', 'evidence', 'phase-2')
  mkdirSync(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, 'browser.png') })

  // ---- Relaunch: assets, ratings and filmstrips must persist ----
  await app.close()
  app = await launchApp(libraryPath)
  page = await app.firstWindow()

  await expect(page.locator('.asset-cell')).toHaveCount(4, { timeout: 15_000 })
  await expect(page.getByTestId('asset-cell-bars-1080p30.mp4')).toHaveAttribute(
    'data-rating',
    'favorite'
  )
  await expect(page.getByTestId('asset-cell-red-720p25.mp4')).toHaveAttribute(
    'data-rating',
    'rejected'
  )
  await expect(
    page.getByTestId('asset-cell-bars-1080p30.mp4').getByTestId('asset-strip')
  ).toBeVisible()

  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
})
