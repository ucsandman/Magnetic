import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Clip, Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const EVIDENCE = join(ROOT, '.supergoal', 'evidence', 'phase-6')
const FLICKS_PER_SECOND = 705_600_000

interface ToolsTestState {
  sequence: Sequence | null
  playheadFlicks: number
  zoomPxPerSec: number
  snapping: boolean
  tool: 'select' | 'blade' | 'trim'
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<ToolsTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): ToolsTestState }).__magneticState()
  )
}

function durations(state: ToolsTestState): number[] {
  return state.sequence!.spine.map((item) => item.durationFlicks)
}

function total(state: ToolsTestState): number {
  return durations(state).reduce((a, b) => a + b, 0)
}

function startOf(state: ToolsTestState, index: number): number {
  return durations(state)
    .slice(0, index)
    .reduce((a, b) => a + b, 0)
}

function xForTime(state: ToolsTestState, flicks: number): number {
  return (flicks / FLICKS_PER_SECOND) * state.zoomPxPerSec
}

async function cursorStyle(page: Page): Promise<string> {
  return page
    .getByTestId('timeline-canvas')
    .evaluate((el) => (el as HTMLElement).style.cursor || 'default')
}

test('tools: blade, ripple trim, roll, slip, rearrange, Esc cancel, undo storm', async () => {
  test.setTimeout(240_000)
  mkdirSync(EVIDENCE, { recursive: true })
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-tools-'))
  const app = await launchApp(join(tempRoot, 'Tools.mglib'))
  const page = await app.firstWindow()

  const imported = await page.evaluate(
    (paths) => window.api.__test!.importPaths(paths),
    [join(FIXTURES, 'bars-1080p30.mp4')]
  )
  expect(imported.errors).toEqual([])
  await expect(page.getByTestId('timeline-canvas')).toBeVisible()
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await expect(page.getByTestId('asset-strip')).toHaveCount(1, { timeout: 60_000 })

  // ---- three 10s clips, zoomed out to fit ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.keyboard.press('e')
  await page.keyboard.press('e')
  for (let i = 0; i < 5; i++) await page.keyboard.press('-')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const spineY = bounds.y + 26 + 4 + 36 + 24

  // ---- Tool shortcuts switch tool + cursor ----
  await page.keyboard.press('b')
  state = await getState(page)
  expect(state.tool).toBe('blade')
  await page.mouse.move(bounds.x + xForTime(state, 15 * FLICKS_PER_SECOND), spineY)
  expect(await cursorStyle(page)).toBe('crosshair')
  await page.keyboard.press('t')
  expect((await getState(page)).tool).toBe('trim')
  await page.mouse.move(bounds.x + xForTime(state, 15 * FLICKS_PER_SECOND) + 1, spineY)
  expect(await cursorStyle(page)).toBe('ew-resize')
  await page.keyboard.press('a')
  expect((await getState(page)).tool).toBe('select')

  // ---- Ctrl+B blades the clip under the playhead: count +1, sum unchanged ----
  await page.mouse.click(bounds.x + xForTime(state, 5 * FLICKS_PER_SECOND), bounds.y + 10)
  state = await getState(page)
  const totalBeforeBlade = total(state)
  await page.keyboard.press('Control+b')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(4)
  expect(total(state)).toBe(totalBeforeBlade)
  const [head, tail] = state.sequence!.spine.slice(0, 2) as Clip[]
  expect(head.durationFlicks + tail.durationFlicks).toBe(10 * FLICKS_PER_SECOND)

  // ---- Blade tool click also splits ----
  await page.keyboard.press('b')
  await page.mouse.click(bounds.x + xForTime(state, 15 * FLICKS_PER_SECOND), spineY)
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(5)
  expect(total(state)).toBe(totalBeforeBlade)
  await page.keyboard.press('a')

  // ---- Ripple trim: clip shortens, downstream shifts left by the same amount ----
  await page.keyboard.press('n') // snapping off → pure pixel-driven delta
  state = await getState(page)
  expect(state.snapping).toBe(false)
  const trimIndex = 2 // a 5s+ clip in the middle ([h1, t1(5s), b2a(5s), b2b(5s), c3(10s)])
  const before = durations(state)
  const downstreamStartBefore = startOf(state, trimIndex + 1)
  const edgeX = bounds.x + xForTime(state, startOf(state, trimIndex + 1)) // tail edge of trimIndex
  await page.mouse.move(edgeX - 2, spineY)
  await page.mouse.down()
  await page.mouse.move(edgeX - 40, spineY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  const after = durations(state)
  const delta = before[trimIndex] - after[trimIndex]
  expect(delta).toBeGreaterThan(0)
  // every downstream clip kept its duration and moved left by exactly delta
  expect(after.slice(trimIndex + 1)).toEqual(before.slice(trimIndex + 1))
  expect(startOf(state, trimIndex + 1)).toBe(downstreamStartBefore - delta)
  console.log(
    `ripple trim: clip ${trimIndex} shortened by ${delta} flicks; downstream shifted left by ${delta}`
  )

  // ---- Roll: edit point moves, total duration unchanged ----
  await page.keyboard.press('t')
  state = await getState(page)
  const rollBefore = durations(state)
  const rollTotal = total(state)
  // the blade-cut boundary: the head half has tail media headroom, so the
  // roll can actually move (full-source clip boundaries are clamped to 0)
  const rollIndex = 0
  const rollX = bounds.x + xForTime(state, startOf(state, rollIndex + 1))
  await page.mouse.move(rollX, spineY)
  expect(await cursorStyle(page)).toBe('col-resize')
  await page.mouse.down()
  await page.mouse.move(rollX + 30, spineY, { steps: 6 })
  // mid-drag evidence: ghost edge + frame-delta tooltip + snap state
  await page.screenshot({ path: join(EVIDENCE, 'trimming.png') })
  await page.mouse.up()
  state = await getState(page)
  const rollAfter = durations(state)
  const rollDelta = rollAfter[rollIndex] - rollBefore[rollIndex]
  expect(rollDelta).toBeGreaterThan(0)
  expect(rollBefore[rollIndex + 1] - rollAfter[rollIndex + 1]).toBe(rollDelta)
  expect(total(state)).toBe(rollTotal)
  console.log(
    `roll: edit point ${rollIndex} moved ${rollDelta} flicks; total unchanged at ${rollTotal}`
  )

  // ---- Slip: media in/out change, timeline position does not ----
  state = await getState(page)
  const slipIndex = 1 // tail half of the first blade → mediaIn > 0, has headroom
  const slipClipBefore = state.sequence!.spine[slipIndex] as Clip
  expect(slipClipBefore.kind).toBe('clip')
  const slipStartBefore = startOf(state, slipIndex)
  const slipBodyX = bounds.x + xForTime(state, slipStartBefore + slipClipBefore.durationFlicks / 2)
  await page.mouse.move(slipBodyX, spineY)
  await page.mouse.down()
  await page.mouse.move(slipBodyX + 25, spineY, { steps: 6 })
  await page.mouse.up()
  state = await getState(page)
  const slipClipAfter = state.sequence!.spine[slipIndex] as Clip
  expect(slipClipAfter.mediaInFlicks).not.toBe(slipClipBefore.mediaInFlicks)
  expect(slipClipAfter.durationFlicks).toBe(slipClipBefore.durationFlicks)
  expect(startOf(state, slipIndex)).toBe(slipStartBefore)
  console.log(
    `slip: mediaIn ${slipClipBefore.mediaInFlicks} → ${slipClipAfter.mediaInFlicks}; position/duration unchanged`
  )
  await page.keyboard.press('a')

  // ---- Esc cancels a drag without committing ----
  state = await getState(page)
  const orderBeforeEsc = state.sequence!.spine.map((item) => item.id)
  const escFromX = bounds.x + xForTime(state, startOf(state, 0) + durations(state)[0] / 2)
  await page.mouse.move(escFromX, spineY)
  await page.mouse.down()
  await page.mouse.move(escFromX + 120, spineY, { steps: 6 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  state = await getState(page)
  expect(state.sequence!.spine.map((item) => item.id)).toEqual(orderBeforeEsc)

  // ---- Drag-rearrange: order changes, magnetic close-up leaves no gap ----
  const moveTotal = total(state)
  const firstId = state.sequence!.spine[0].id
  const dragToX = bounds.x + xForTime(state, moveTotal) - 2
  await page.mouse.move(escFromX, spineY)
  await page.mouse.down()
  await page.mouse.move(dragToX, spineY, { steps: 10 })
  await page.mouse.up()
  state = await getState(page)
  const order = state.sequence!.spine.map((item) => item.id)
  expect(order[order.length - 1]).toBe(firstId)
  expect(order).not.toEqual(orderBeforeEsc)
  expect(total(state)).toBe(moveTotal) // contiguous: derived positions sum exactly
  expect(state.sequence!.spine.every((item) => item.durationFlicks > 0)).toBe(true)
  console.log(`rearrange: ${orderBeforeEsc[0]} moved to the end; total preserved at ${moveTotal}`)

  // ---- Undo storm: ≥50 random ops, then exactly that many undos → initial ----
  const initial = state.sequence
  const asset = Object.values(
    await page.evaluate(() => window.api.getLibrary()).then((l) => l.assets)
  )[0]
  let applied = 0
  let seed = 1
  while (applied < 50) {
    applied += await page.evaluate(
      ({ count, seed, assetId, durationFlicks }) => {
        const hooks = window as unknown as {
          __magneticTimeline: {
            applyRandomOps(
              count: number,
              seed: number,
              asset: {
                assetId: string
                mediaInFlicks: number
                durationFlicks: number
                sourceDurationFlicks: number
              }
            ): number
          }
        }
        return hooks.__magneticTimeline.applyRandomOps(count, seed, {
          assetId,
          mediaInFlicks: 0,
          durationFlicks,
          sourceDurationFlicks: durationFlicks
        })
      },
      { count: 50, seed: seed++, assetId: asset.id, durationFlicks: asset.durationFlicks }
    )
  }
  const undone = await page.evaluate(
    (count) =>
      (
        window as unknown as { __magneticTimeline: { undoTimes(n: number): number } }
      ).__magneticTimeline.undoTimes(count),
    applied
  )
  expect(undone).toBe(applied)
  state = await getState(page)
  expect(state.sequence).toEqual(initial)
  console.log(
    `undo storm: ${applied} random ops applied, ${undone} undos → deep-equal initial state`
  )

  await app.close()
})
