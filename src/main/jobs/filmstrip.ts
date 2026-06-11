import { execFile } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { FilmstripInfo, MediaAsset } from '../../shared/types'
import { flicksToSeconds, secondsToFlicks } from '../../shared/timecode'
import { ffmpegPath } from '../binaries'

const execFileAsync = promisify(execFile)

const FRAME_H = 60
/** Strip width cap keeps the JPEG GPU-texture-safe for later phases. */
const MAX_STRIP_W = 4096

/**
 * Render a single horizontal strip JPEG (~1 frame/sec, capped by texture
 * width) into cache/filmstrips/<assetId>.jpg.
 */
export async function generateFilmstrip(
  libraryRoot: string,
  asset: MediaAsset
): Promise<FilmstripInfo> {
  if (asset.video === undefined) throw new Error('filmstrip requires a video stream')
  const durationSeconds = flicksToSeconds(asset.durationFlicks)
  const aspect = asset.video.w / asset.video.h
  const frameW = Math.max(20, Math.round(FRAME_H * aspect))
  const maxFrames = Math.floor(MAX_STRIP_W / frameW)
  const frameCount = Math.min(maxFrames, Math.max(1, Math.ceil(durationSeconds)))
  const intervalSeconds = durationSeconds / frameCount

  const outDir = join(libraryRoot, 'cache', 'filmstrips')
  mkdirSync(outDir, { recursive: true })
  const stripRelPath = join('cache', 'filmstrips', `${asset.id}.jpg`)

  await execFileAsync(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-y',
      '-i',
      join(libraryRoot, asset.libraryRelPath),
      '-vf',
      `fps=1/${intervalSeconds.toFixed(6)},scale=${frameW}:${FRAME_H},tile=${frameCount}x1`,
      '-frames:v',
      '1',
      '-q:v',
      '5',
      join(libraryRoot, stripRelPath)
    ],
    { windowsHide: true }
  )

  return {
    stripPath: stripRelPath,
    frameW,
    frameH: FRAME_H,
    frameCount,
    intervalFlicks: secondsToFlicks(intervalSeconds)
  }
}
