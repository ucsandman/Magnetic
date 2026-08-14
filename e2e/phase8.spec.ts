import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const TOKEN = ['not', 'a', 'secret', 'p8', 'fixture', 'token'].join('-')

function makeVideoFixture(path: string): void {
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
    "aevalsrc='if(lt(t,4),0.4*sin(880*2*PI*t),if(lt(t,6),0,0.4*sin(880*2*PI*t)))':s=48000:d=10",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    path
  ])
}

function launchApp(libraryPath: string, agent: boolean): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      MAGNETIC_TEST: '1',
      ...(agent ? { MAGNETIC_AGENT: '1', MAGNETIC_AGENT_TOKEN: TOKEN } : {}),
      MAGNETIC_LIBRARY_PATH: libraryPath,
      MAGNETIC_CLAUDE_BIN: 'C:\\nonexistent\\claude.exe'
    }
  })
}

test('gesture-queue: a mid-drag agent proposal parks, then lands after the drag', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-p8a-'))
  const fixture = join(tempRoot, 'clip.mp4')
  makeVideoFixture(fixture)
  const app = await launchApp(join(tempRoot, 'P8a.mglib'), true)
  const page = await app.firstWindow()
  await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-clip.mp4').click()
  await page.keyboard.press('e')
  const status = await page.evaluate(() => window.api.agentStatus())

  // start a real drag on the clip body (mousedown, hold)
  const timeline = page.getByTestId('timeline-canvas')
  await timeline.hover({ position: { x: 100, y: 90 } })
  await page.mouse.down()

  // fire an external proposal WITHOUT awaiting it — it must park
  await page.evaluate(
    ({ port, token }) => {
      void fetch(`http://127.0.0.1:${port}/tool`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'propose_edits',
          input: { ops: [{ name: 'ripple_delete_range', input: { from_sec: 4, to_sec: 6 } }] }
        })
      })
    },
    { port: status.port, token: TOKEN }
  )
  await expect(page.getByTestId('agent-queued-banner')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('agent-banner')).not.toBeVisible()
  console.log('proposal parked behind the active gesture')

  // release the drag: the queued request lands as a normal ghost-diff proposal
  await page.mouse.up()
  await expect(page.getByTestId('agent-banner')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('agent-queued-banner')).not.toBeVisible()
  console.log('queued proposal presented after the gesture ended')

  await app.close()
})

test('draft queue: imported footage becomes rough-cut draft cards', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-p8b-'))
  const clipA = join(tempRoot, 'raw-a.mp4')
  const clipB = join(tempRoot, 'raw-b.mp4')
  makeVideoFixture(clipA)
  makeVideoFixture(clipB)
  const app = await launchApp(join(tempRoot, 'P8b.mglib'), false)
  const page = await app.firstWindow()
  await page.evaluate((paths) => window.api.__test!.importPaths(paths), [clipA, clipB])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  // wait for envelope analysis so cards can compute stats
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const lib = await window.api.getLibrary()
          return Object.values(lib.assets).filter((asset) => asset.envelopeUrl !== undefined).length
        }),
      { timeout: 120_000 }
    )
    .toBe(2)

  // hands-off: the Rough Cut tab shows one draft card per analyzed asset
  await page.getByTestId('browser-tab-roughcut').click()
  await expect(page.getByTestId('draft-card-0')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('draft-card-1')).toBeVisible()
  await expect(page.getByTestId('draft-stats-0')).toContainText('cut', { timeout: 30_000 })
  console.log('two draft cards with rough-cut stats')

  // loading a draft appends the clip and proposes its cuts as a ghost diff
  await page.getByTestId('draft-load-0').click()
  await expect(page.getByTestId('roughcut-proposal-summary')).toBeVisible({ timeout: 15_000 })
  const stateBefore = (await page.evaluate(() =>
    (
      window as unknown as {
        __magneticState(): { sequence: { spine: { durationFlicks: number }[] } }
      }
    ).__magneticState()
  )) as { sequence: { spine: { durationFlicks: number }[] } }
  const appended = stateBefore.sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
  expect(appended).toBe(10 * 705_600_000) // full clip appended, cuts still only proposed

  await page.getByTestId('roughcut-accept').click()
  await expect(page.getByTestId('roughcut-review-summary')).toBeVisible()
  const stateAfter = (await page.evaluate(() =>
    (
      window as unknown as {
        __magneticState(): { sequence: { spine: { durationFlicks: number }[] } }
      }
    ).__magneticState()
  )) as { sequence: { spine: { durationFlicks: number }[] } }
  const tightened = stateAfter.sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
  expect(tightened).toBeLessThan(appended)
  console.log(
    `draft accepted: ${(appended / 705_600_000).toFixed(1)}s -> ${(tightened / 705_600_000).toFixed(1)}s`
  )
  await app.close()
})
