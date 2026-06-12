import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Evidence captures for the UX round-2 features (loop, meter, minimap).
 * Screenshots land in .supergoal/evidence/ux2/ — kept as a spec so the
 * captures stay reproducible and the surfaces stay smoke-tested.
 */

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'ux2')

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

test('capture UX round-2 evidence: loop pressed, meter live, minimap visible', async () => {
  test.setTimeout(240_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-ux2-ev-'))
  const app = await launchApp(join(tempRoot, 'Ux2Ev.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    ['bars-1080p30.mp4', 'tone.wav'].map((file) => join(FIXTURES, file))
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // sequence with picture + tone, playing, loop on
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-tone.wav').click()
  await page.keyboard.press('e')
  await page.keyboard.press(' ')
  await expect(page.getByTestId('sequence-playing')).toHaveText('playing')
  await page.getByTestId('loop-toggle').click()
  await expect(page.getByTestId('loop-toggle')).toHaveAttribute('aria-pressed', 'true')

  // meter live (tone is the second clip — seek into it while playing via timecode)
  await page.getByTestId('sequence-play-pause').click()
  await page.getByTestId('sequence-timecode').click()
  await page.getByTestId('timecode-input').fill('00:00:11:00')
  await page.getByTestId('timecode-input').press('Enter')
  await page.getByTestId('sequence-play-pause').click()
  await expect
    .poll(
      async () => Number(await page.getByTestId('sequence-meter').getAttribute('aria-valuenow')),
      { timeout: 20_000 }
    )
    .toBeGreaterThan(-55)
  await page.screenshot({ path: join(EVIDENCE, 'loop-and-meter.png') })
  await page.getByTestId('sequence-play-pause').click()

  // minimap on a zoomed timeline
  await page.getByTestId('timeline-canvas').click({ position: { x: 5, y: 8 } })
  for (let i = 0; i < 8; i++) await page.keyboard.press('=')
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __magneticTimeline: { view(): { minimap: unknown } }
            }
          ).__magneticTimeline.view().minimap !== null
      )
    )
    .toBe(true)
  await page.getByTestId('timeline-canvas').screenshot({ path: join(EVIDENCE, 'minimap.png') })
  await page.screenshot({ path: join(EVIDENCE, 'ux2-overview.png') })

  await app.close()
})
