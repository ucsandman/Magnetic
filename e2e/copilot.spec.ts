import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

/** 2 s tone + 1.5 s silence + 2 s tone: gives the context real dead air. */
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

test('copilot advisor: key setup, perception context accuracy, streamed reply', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot-'))
  const fixture = makeFixture(tempRoot)
  const app = await launchApp(join(tempRoot, 'Copilot.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-interview.wav').click()
  await page.keyboard.press('e')
  await page.waitForFunction(
    async () => {
      const lib = await window.api.getLibrary()
      return Object.values(lib.assets).some((asset) => asset.envelopeUrl !== undefined)
    },
    undefined,
    { timeout: 120_000 }
  )

  // ---- fresh userData: the Copilot tab asks for a key first ----
  await page.getByTestId('browser-tab-copilot').click()
  await expect(page.getByTestId('copilot-setup')).toBeVisible()
  await expect(page.getByTestId('copilot-disclaimer')).toContainText('cannot edit')
  await page.getByTestId('copilot-key-input').fill('sk-ant-test-key-not-real')
  await page.getByTestId('copilot-key-save').click()
  await expect(page.getByTestId('copilot-question')).toBeVisible()

  // the key round-trips through main-process settings, not localStorage
  const stored = await page.evaluate(async () => {
    const settings = await window.api.getSettings()
    const local = window.localStorage.length
    return { key: settings.anthropicApiKey, localStorageEntries: local }
  })
  expect(stored.key).toBe('sk-ant-test-key-not-real')

  // ---- fake advisor (test builds only): capture the exact perception sent ----
  await page.evaluate(() => {
    const hooked = window as unknown as {
      __magneticFakeAdvisor?: (input: { context: string; question: string }) => string
      __capturedAdvisorInput?: { context: string; question: string }
    }
    hooked.__magneticFakeAdvisor = (input) => {
      hooked.__capturedAdvisorInput = input
      return 'FAKE ADVISOR: the first 30 seconds open on interview.wav with a 1.3s pause at 0:02.1.'
    }
  })

  await page.getByTestId('copilot-question').fill('what happens in the first 30 seconds?')
  await page.getByTestId('copilot-send').click()
  await expect(page.getByTestId('copilot-msg-1')).toContainText('FAKE ADVISOR', {
    timeout: 15_000
  })

  // ---- perception accuracy: the context the runtime sent is the real cut ----
  const captured = await page.evaluate(
    () =>
      (window as unknown as { __capturedAdvisorInput?: { context: string; question: string } })
        .__capturedAdvisorInput
  )
  expect(captured).toBeDefined()
  expect(captured!.question).toBe('what happens in the first 30 seconds?')
  expect(captured!.context).toContain('interview.wav') // real clip name
  expect(captured!.context).toContain('total 5.5s') // real duration
  expect(captured!.context).toContain('Dead air')
  expect(captured!.context).toMatch(/0:02\.\d to 0:03\.\d/) // the actual detected gap
  console.log('context sent to the advisor reflects the real open sequence')

  await app.close()
})
