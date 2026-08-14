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

/**
 * Proves the subscription bridge end to end with zero network: a fake
 * `claude` CLI (e2e/fixtures/fake-claude.mjs) speaks the real headless
 * stream-json contract and drives the real MCP shim in copilot role, so a
 * tools/list round trip and a tools/call proves the whole loop.
 */

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fake-claude.cmd')
const FLICKS_PER_SECOND = 705_600_000

function launchApp(
  libraryPath: string,
  envOverrides: Record<string, string> = {}
): Promise<ElectronApplication> {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      MAGNETIC_TEST: '1',
      MAGNETIC_LIBRARY_PATH: libraryPath,
      MAGNETIC_CLAUDE_BIN: FAKE_CLAUDE,
      ...envOverrides
    }
  })
}

/** 2 s tone + 1.5 s silence + 2 s tone: real duration, real dead air. */
function makeFixture(dir: string): string {
  const fixture = join(dir, 'interview.wav')
  const expr = `if(lt(t,2),0.5*sin(880*2*PI*t),if(lt(t,3.5),0,0.5*sin(880*2*PI*t)))`
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${expr}':s=8000:d=5.5`,
    fixture
  ])
  return fixture
}

async function durationOf(page: Page): Promise<number> {
  const state = (await page.evaluate(() =>
    (
      window as unknown as {
        __magneticState(): { sequence: { spine: { durationFlicks: number }[] } }
      }
    ).__magneticState()
  )) as { sequence: { spine: { durationFlicks: number }[] } }
  return state.sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
}

/** Import a fixture, append it to the timeline, and open the Copilot tab. */
async function setupWithCopilot(
  tempRoot: string,
  envOverrides: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const fixture = makeFixture(tempRoot)
  const app = await launchApp(join(tempRoot, 'Sub.mglib'), envOverrides)
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
  return { app, page }
}

test('case 1: subscription auto-selected + plain reply', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot-sub-1-'))
  const { app, page } = await setupWithCopilot(tempRoot)

  await expect(page.getByTestId('provider-subscription')).toBeChecked()
  await expect(page.getByTestId('copilot-provider')).toContainText('9.9.9')

  await page.getByTestId('copilot-question').fill('hello there')
  await page.getByTestId('copilot-send').click()

  // fake-claude holds each delta open briefly so the streamed text is
  // actually observable before the final `result` event replaces it.
  await expect(page.getByTestId('copilot-streaming')).toContainText('Looking at the timeline')

  await expect(page.getByTestId('copilot-msg-1')).toContainText('first-session answer', {
    timeout: 15_000
  })
  await expect(page.getByTestId('copilot-proposal')).toHaveCount(0)

  await app.close()
})

test('case 2: edit turn -> ghost proposal -> accept -> one undo', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot-sub-2-'))
  const { app, page } = await setupWithCopilot(tempRoot)

  const beforeEdit = await durationOf(page)

  await page.getByTestId('copilot-question').fill('cut the first second')
  await page.getByTestId('copilot-send').click()

  await expect(page.getByTestId('copilot-proposal')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('copilot-change-0')).toBeVisible()
  expect(await durationOf(page)).toBe(beforeEdit) // ghost only — real sequence untouched

  await page.getByTestId('copilot-accept').click()
  const afterAccept = await durationOf(page)
  expect(beforeEdit - afterAccept).toBe(1 * FLICKS_PER_SECOND)
  await expect(page.getByTestId('copilot-proposal')).not.toBeVisible()

  await page.getByTestId('copilot-log').click()
  await page.keyboard.press('Control+z')
  expect(await durationOf(page)).toBe(beforeEdit)

  await app.close()
})

test('case 3: session resume passes --resume with the first session id', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot-sub-3-'))
  const { app, page } = await setupWithCopilot(tempRoot)

  await page.getByTestId('copilot-question').fill('hello there')
  await page.getByTestId('copilot-send').click()
  await expect(page.getByTestId('copilot-msg-1')).toContainText('first-session answer', {
    timeout: 15_000
  })

  await page.getByTestId('copilot-question').fill('still there?')
  await page.getByTestId('copilot-send').click()
  await expect(page.getByTestId('copilot-msg-3')).toContainText('resumed-session answer', {
    timeout: 15_000
  })

  await app.close()
})

test('case 4: CLI missing shows guidance and falls back to the API key provider', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot-sub-4-'))
  const { app, page } = await setupWithCopilot(tempRoot, {
    MAGNETIC_CLAUDE_BIN: 'C:\\nonexistent\\claude.exe'
  })

  // default provider falls back to apiKey when the CLI isn't found; select
  // subscription explicitly to see its missing-CLI guidance card
  await page.getByTestId('provider-subscription').click()
  await expect(page.getByTestId('copilot-cli-missing')).toBeVisible()
  await expect(page.getByTestId('copilot-cli-recheck')).toBeVisible()

  await page.getByTestId('provider-apikey').click()
  await expect(page.getByTestId('copilot-setup')).toBeVisible()

  await app.close()
})

test('case 5: abort surfaces an error quickly and re-enables input', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot-sub-5-'))
  const { app, page } = await setupWithCopilot(tempRoot, { FAKE_CLAUDE_MODE: 'hang' })

  await page.getByTestId('copilot-question').fill('hello there')
  await page.getByTestId('copilot-send').click()
  await expect(page.getByTestId('copilot-stop')).toBeVisible()

  await page.getByTestId('copilot-stop').click()
  await expect(page.getByTestId('copilot-error')).toContainText('stopped', { timeout: 5_000 })
  await expect(page.getByTestId('copilot-question')).toBeEnabled()

  await app.close()
})
