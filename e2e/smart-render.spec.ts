import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ClipFx, Sequence } from '../src/shared/timeline/model'

const ROOT = join(__dirname, '..')
const FIXTURES = join(ROOT, 'fixtures')
const FFPROBE = join(ROOT, 'resources', 'bin', 'ffprobe.exe')
const FLICKS_PER_SECOND = 705_600_000

interface SmartRenderTestState {
  sequence: Sequence | null
  playheadFlicks: number
  zoomPxPerSec: number
}

interface ProbeResult {
  format: { duration: string }
  streams: {
    codec_type: string
    codec_name: string
    width?: number
    height?: number
    avg_frame_rate?: string
  }[]
}

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, MAGNETIC_TEST: '1', MAGNETIC_LIBRARY_PATH: libraryPath }
  })
}

function getState(page: Page): Promise<SmartRenderTestState> {
  return page.evaluate(() =>
    (window as unknown as { __magneticState(): SmartRenderTestState }).__magneticState()
  )
}

function probe(path: string): ProbeResult {
  return JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], {
      encoding: 'utf8'
    })
  ) as ProbeResult
}

test('smart render: eligible trim stream-copies the source video; fx kills eligibility', async () => {
  test.setTimeout(240_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-smart-e2e-'))
  const outDir = mkdtempSync(join(tmpdir(), 'magnetic-smart-out-'))
  const destination = join(outDir, 'smart.mp4')
  const fixture = join(FIXTURES, 'bars-1080p30.mp4')
  const app = await launchApp(join(tempRoot, 'Smart.mglib'))
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.log(`PAGEERROR: ${String(error)}`))

  const imported = await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  expect(imported.errors).toEqual([])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })

  // ---- eligible sequence: append, blade at ~1 s, ripple-delete the head ----
  // (a head trim: single asset, media-contiguous → smart-render eligible;
  //  the fixture's keyframes sit at 0 s and 8.33 s, so a ~1 s in-point keeps
  //  the -ss keyframe snap within the ±1.5 s GOP-slack tolerance)
  await page.getByTestId('asset-cell-bars-1080p30.mp4').click()
  await page.keyboard.press('e')
  let state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)

  const canvas = page.getByTestId('timeline-canvas')
  const bounds = (await canvas.boundingBox())!
  const rulerY = bounds.y + 10
  const spineY = bounds.y + 26 + 4 + 36 + 24
  const zoom = state.zoomPxPerSec
  const xAt = (sec: number): number => bounds.x + sec * zoom

  await page.mouse.click(xAt(1), rulerY) // playhead ≈ 1 s
  await page.keyboard.press('Control+b') // blade the clip under it
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)

  await page.mouse.click(xAt(0.5), spineY) // select the ~1 s head piece
  state = await getState(page)
  expect(state.sequence!.spine.map((item) => item.id)).toContain(state.sequence!.spine[0].id)
  await page.keyboard.press('Delete') // ripple delete → head trim
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(1)
  const clip = state.sequence!.spine[0]
  expect(clip.kind).toBe('clip')
  const mediaInSec = (clip.kind === 'clip' ? clip.mediaInFlicks : 0) / FLICKS_PER_SECOND
  expect(mediaInSec).toBeGreaterThan(0.5)
  expect(mediaInSec).toBeLessThan(1.5)

  // blade again mid-clip and leave both pieces: a media-contiguous rejoin
  await page.mouse.click(xAt(4), rulerY)
  await page.keyboard.press('Control+b')
  state = await getState(page)
  expect(state.sequence!.spine).toHaveLength(2)
  const trimmedSec =
    state.sequence!.spine.reduce((sum, item) => sum + item.durationFlicks, 0) / FLICKS_PER_SECOND
  console.log(`eligible sequence: in=${mediaInSec.toFixed(3)}s dur=${trimmedSec.toFixed(3)}s`)

  // ---- export via the dialog: note visible, passthrough output ----
  await page.keyboard.press('Control+e')
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  await expect(page.getByTestId('smart-render-note')).toBeVisible()
  await page.getByTestId('export-destination').fill(destination)
  await page.getByTestId('export-start').click()
  await expect
    .poll(
      async () => {
        const errorBox = page.getByTestId('export-error')
        if ((await errorBox.count()) > 0) {
          throw new Error(`smart export surfaced an error: ${await errorBox.innerText()}`)
        }
        return (await page.getByTestId('export-success').count()) > 0
      },
      { timeout: 120_000, intervals: [250] }
    )
    .toBe(true)
  await page.getByTestId('export-close').click()
  expect(existsSync(destination)).toBe(true)
  expect(existsSync(`${destination}.part`)).toBe(false)
  expect(existsSync(`${destination}.mix.wav`)).toBe(false) // temp mix cleaned up

  // ---- ffprobe: stream copy means the video parameters match the SOURCE ----
  const source = probe(fixture)
  const output = probe(destination)
  const srcVideo = source.streams.find((s) => s.codec_type === 'video')!
  const outVideo = output.streams.find((s) => s.codec_type === 'video')!
  const outAudio = output.streams.find((s) => s.codec_type === 'audio')!
  console.log(
    `source video: ${srcVideo.codec_name} ${srcVideo.width}x${srcVideo.height} @ ${srcVideo.avg_frame_rate}`
  )
  console.log(
    `output video: ${outVideo.codec_name} ${outVideo.width}x${outVideo.height} @ ${outVideo.avg_frame_rate}` +
      ` · audio ${outAudio.codec_name} · duration ${output.format.duration}s (trim ${trimmedSec.toFixed(3)}s)`
  )
  expect(outVideo.codec_name).toBe(srcVideo.codec_name)
  expect(outVideo.width).toBe(srcVideo.width)
  expect(outVideo.height).toBe(srcVideo.height)
  expect(outVideo.avg_frame_rate).toBe(srcVideo.avg_frame_rate)
  expect(outAudio.codec_name).toBe('aac')
  // -ss before -i snaps to the previous keyframe: ≤1 GOP of head slack
  expect(Math.abs(Number(output.format.duration) - trimmedSec)).toBeLessThanOrEqual(1.5)

  // ---- a non-default video fx flips the plan to null: note disappears ----
  state = await getState(page)
  const clipId = state.sequence!.spine[0].id
  await page.evaluate(
    ({ id, fx }) => {
      const hooks = window as unknown as {
        __magneticTimeline: { setClipFx(clipId: string, fx: ClipFx): void }
      }
      hooks.__magneticTimeline.setClipFx(id, fx)
    },
    {
      id: clipId,
      fx: {
        posX: 0,
        posY: 0,
        scale: 50, // non-default → not visually untouched
        rotation: 0,
        opacity: 100,
        exposure: 0,
        contrast: 1,
        saturation: 1,
        temperature: 0,
        fadeInFlicks: 0,
        fadeOutFlicks: 0,
        volumeDb: 0,
        pan: 0
      } satisfies ClipFx
    }
  )
  await page.keyboard.press('Control+e')
  await expect(page.getByTestId('export-dialog')).toBeVisible()
  await expect(page.getByTestId('smart-render-note')).toHaveCount(0)
  console.log('non-default fx: smart-render note gone (normal pipeline would run)')
  await page.getByTestId('export-close').click()

  await app.close()
})
