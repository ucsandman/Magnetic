import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000
const FRAME_FLICKS = FLICKS_PER_SECOND / 30

interface CaptionsTestState {
  sequence: Sequence | null
  playheadFlicks: number
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<CaptionsTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): CaptionsTestState }).__magneticState()
  )
}

/**
 * Count bright pixels in the caption band (bottom-center of the 1920×1080
 * framebuffer). speech.wav has no video, so the frame is black except for the
 * burned-in caption — white text reads as high luminance.
 */
function captionBrightCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hooks = window as unknown as {
      __magneticTimeline: {
        playback: { readPixels(x: number, y: number, w: number, h: number): number[] }
      }
    }
    const data = hooks.__magneticTimeline.playback.readPixels(460, 890, 1000, 130)
    let bright = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 300) bright += 1
    }
    return bright
  })
}

function seekTo(page: Page, flicks: number): Promise<void> {
  return page.evaluate((target) => {
    const hooks = window as unknown as {
      __magneticTimeline: { playback: { seek(flicks: number): void } }
    }
    hooks.__magneticTimeline.playback.seek(target)
  }, flicks)
}

async function wordAttrs(
  page: Page,
  index: number
): Promise<{ text: string; start: number; end: number }> {
  const word = page.getByTestId(`transcript-word-${index}`)
  return {
    text: (await word.textContent())!.trim(),
    start: Number(await word.getAttribute('data-start')),
    end: Number(await word.getAttribute('data-end'))
  }
}

function srtTimestamp(flicks: number): string {
  const totalMs = Math.round((flicks / FLICKS_PER_SECOND) * 1000)
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${pad(Math.floor(totalMs / 3_600_000), 2)}:${pad(Math.floor(totalMs / 60_000) % 60, 2)}:${pad(
    Math.floor(totalMs / 1000) % 60,
    2
  )},${pad(totalMs % 1000, 3)}`
}

test('burned-in captions: pixel proof, edit-derived cues, sidecar export, undo', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-captions-'))
  const app = await launchApp(join(tempRoot, 'Captions.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'speech.wav')]
  )
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // append the speech clip while whisper runs in the background
  await page.getByTestId('asset-cell-speech.wav').click()
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)

  await page.waitForFunction(
    async () => {
      const lib = await window.api.getLibrary()
      return Object.values(lib.assets).some((asset) => asset.transcriptUrl !== undefined)
    },
    undefined,
    { timeout: 180_000 }
  )
  console.log('transcript job completed')

  await page.keyboard.press('Control+Shift+T')
  await expect(page.getByTestId('transcript-word-0')).toBeVisible({ timeout: 20_000 })
  const wordCount = await page.locator('[data-word-index]').count()
  expect(wordCount).toBeGreaterThan(40)

  // ---- enable captions in the Inspector (sequence-level, nothing selected) ----
  await expect(page.getByTestId('inspector-tab-captions')).toBeVisible()
  await page.getByTestId('captions-enabled').click()
  await page.getByTestId('captions-preset').selectOption('block')
  state = await getState(page)
  expect(state.sequence!.captions).toMatchObject({ enabled: true, preset: 'block' })

  // ---- undo toggles settings back (two ops → two undos → field gone) ----
  await page.getByTestId('panel-inspector').locator('.panel-header').click() // leave the input
  await page.keyboard.press('Control+z')
  state = await getState(page)
  expect(state.sequence!.captions).toMatchObject({ enabled: true, preset: 'pop-in' })
  await page.keyboard.press('Control+z')
  state = await getState(page)
  expect(state.sequence!.captions).toBeUndefined()
  await page.getByTestId('captions-enabled').click() // re-enable for the rest
  await page.getByTestId('captions-preset').selectOption('block')

  // ---- pixel proof: caption visible during a word, gone when disabled ----
  const word10 = await wordAttrs(page, 10)
  await page.getByTestId(`transcript-word-10`).click() // seeks + sequence viewer
  await expect(page.getByTestId('sequence-canvas')).toBeVisible()
  await seekTo(page, Math.round((word10.start + word10.end) / 2)) // mid-word
  await expect.poll(() => captionBrightCount(page), { timeout: 15_000 }).toBeGreaterThan(300)
  const visibleCount = await captionBrightCount(page)
  console.log(`caption bright pixels during "${word10.text}": ${visibleCount}`)

  await page.getByTestId('captions-enabled').click() // disable
  await expect.poll(() => captionBrightCount(page), { timeout: 15_000 }).toBeLessThan(50)
  await page.getByTestId('captions-enabled').click() // re-enable
  await expect.poll(() => captionBrightCount(page), { timeout: 15_000 }).toBeGreaterThan(300)

  // ---- caption disappears in silence (largest inter-word gap or tail) ----
  const words: { text: string; start: number; end: number }[] = []
  for (let i = 0; i < wordCount; i++) words.push(await wordAttrs(page, i))
  let silenceFlicks: number | null = null
  let largestGap = 0
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap > largestGap) {
      largestGap = gap
      silenceFlicks = Math.round(words[i - 1].end + gap / 2)
    }
  }
  const durationFlicks = (await getState(page)).sequence!.spine.reduce(
    (sum, item) => sum + item.durationFlicks,
    0
  )
  const lastEnd = words[words.length - 1].end
  if (largestGap <= 0.65 * FLICKS_PER_SECOND) {
    expect(durationFlicks - lastEnd).toBeGreaterThan(0.65 * FLICKS_PER_SECOND)
    silenceFlicks = Math.round(lastEnd + 0.3 * FLICKS_PER_SECOND)
  }
  console.log(`silence probe at ${(silenceFlicks! / FLICKS_PER_SECOND).toFixed(2)}s`)
  await seekTo(page, silenceFlicks!)
  await expect.poll(() => captionBrightCount(page), { timeout: 15_000 }).toBeLessThan(50)

  // ---- edit-by-transcript: ripple-delete words → cues re-derive ----
  const old5 = words[5]
  const deletedSpan = words[4].end - words[0].start
  const fromBox = (await page.getByTestId('transcript-word-0').boundingBox())!
  const toBox = (await page.getByTestId('transcript-word-4').boundingBox())!
  await page.mouse.move(fromBox.x + 4, fromBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(toBox.x + 4, toBox.y + 4, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.press('Delete')
  await expect.poll(() => page.locator('[data-word-index]').count()).toBeLessThan(wordCount)

  const newFirst = await wordAttrs(page, 0)
  expect(newFirst.text).toBe(old5.text) // words 0–4 are gone
  // remaining words shifted left by the deleted span (± snapping tolerance)
  expect(Math.abs(newFirst.start - (old5.start - deletedSpan))).toBeLessThanOrEqual(
    1.5 * FRAME_FLICKS
  )
  console.log(
    `ripple: "${newFirst.text}" moved ${((old5.start - newFirst.start) / FLICKS_PER_SECOND).toFixed(3)}s left`
  )
  await page.getByTestId('transcript-word-0').click() // seek to the shifted word
  await seekTo(page, Math.round((newFirst.start + newFirst.end) / 2))
  await expect.poll(() => captionBrightCount(page), { timeout: 15_000 }).toBeGreaterThan(300)

  // ---- SRT sidecar: file content matches the projected words and timings ----
  const visibleWords: string[] = []
  const remaining = await page.locator('[data-word-index]').count()
  for (let i = 0; i < remaining; i++) visibleWords.push((await wordAttrs(page, i)).text)

  const srtPath = join(tempRoot, 'captions.srt')
  await page.getByTestId('captions-destination').fill(srtPath)
  await page.getByTestId('captions-export-srt').click()
  await expect(page.getByTestId('captions-export-note')).toContainText('Saved', {
    timeout: 15_000
  })
  const srt = readFileSync(srtPath, 'utf8')
  expect(srt.startsWith('1\r\n')).toBe(true)
  expect(srt).toContain('\r\n')
  const srtBlocks = srt.trimEnd().split('\r\n\r\n')
  expect(srtBlocks.length).toBeGreaterThan(1)
  const srtTexts: string[] = []
  srtBlocks.forEach((block, index) => {
    const lines = block.split('\r\n')
    expect(lines[0]).toBe(String(index + 1)) // cue numbering
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/)
    srtTexts.push(lines.slice(2).join(' '))
  })
  // every projected word appears, in order, and cue 1 starts at the first word
  expect(srtTexts.join(' ')).toBe(visibleWords.join(' '))
  expect(srtBlocks[0].split('\r\n')[1].startsWith(srtTimestamp(newFirst.start))).toBe(true)
  console.log(`SRT: ${srtBlocks.length} cues, first at ${srtTimestamp(newFirst.start)}`)

  // ---- VTT sidecar: WEBVTT header, dot separator, same text ----
  const vttPath = join(tempRoot, 'captions.vtt')
  await page.getByTestId('captions-destination').fill(vttPath)
  await page.getByTestId('captions-export-vtt').click()
  await expect(page.getByTestId('captions-export-note')).toContainText('captions.vtt', {
    timeout: 15_000
  })
  const vtt = readFileSync(vttPath, 'utf8')
  expect(vtt.startsWith('WEBVTT\n')).toBe(true)
  expect(vtt).not.toContain('\r')
  const vttTimes = vtt.match(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/gm)
  expect(vttTimes?.length).toBe(srtBlocks.length)
  const vttTexts = vtt
    .split('\n')
    .filter((line) => line !== '' && line !== 'WEBVTT' && !line.includes('-->'))
  expect(vttTexts.join(' ')).toBe(visibleWords.join(' '))

  await app.close()
})
