import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const SEC = 705_600_000

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

interface ProbeState {
  sequence: { spine: { id: string; durationFlicks: number }[] }
  playheadFlicks: number
  flowScore: number | null
  flowFlags: { flicks: number; kind: string; message: string }[] | null
}

test('phase 6: voice cleanup sidecar + flow self-check flags', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-denoise-'))
  // video with a noisy voice-band tone and a silence gap in the middle
  const fixture = join(tempRoot, 'noisy.mp4')
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
    "aevalsrc='if(lt(t,4),0.4*sin(880*2*PI*t)+0.1*random(0),if(lt(t,6),0,0.4*sin(880*2*PI*t)+0.1*random(0)))':s=48000:d=10",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    fixture
  ])
  const app = await launchApp(join(tempRoot, 'Denoise.mglib'))
  const page = await app.firstWindow()
  await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-noisy.mp4').click()
  await page.keyboard.press('e')

  // ---- Clean Up Audio via the asset context menu ----
  await page.getByTestId('asset-cell-noisy.mp4').click({ button: 'right' })
  await page.getByText('Clean Up Audio').click()
  // NOTE: waitForFunction(async …) resolves immediately (the returned Promise
  // is truthy before it settles) — expect.poll awaits the predicate properly.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const lib = await window.api.getLibrary()
          return Object.values(lib.assets).some((asset) => asset.denoisedUrl !== undefined)
        }),
      { timeout: 120_000 }
    )
    .toBe(true)
  console.log('denoise sidecar produced')

  // the playback/export PCM now derives from the denoised track
  const assetId = await page.evaluate(async () => {
    const lib = await window.api.getLibrary()
    return Object.keys(lib.assets)[0]
  })
  const pcmUrl = await page.evaluate((id) => window.api.ensurePcm(id), assetId)
  expect(pcmUrl).toContain('.denoised')
  console.log(`pcm prefers denoised: ${pcmUrl}`)

  // ---- copilot accept produces a flow report with flags ----
  await page.getByTestId('browser-tab-copilot').click()
  await page.getByTestId('copilot-key-input').fill('sk-ant-test-key-not-real')
  await page.getByTestId('copilot-key-save').click()
  const clipId = await page.evaluate(
    () =>
      (window as unknown as { __magneticState(): ProbeState }).__magneticState().sequence.spine[0]
        .id
  )
  // deleting mid-clip leaves an untransitioned same-asset jump cut → a flag
  await page.evaluate((id) => {
    const hooked = window as unknown as { __magneticFakeAdvisor?: () => unknown }
    hooked.__magneticFakeAdvisor = () => ({
      reply: 'Removed the dead air. One jump cut remains — see the flow flags.',
      toolCalls: [{ name: 'ripple_delete_range', input: { from_sec: 4, to_sec: 6 } }]
    })
    void id
  }, clipId)
  await page.getByTestId('copilot-question').fill('cut the dead air')
  await page.getByTestId('copilot-send').click()
  await expect(page.getByTestId('copilot-proposal')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('copilot-accept').click()

  await expect(page.getByTestId('flow-chip')).toBeVisible()
  const state = (await page.evaluate(() =>
    (window as unknown as { __magneticState(): ProbeState }).__magneticState()
  )) as ProbeState
  expect(state.flowScore).not.toBeNull()
  expect(state.flowScore!).toBeLessThan(100)
  const jumpFlag = state.flowFlags!.find((flag) => flag.kind === 'jump-cut')
  expect(jumpFlag).toBeDefined()
  console.log(`flow score ${state.flowScore}, ${state.flowFlags!.length} flag(s)`)

  // ---- clicking the ruler at the flag position seeks the playhead there ----
  const flagX = Math.round((jumpFlag!.flicks / SEC) * 60) // 60 px/s default zoom
  const timeline = page.getByTestId('timeline-canvas')
  await timeline.click({ position: { x: flagX, y: 10 } })
  const after = (await page.evaluate(() =>
    (window as unknown as { __magneticState(): ProbeState }).__magneticState()
  )) as ProbeState
  expect(Math.abs(after.playheadFlicks - jumpFlag!.flicks)).toBeLessThan(SEC / 2)
  console.log('ruler click at the flag seeks the playhead to the flagged moment')

  await app.close()
})
