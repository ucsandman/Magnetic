import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')

test('Magnetic boots a dark 3-panel shell with secure renderer and healthy binaries', async () => {
  const app = await electron.launch({ args: [join(ROOT, 'out', 'main', 'index.js')] })
  const page = await app.firstWindow()

  await expect(page).toHaveTitle('Magnetic')
  await expect(page.getByTestId('panel-browser')).toBeVisible()
  await expect(page.getByTestId('panel-viewer')).toBeVisible()
  await expect(page.getByTestId('panel-timeline')).toBeVisible()

  // Security probes: nodeIntegration off (no require/process leaked into the
  // page) and the typed contextBridge API present — i.e. contextIsolation on.
  const probes = await page.evaluate(() => ({
    requireType: typeof (window as { require?: unknown }).require,
    processType: typeof (window as { process?: unknown }).process,
    apiType: typeof (window as { api?: unknown }).api
  }))
  expect(probes.requireType).toBe('undefined')
  expect(probes.processType).toBe('undefined')
  expect(probes.apiType).toBe('object')

  // Binary diagnostics: open the hidden debug panel, both probes must exit 0.
  await page.keyboard.press('Control+Shift+KeyD')
  await expect(page.getByTestId('diag-ffprobe-code')).toHaveText('0', { timeout: 30_000 })
  await expect(page.getByTestId('diag-whisper-code')).toHaveText('0')
  await page.keyboard.press('Control+Shift+KeyD')
  await expect(page.getByTestId('debug-panel')).toHaveCount(0)

  // Evidence screenshot of the dark 3-panel shell (inspector visible).
  const evidenceDir = join(ROOT, '.supergoal', 'evidence', 'phase-1')
  mkdirSync(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, 'shell.png') })

  // Inspector toggles via Ctrl+4.
  await expect(page.getByTestId('panel-inspector')).toBeVisible()
  await page.keyboard.press('Control+4')
  await expect(page.getByTestId('panel-inspector')).toBeHidden()
  await page.keyboard.press('Control+4')
  await expect(page.getByTestId('panel-inspector')).toBeVisible()

  await app.close()
})
