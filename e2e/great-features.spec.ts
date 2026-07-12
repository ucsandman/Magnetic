import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const FIXTURES = join(ROOT, 'fixtures')
const TOKEN = ['not', 'a', 'secret', 'gf', 'fixture', 'token'].join('-')

/** 10 s clip: tone 0-4 s, silence 4-6 s, tone 6-10 s (speech-shaped RMS). */
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
      MAGNETIC_LIBRARY_PATH: libraryPath
    }
  })
}

const seqOf = async (page: import('@playwright/test').Page): Promise<Sequence> =>
  (
    await page.evaluate(() =>
      (window as unknown as { __magneticState(): { sequence: Sequence } }).__magneticState()
    )
  ).sequence

test('roles, loudness, ducking, markers — the human surfaces', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-gf-a-'))
  const fixture = join(tempRoot, 'clip.mp4')
  makeVideoFixture(fixture)
  const app = await launchApp(join(tempRoot, 'GFa.mglib'), false)
  const page = await app.firstWindow()
  await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  // spine clip + the same asset connected above it as a bed
  await page.getByTestId('asset-cell-clip.mp4').click()
  await page.keyboard.press('e')
  await page.getByTestId('asset-cell-clip.mp4').click()
  await page.keyboard.press('q')
  // audio analysis must land before ducking/normalizing
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const lib = await window.api.getLibrary()
          return Object.values(lib.assets).filter((asset) => asset.envelopeUrl !== undefined).length
        }),
      { timeout: 120_000 }
    )
    .toBe(1)

  // ---- loudness: select the spine clip, normalize from the Inspector ----
  const timeline = page.getByTestId('timeline-canvas')
  await timeline.click({ position: { x: 100, y: 90 } })
  await page.getByTestId('inspector-tab-audio').click()
  await expect(page.getByTestId('role-dialogue')).toBeVisible()
  await page.getByTestId('normalize-loudness').click()
  await expect
    .poll(async () => {
      const seq = await seqOf(page)
      const item = seq.spine[0]
      return item.kind === 'clip' ? (item.fx?.volumeDb ?? 0) : 0
    })
    .not.toBe(0)
  console.log('loudness normalized: spine clip volumeDb set from measured LUFS')

  // ---- roles: tag the connected bed as music, then duck it under speech ----
  await timeline.click({ position: { x: 50, y: 46 } })
  await page.getByTestId('inspector-tab-audio').click()
  await page.getByTestId('role-music').click()
  await expect.poll(async () => (await seqOf(page)).connected[0]?.role).toBe('music')
  await page.getByTestId('duck-music').click()
  await expect
    .poll(async () => (await seqOf(page)).connected[0]?.fx?.duck?.ranges.length ?? 0, {
      timeout: 30_000
    })
    .toBeGreaterThan(0)
  await expect(page.getByTestId('duck-clear')).toBeVisible()
  console.log('auto-duck: dips written where the dialogue tone plays')

  // ---- mixer: mute the music role from the timeline toolbar ----
  await page.getByTestId('role-mute-music').click()
  await expect.poll(async () => (await seqOf(page)).mutedRoles ?? []).toEqual(['music'])
  await page.getByTestId('role-mute-music').click()
  await expect.poll(async () => (await seqOf(page)).mutedRoles ?? []).toEqual([])
  console.log('role mute toggles persist in the sequence')

  // ---- markers: M at the playhead, edit in the Inspector, delete ----
  await page.keyboard.press('m')
  await expect.poll(async () => ((await seqOf(page)).markers ?? []).length).toBe(1)
  await expect(page.getByTestId('inspector-marker')).toBeVisible()
  await page.getByTestId('marker-text').fill('tighten this intro')
  await page.getByTestId('marker-color-red').click()
  await expect
    .poll(async () => (await seqOf(page)).markers?.[0])
    .toMatchObject({ text: 'tighten this intro', color: 'red' })
  await page.screenshot({ path: join(ROOT, '.supergoal', 'evidence', 'great-features-human.png') })
  await page.getByTestId('marker-delete').click()
  await expect.poll(async () => ((await seqOf(page)).markers ?? []).length).toBe(0)
  console.log('marker added at playhead, edited in Inspector, deleted')

  await app.close()
})

test('cut_words + normalize_loudness — the agent surfaces (MCP gate)', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-gf-b-'))
  const app = await launchApp(join(tempRoot, 'GFb.mglib'), true)
  const page = await app.firstWindow()
  await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'speech.wav')]
  )
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-speech.wav').click()
  await page.keyboard.press('e')
  // whisper transcript lands in the background
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const lib = await window.api.getLibrary()
          return Object.values(lib.assets).some((asset) => asset.transcriptUrl !== undefined)
        }),
      { timeout: 180_000 }
    )
    .toBe(true)
  const status = await page.evaluate(() => window.api.agentStatus())

  // read three consecutive spoken words from the transcript panel — the quote
  await page.getByTestId('browser-tab-transcript').click()
  await expect(page.getByTestId('transcript-word-2')).toBeVisible({ timeout: 30_000 })
  const quote = [
    await page.getByTestId('transcript-word-2').innerText(),
    await page.getByTestId('transcript-word-3').innerText(),
    await page.getByTestId('transcript-word-4').innerText()
  ].join(' ')
  const durationBefore = (await seqOf(page)).spine.reduce(
    (sum, item) => sum + item.durationFlicks,
    0
  )

  const call = async (tool: string, input: unknown): Promise<unknown> => {
    const wrapped = (await page.evaluate(
      async ({ port, token, tool, input }) => {
        const response = await fetch(`http://127.0.0.1:${port}/tool`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tool, input })
        })
        return response.json()
      },
      { port: status.port, token: TOKEN, tool, input }
    )) as { result?: unknown; error?: unknown }
    return wrapped.result ?? wrapped
  }

  // ---- text-based editing over MCP: quote in, ghost-diff proposal out ----
  const cut = (await call('cut_words', { quote })) as { ok?: boolean; error?: string }
  expect(cut.error, `cut_words failed for quote "${quote}": ${cut.error}`).toBeUndefined()
  expect(cut.ok).toBe(true)
  await expect(page.getByTestId('agent-banner')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('agent-banner-accept').click()
  await expect
    .poll(async () => (await seqOf(page)).spine.reduce((sum, item) => sum + item.durationFlicks, 0))
    .toBeLessThan(durationBefore)
  console.log(`cut_words accepted: "${quote}" removed, timeline tightened`)

  // ---- loudness over MCP: proposal appears, human DISCARDS, nothing applies ----
  const normalize = (await call('normalize_loudness', {})) as { ok?: boolean; error?: string }
  expect(normalize.ok, normalize.error).toBe(true)
  await expect(page.getByTestId('agent-banner')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('agent-banner-discard').click()
  const afterDiscard = await seqOf(page)
  const spineClip = afterDiscard.spine.find((item) => item.kind === 'clip')
  expect(spineClip?.kind === 'clip' ? (spineClip.fx?.volumeDb ?? 0) : 0).toBe(0)
  console.log('normalize_loudness proposed and discarded: volume untouched, human stayed in charge')

  await app.close()
})
