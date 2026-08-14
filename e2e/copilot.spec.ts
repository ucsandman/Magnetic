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
    env: {
      ...process.env,
      MAGNETIC_TEST: '1',
      MAGNETIC_LIBRARY_PATH: libraryPath,
      MAGNETIC_CLAUDE_BIN: 'C:\\nonexistent\\claude.exe'
    }
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
  await expect(page.getByTestId('copilot-disclaimer')).toContainText('only when you Accept')
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

  // ==== phase 4: the copilot EDITS through the ghost-diff gate ====
  const durationOf = async (): Promise<number> => {
    const state = (await page.evaluate(() =>
      (
        window as unknown as {
          __magneticState(): { sequence: { spine: { durationFlicks: number }[] } }
        }
      ).__magneticState()
    )) as { sequence: { spine: { durationFlicks: number }[] } }
    return state.sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
  }
  const beforeEdit = await durationOf()

  // scripted tool calls run through the REAL executor against a scratch copy
  await page.evaluate(() => {
    const hooked = window as unknown as {
      __magneticFakeAdvisor?: (input: { context: string; question: string }) => unknown
    }
    hooked.__magneticFakeAdvisor = () => ({
      reply: 'Cut the 1.5s pause at 0:02.0–0:03.5. Preview is on your timeline.',
      toolCalls: [{ name: 'ripple_delete_range', input: { from_sec: 2, to_sec: 3.5 } }]
    })
  })
  await page.getByTestId('copilot-question').fill('tighten this — remove the pause')
  await page.getByTestId('copilot-send').click()

  // proposal card appears; the actual sequence is UNTOUCHED
  await expect(page.getByTestId('copilot-proposal')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('copilot-change-0')).toContainText('0:02.0')
  expect(await durationOf()).toBe(beforeEdit)

  // Accept commits the batch as ONE undo step
  await page.getByTestId('copilot-accept').click()
  const afterAccept = await durationOf()
  expect(beforeEdit - afterAccept).toBe(1.5 * 705_600_000)
  await expect(page.getByTestId('copilot-proposal')).not.toBeVisible()
  console.log(
    `copilot edit accepted: ${(beforeEdit / 705_600_000).toFixed(1)}s -> ${(afterAccept / 705_600_000).toFixed(1)}s`
  )

  // one Ctrl+Z restores the whole batch
  await page.getByTestId('copilot-log').click()
  await page.keyboard.press('Control+z')
  expect(await durationOf()).toBe(beforeEdit)
  console.log('one undo restored the pre-copilot sequence')

  await app.close()
})

test('phase 5: partial accept, A/B frames, attribution', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-copilot5-'))
  // VIDEO fixture: testsrc2 has a moving clock, so frames at different times
  // genuinely differ — the A/B panes must show real, distinct pixels.
  const fixture = join(tempRoot, 'demo.mp4')
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30:duration=10',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='if(lt(t,4),0.5*sin(880*2*PI*t),if(lt(t,6),0,0.5*sin(880*2*PI*t)))':s=8000:d=10",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    fixture
  ])
  const app = await launchApp(join(tempRoot, 'Copilot5.mglib'))
  const page = await app.firstWindow()
  await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-demo.mp4').click()
  await page.keyboard.press('e')

  interface ProbeState {
    sequence: { spine: { id: string; durationFlicks: number }[] }
    attributions: [string, { actor: string; atMs: number }][]
  }
  const stateOf = (): Promise<ProbeState> =>
    page.evaluate(() =>
      (
        window as unknown as {
          __magneticState(): {
            sequence: { spine: { id: string; durationFlicks: number }[] }
            attributions: [string, { actor: string; atMs: number }][]
          }
        }
      ).__magneticState()
    )
  const clipId = (await stateOf()).sequence.spine[0].id

  await page.getByTestId('browser-tab-copilot').click()
  await page.getByTestId('copilot-key-input').fill('sk-ant-test-key-not-real')
  await page.getByTestId('copilot-key-save').click()

  // 3 ops: a position-addressed range delete + two id-addressed relative
  // trims — the dependency rules must yield THREE independent groups
  await page.evaluate((id) => {
    const hooked = window as unknown as { __magneticFakeAdvisor?: () => unknown }
    hooked.__magneticFakeAdvisor = () => ({
      reply: 'Cut the dead air and tightened both ends — preview on the timeline.',
      toolCalls: [
        { name: 'ripple_delete_range', input: { from_sec: 4, to_sec: 6 } },
        { name: 'trim_clip', input: { clip_id: id, edge: 'head', delta_sec: 1 } },
        { name: 'trim_clip', input: { clip_id: id, edge: 'tail', delta_sec: -1 } }
      ]
    })
  }, clipId)
  await page.getByTestId('copilot-question').fill('tighten everything')
  await page.getByTestId('copilot-send').click()
  await expect(page.getByTestId('copilot-proposal')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('copilot-group-2')).toBeVisible()

  // ---- A/B panes render real, differing frames (the phase-5 spike proof) ----
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('[data-testid="ab-before"]') as HTMLCanvasElement
      const ctx = canvas?.getContext('2d')
      if (!ctx) return false
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 0; i < data.length; i += 977) if (data[i] > 16) return true
      return false
    },
    undefined,
    { timeout: 30_000 }
  )
  const probe = await page.evaluate(() => {
    const read = (testId: string): number => {
      const canvas = document.querySelector(`[data-testid="${testId}"]`) as HTMLCanvasElement | null
      const ctx = canvas?.getContext('2d')
      if (!ctx || canvas === null) return -1
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let sum = 0
      for (let i = 0; i < data.length; i += 977) sum += data[i]
      return sum
    }
    return { before: read('ab-before'), after: read('ab-after') }
  })
  expect(probe.before).toBeGreaterThan(0)
  expect(probe.after).toBeGreaterThan(0)
  expect(probe.before).not.toBe(probe.after)
  console.log(`A/B frames rendered and differ: ${probe.before} vs ${probe.after}`)

  // ---- uncheck the range delete; accept only the two trims ----
  const before = (await stateOf()).sequence.spine.reduce((s, i) => s + i.durationFlicks, 0)
  await page.getByTestId('copilot-group-0').uncheck()
  await expect(page.getByTestId('copilot-accept')).toContainText('2 selected')
  await page.getByTestId('copilot-accept').click()
  await expect(page.getByTestId('copilot-proposal')).not.toBeVisible()
  const after = (await stateOf()).sequence.spine.reduce((s, i) => s + i.durationFlicks, 0)
  expect(before - after).toBe(2 * 705_600_000) // trims only: 2s, NOT the range's 2s more
  console.log('partial accept: range delete excluded, both trims landed')

  // ---- attribution recorded for the touched clip ----
  const attributions = (await stateOf()).attributions
  expect(attributions.length).toBeGreaterThan(0)
  expect(attributions[0][1].actor).toBe('Copilot')

  // ---- one Ctrl+Z reverts the partial accept ----
  await page.getByTestId('copilot-log').click()
  await page.keyboard.press('Control+z')
  expect((await stateOf()).sequence.spine.reduce((s, i) => s + i.durationFlicks, 0)).toBe(before)
  console.log('one undo restored the pre-partial-accept sequence')

  await app.close()
})
