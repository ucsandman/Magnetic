import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Clip, Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000

// canvas layout constants mirrored from src/renderer/timeline/render.ts
const RULER_H = 26
const LANE_H = 32
const SPINE_H = 48
const GUTTER = 4

interface SplitTestState {
  sequence: Sequence | null
  playheadFlicks: number
  zoomPxPerSec: number
  snapping: boolean
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<SplitTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): SplitTestState }).__magneticState()
  )
}

async function waitForTimeline(page: Page): Promise<void> {
  await expect(page.getByTestId('timeline-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
}

function xForTime(state: SplitTestState, flicks: number): number {
  return (flicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
}

/** rowLayout math mirrored from render.ts, derived from CURRENT state (lanes shift rows). */
function laneCenterY(state: SplitTestState, lane: number): number {
  let maxVideo = 1
  for (const cc of state.sequence!.connected) {
    if (cc.lane > maxVideo) maxVideo = cc.lane
  }
  const spineY = RULER_H + GUTTER + maxVideo * (LANE_H + GUTTER)
  if (lane === 0) return spineY + SPINE_H / 2
  if (lane > 0) return RULER_H + GUTTER + (maxVideo - lane) * (LANE_H + GUTTER) + LANE_H / 2
  return spineY + SPINE_H + GUTTER + (-lane - 1) * (LANE_H + GUTTER) + LANE_H / 2
}

function audioRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hooks = window as unknown as { __magneticTimeline: { playback: { rms(): number } } }
    return hooks.__magneticTimeline.playback.rms()
  })
}

test('split edits: detach audio, J-cut via canvas trim, audible lead, undo, persistence', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-split-'))
  const libraryPath = join(tempRoot, 'SplitEdits.mglib')
  let app = await launchApp(libraryPath)
  let page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'bars-1080p30.mp4')]
  )
  expect(imported.errors).toEqual([])
  await waitForTimeline(page)
  await expect(page.getByTestId('asset-strip')).toHaveCount(1, { timeout: 60_000 })

  const library = await page.evaluate(() => window.api.getLibrary())
  const bars = Object.values(library.assets)[0]

  // ---- one bars clip, bladed in the middle: the tail half gets mediaIn > 0 ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  for (let i = 0; i < 5; i++) await page.keyboard.press('-')
  let state = await getState(page)
  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  await page.mouse.click(bounds.x + xForTime(state, bars.durationFlicks / 2), bounds.y + 10)
  await page.keyboard.press('Control+b')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)
  const [headId, tailId] = state.sequence!.spine.map((item) => item.id)
  const headDur = state.sequence!.spine[0].durationFlicks
  const tailDur = state.sequence!.spine[1].durationFlicks
  expect((state.sequence!.spine[1] as Clip).mediaInFlicks).toBe(headDur)
  const preDetach = state.sequence

  // ---- Detach Audio on both halves via the DOM context menu ----
  for (const [clipId, centerFlicks] of [
    [headId, headDur / 2],
    [tailId, headDur + tailDur / 2]
  ] as const) {
    state = await getState(page)
    await page.mouse.click(
      bounds.x + xForTime(state, centerFlicks),
      bounds.y + laneCenterY(state, 0),
      {
        button: 'right'
      }
    )
    await expect(page.getByTestId('context-menu')).toBeVisible()
    await expect(page.getByTestId('context-detach-audio')).toBeEnabled()
    await page.getByTestId('context-detach-audio').click()
    state = await getState(page)
    const spineClip = state.sequence!.spine.find((item) => item.id === clipId) as Clip
    expect(spineClip.audioDisabled).toBe(true)
  }
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(2)
  const headAudio = state.sequence!.connected.find((cc) => cc.parentClipId === headId)!
  const tailAudio = state.sequence!.connected.find((cc) => cc.parentClipId === tailId)!
  for (const [audio, parentDur, parentMediaIn] of [
    [headAudio, headDur, 0],
    [tailAudio, tailDur, headDur]
  ] as const) {
    expect(audio.lane).toBe(-1)
    expect(audio.offsetFlicks).toBe(0)
    expect(audio.mediaInFlicks).toBe(parentMediaIn)
    expect(audio.durationFlicks).toBe(parentDur)
    expect(audio.assetId).toBe(bars.id)
  }

  // ---- L-cut: drag the head clip's audio TAIL edge left (audio ends early) ----
  await page.keyboard.press('n') // snapping off → pixel-driven deltas
  state = await getState(page)
  expect(state.snapping).toBe(false)
  const audioY = bounds.y + laneCenterY(state, -1)
  const lCutPx = xForTime(state, headDur / 2) // pull back ~half the head clip
  const headAudioEndX = bounds.x + xForTime(state, headDur)
  await page.mouse.move(headAudioEndX - 2, audioY)
  await page.mouse.down()
  await page.mouse.move(headAudioEndX - 2 - lCutPx, audioY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  const headAudioAfter = state.sequence!.connected.find((cc) => cc.id === headAudio.id)!
  expect(headAudioAfter.durationFlicks).toBeLessThan(headDur)
  expect(headAudioAfter.mediaInFlicks).toBe(0) // tail trim leaves the in-point alone
  expect(headAudioAfter.offsetFlicks).toBe(0)
  const headAudioEnd = headAudioAfter.durationFlicks

  // ---- J-cut: drag the tail clip's audio HEAD edge left of its parent ----
  // shorter than the L-cut pull-back, so the lead region overlaps no other audio
  const jCutPx = Math.round(lCutPx * 0.6)
  const tailAudioStartX = bounds.x + xForTime(state, headDur)
  await page.mouse.move(tailAudioStartX + 2, audioY)
  await page.mouse.down()
  await page.mouse.move(tailAudioStartX + 2 - jCutPx, audioY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  const tailAudioAfter = state.sequence!.connected.find((cc) => cc.id === tailAudio.id)!
  const offset = tailAudioAfter.offsetFlicks
  expect(offset).toBeLessThan(0) // the J-cut: audio leads the parent's video
  expect(tailAudioAfter.mediaInFlicks).toBe(headDur + offset) // earlier media revealed
  expect(tailAudioAfter.durationFlicks).toBe(tailDur - offset) // grew by the same flicks
  expect(tailAudioAfter.lane).toBe(-1) // no overlap with the L-cut head audio
  const leadStart = headDur + offset // absolute start of the audio lead
  expect(leadStart).toBeGreaterThan(headAudioEnd) // [leadStart, headDur) is J-cut-only audio
  const finalSequence = state.sequence

  // ---- Audible proof: in the lead region the ONLY audio is the detached J-cut clip ----
  // warm-up play: PCM extraction + decode happen once, off the measured path
  await page.keyboard.press('Home')
  await page.keyboard.press('Space')
  await expect.poll(() => audioRms(page), { timeout: 30_000 }).toBeGreaterThan(0.005)
  await page.keyboard.press('k')
  await expect.poll(() => audioRms(page), { timeout: 10_000 }).toBeLessThan(0.005)
  // seek into the lead region (before the parent's video starts) and play
  const seekTarget = leadStart + (headDur - leadStart) / 4
  await page.mouse.click(bounds.x + xForTime(state, seekTarget), bounds.y + 10)
  state = await getState(page)
  expect(state.playheadFlicks).toBeGreaterThan(headAudioEnd)
  expect(state.playheadFlicks).toBeLessThan(headDur)
  await page.keyboard.press('Space')
  // audio is audible WHILE the playhead is still before the parent's video start
  await expect
    .poll(
      async () => {
        const probe = await page.evaluate(() => {
          const hooks = window as unknown as {
            __magneticTimeline: { playback: { rms(): number } }
            __magneticState(): { playheadFlicks: number }
          }
          return {
            rms: hooks.__magneticTimeline.playback.rms(),
            playheadFlicks: hooks.__magneticState().playheadFlicks
          }
        })
        if (probe.rms > 0.005) {
          expect(probe.playheadFlicks).toBeLessThan(headDur)
          return true
        }
        return false
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await page.keyboard.press('k')
  await expect.poll(() => audioRms(page), { timeout: 10_000 }).toBeLessThan(0.005)

  // ---- Undo the four ops (J-cut, L-cut, detach ×2) → exact pre-detach sequence ----
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z')
  state = await getState(page)
  expect(state.sequence).toEqual(preDetach)
  // redo back to the final split-edit state
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Shift+z')
  state = await getState(page)
  expect(state.sequence).toEqual(finalSequence)

  // ---- Relaunch against the same library: the detached state persisted ----
  await page.waitForTimeout(900) // renderer debounce (250ms) + main autosave (500ms)
  await app.close()
  app = await launchApp(libraryPath)
  page = await app.firstWindow()
  await waitForTimeline(page)
  const restored = await getState(page)
  expect(restored.sequence).toEqual(finalSequence)
  await app.close()
})
