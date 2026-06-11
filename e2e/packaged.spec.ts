import { _electron as electron, expect, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const PACKAGED_EXE = join(ROOT, 'dist', 'win-unpacked', 'Magnetic.exe')

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
