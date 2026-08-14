import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const PACKAGED_EXE = join(ROOT, 'dist', 'win-unpacked', 'Magnetic.exe')
const FLICKS_PER_SECOND = 705_600_000

/**
 * Boot E2E against the PACKAGED app (dist/win-unpacked, built by `npm run
 * package`). Skipped when the package output is absent so `npm run test:e2e`
 * stays green on a clean clone; run `npm run package` first to exercise it.
 */
test('packaged app boots, resolves bundled binaries, imports media', async () => {
  test.skip(!existsSync(PACKAGED_EXE), 'run `npm run package` first — dist/win-unpacked missing')
  test.setTimeout(120_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-packaged-'))
  const app = await electron.launch({
    executablePath: PACKAGED_EXE,
    env: {
      ...process.env,
      MAGNETIC_TEST: '1',
      MAGNETIC_LIBRARY_PATH: join(tempRoot, 'Packaged.mglib')
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('browser-assets')).toBeVisible()

  // bundled binaries resolve via process.resourcesPath/bin inside the package
  const diag = await page.evaluate(() => window.api.diagBinaries())
  expect(diag.ffprobe.ok, `ffprobe: ${diag.ffprobe.firstLine}`).toBe(true)
  expect(diag.whisper.ok, `whisper: ${diag.whisper.firstLine}`).toBe(true)
  console.log(`packaged ffprobe: ${diag.ffprobe.firstLine}`)
  console.log(`packaged whisper: ${diag.whisper.firstLine}`)

  // a real import runs ffprobe + ffmpeg end-to-end inside the packaged app
  const mediaPath = join(tempRoot, 'boot-check.mp4')
  copyFileSync(join(ROOT, 'fixtures', 'red-720p25.mp4'), mediaPath)
  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [mediaPath]
  )
  expect(imported.errors).toEqual([])
  await expect(page.getByTestId('asset-cell-boot-check.mp4')).toBeVisible()
  console.log('packaged app: boot, binary resolution, and import all verified')
  await app.close()
})

/**
 * The packaged shim path (process.resourcesPath/magnetic-mcp.mjs, spawned as
 * Magnetic.exe + ELECTRON_RUN_AS_NODE) is a different mechanism from the dev
 * path the subscription suite covers — prove it with a real edit turn: the
 * fake CLI reads the per-turn MCP config and REALLY drives the packaged shim.
 */
test('packaged app: subscription turn drives the bundled shim to a proposal', async () => {
  test.skip(!existsSync(PACKAGED_EXE), 'run `npm run package` first — dist/win-unpacked missing')
  test.setTimeout(180_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-packaged-sub-'))
  const fixture = join(tempRoot, 'interview.wav')
  execFileSync(join(ROOT, 'resources', 'bin', 'ffmpeg.exe'), [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='0.5*sin(880*2*PI*t)':s=8000:d=5.5`,
    fixture
  ])
  const app = await electron.launch({
    executablePath: PACKAGED_EXE,
    env: {
      ...process.env,
      MAGNETIC_TEST: '1',
      MAGNETIC_LIBRARY_PATH: join(tempRoot, 'PackagedSub.mglib'),
      MAGNETIC_CLAUDE_BIN: join(__dirname, 'fixtures', 'fake-claude.cmd')
    }
  })
  const page = await app.firstWindow()

  const imported = await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-interview.wav').click()
  await page.keyboard.press('e')
  await page.getByTestId('browser-tab-copilot').click()

  await expect(page.getByTestId('provider-subscription')).toBeChecked()

  const durationOf = (): Promise<number> =>
    page.evaluate(() =>
      (
        window as unknown as {
          __magneticState(): { sequence: { spine: { durationFlicks: number }[] } }
        }
      )
        .__magneticState()
        .sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
    )
  const beforeEdit = await durationOf()

  await page.getByTestId('copilot-question').fill('cut the first second')
  await page.getByTestId('copilot-send').click()

  await expect(page.getByTestId('copilot-proposal')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('copilot-accept').click()
  expect(beforeEdit - (await durationOf())).toBe(1 * FLICKS_PER_SECOND)
  console.log('packaged app: bundled shim served an edit turn end to end')
  await app.close()
})
