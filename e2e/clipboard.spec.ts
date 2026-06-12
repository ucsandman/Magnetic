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
import type { ClipboardClip } from '../src/shared/timeline/clipboard'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FLICKS_PER_SECOND = 705_600_000

interface ClipboardTestState {
  sequence: Sequence | null
  selection: { clipIds: string[] }
  playheadFlicks: number
  zoomPxPerSec: number
  clipboard: ClipboardClip[]
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<ClipboardTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): ClipboardTestState }).__magneticState()
  )
}

function spineClip(state: ClipboardTestState, index: number): Clip {
  return state.sequence!.spine[index] as Clip
}

function spineStart(state: ClipboardTestState, id: string): number {
  let position = 0
  for (const item of state.sequence!.spine) {
    if (item.id === id) return position
    position += item.durationFlicks
  }
  throw new Error(`no spine item ${id}`)
}

test('clipboard: copy/paste insert+connect, grouped undo, duplicate, paste attributes', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-clipboard-'))
  const app = await launchApp(join(tempRoot, 'Clipboard.mglib'))
  const page = await app.firstWindow()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

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

  const library = await page.evaluate(() => window.api.getLibrary())
  const bars = Object.values(library.assets)[0]

  // ---- two bars clips on the spine (10 s each) ----
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  await page.keyboard.press('e')
  for (let i = 0; i < 5; i++) await page.keyboard.press('-') // whole 20 s in view
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)
  const [clip1Id, clip2Id] = state.sequence!.spine.map((item) => item.id)

  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const rulerY = bounds.y + 10
  const spineY = bounds.y + 26 + 4 + 36 + 24
  const zoom = state.zoomPxPerSec
  const xAt = (sec: number): number => bounds.x + sec * zoom

  // ---- clip 1: scale keyframe track + a static opacity (the copied "attributes") ----
  await page.mouse.click(xAt(5), spineY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([clip1Id])
  await page.mouse.click(xAt(0.1), rulerY)
  await page.getByTestId('kf-toggle-scale').click()
  await page.mouse.click(xAt(9.5), rulerY)
  await page.getByTestId('fx-scale').fill('40')
  await page.getByTestId('fx-opacity').fill('50')
  await page.mouse.click(xAt(0.1), rulerY) // blur the input so shortcuts resume
  state = await getState(page)
  const sourceFx = spineClip(state, 0).fx!
  expect(sourceFx.kf?.scale).toHaveLength(2)
  expect(sourceFx.opacity).toBe(50)

  // ---- Ctrl+C snapshots the selected clip incl. fx + keyframes ----
  await page.mouse.click(xAt(5), spineY)
  await page.keyboard.press('Control+KeyC')
  state = await getState(page)
  expect(state.clipboard).toHaveLength(1)
  expect(state.clipboard[0].fx).toEqual(sourceFx)

  // ---- Ctrl+V at the end: a fresh-id duplicate downstream; one Ctrl+Z removes it ----
  await page.keyboard.press('End')
  await page.keyboard.press('Control+KeyV')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  const pasted = spineClip(state, 2)
  expect([clip1Id, clip2Id]).not.toContain(pasted.id)
  expect(pasted.assetId).toBe(bars.id)
  expect(pasted.mediaInFlicks).toBe(0)
  expect(pasted.durationFlicks).toBe(bars.durationFlicks)
  expect(pasted.sourceDurationFlicks).toBe(bars.durationFlicks)
  expect(pasted.fx).toEqual(sourceFx)
  await page.keyboard.press('Control+KeyZ')
  state = await getState(page)
  expect(state.sequence!.spine.map((item) => item.id)).toEqual([clip1Id, clip2Id])
  expect(spineClip(state, 0).fx).toEqual(sourceFx) // source untouched

  // ---- multi-clip paste (shift-click additive select) is ONE undo step ----
  await page.mouse.click(xAt(5), spineY)
  await page.keyboard.down('Shift')
  await page.mouse.click(xAt(15), spineY)
  await page.keyboard.up('Shift')
  state = await getState(page)
  expect(state.selection.clipIds.sort()).toEqual([clip1Id, clip2Id].sort())
  await page.keyboard.press('Control+KeyC')
  state = await getState(page)
  expect(state.clipboard).toHaveLength(2)
  expect(state.clipboard.map((entry) => entry.relOffsetFlicks)).toEqual([0, bars.durationFlicks])
  await page.keyboard.press('End')
  await page.keyboard.press('Control+KeyV')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(4)
  await page.keyboard.press('Control+KeyZ') // the WHOLE paste is one undo step
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)

  // ---- Ctrl+Shift+V connects the copied clip at the playhead on lane 1 ----
  await page.mouse.click(xAt(5), spineY)
  await page.keyboard.press('Control+KeyC')
  await page.mouse.click(xAt(15), rulerY) // playhead mid clip 2
  state = await getState(page)
  const connectPlayhead = state.playheadFlicks
  expect(Math.abs(connectPlayhead - 15 * FLICKS_PER_SECOND)).toBeLessThan(FLICKS_PER_SECOND / 4)
  await page.keyboard.press('Control+Shift+KeyV')
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(1)
  const cc = state.sequence!.connected[0]
  expect(cc.lane).toBe(1)
  expect(cc.assetId).toBe(bars.id)
  expect(cc.fx).toEqual(sourceFx)
  expect(spineStart(state, cc.parentClipId) + cc.offsetFlicks).toBe(connectPlayhead)
  await page.keyboard.press('Control+KeyZ')
  state = await getState(page)
  expect(state.sequence!.connected).toHaveLength(0)

  // ---- Ctrl+D duplicates the selected clip right after it ----
  await page.mouse.click(xAt(5), spineY)
  await page.keyboard.press('Control+KeyD')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(3)
  const dup = spineClip(state, 1) // duplicate lands directly after clip 1
  expect([clip1Id, clip2Id]).not.toContain(dup.id)
  expect(dup.assetId).toBe(bars.id)
  expect(dup.durationFlicks).toBe(bars.durationFlicks)
  expect(dup.fx).toEqual(sourceFx)
  expect(state.sequence!.spine[2].id).toBe(clip2Id)
  await page.keyboard.press('Control+KeyZ')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)

  // ---- Ctrl+Alt+V transfers fx + keyframes onto the selection; one Ctrl+Z reverts ----
  await page.mouse.click(xAt(15), spineY)
  state = await getState(page)
  expect(state.selection.clipIds).toEqual([clip2Id])
  expect(spineClip(state, 1).fx).toBeUndefined()
  await page.keyboard.press('Control+Alt+KeyV')
  state = await getState(page)
  expect(spineClip(state, 1).fx).toEqual(sourceFx)
  await page.keyboard.press('Control+KeyZ')
  state = await getState(page)
  expect(spineClip(state, 1).fx).toBeUndefined()

  // ---- paste attributes is a no-op when the clipboard holds multiple clips ----
  await page.mouse.click(xAt(5), spineY)
  await page.keyboard.down('Shift')
  await page.mouse.click(xAt(15), spineY)
  await page.keyboard.up('Shift')
  await page.keyboard.press('Control+KeyC')
  state = await getState(page)
  expect(state.clipboard).toHaveLength(2)
  await page.mouse.click(xAt(15), spineY)
  await page.keyboard.press('Control+Alt+KeyV')
  state = await getState(page)
  expect(spineClip(state, 1).fx).toBeUndefined()

  expect(pageErrors).toEqual([])
  await app.close()
})
