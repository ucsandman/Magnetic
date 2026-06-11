import { execFile } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { MediaAsset } from '../../shared/types'
import { ffmpegPath } from '../binaries'

const execFileAsync = promisify(execFile)

/**
 * Lazily-built playback derivatives, cached inside the library:
 * - cache/pcm/<id>.wav     16-bit 48 kHz stereo PCM for Web Audio mixdown
 * - cache/proxy/<id>.mp4   1080p-capped H.264 preview proxy for assets whose
 *                          native codec WebCodecs cannot decode
 */

export async function ensurePcm(libraryRoot: string, asset: MediaAsset): Promise<string | null> {
  if (asset.audio === undefined) return null
  const relPath = join('cache', 'pcm', `${asset.id}.wav`)
  const absPath = join(libraryRoot, relPath)
  if (!existsSync(absPath)) {
    mkdirSync(join(libraryRoot, 'cache', 'pcm'), { recursive: true })
    await execFileAsync(
      ffmpegPath(),
      [
        '-v',
        'error',
        '-y',
        '-i',
        join(libraryRoot, asset.libraryRelPath),
        '-vn',
        '-acodec',
        'pcm_s16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        absPath
      ],
      { windowsHide: true }
    )
  }
  return relPath
}

export async function ensureProxy(libraryRoot: string, asset: MediaAsset): Promise<string> {
  if (asset.video === undefined) throw new Error('proxy requires a video stream')
  const relPath = join('cache', 'proxy', `${asset.id}.mp4`)
  const absPath = join(libraryRoot, relPath)
  if (!existsSync(absPath)) {
    mkdirSync(join(libraryRoot, 'cache', 'proxy'), { recursive: true })
    await execFileAsync(
      ffmpegPath(),
      [
        '-v',
        'error',
        '-y',
        '-i',
        join(libraryRoot, asset.libraryRelPath),
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        "scale='min(1920,iw)':-2",
        '-movflags',
        '+faststart',
        absPath
      ],
      { windowsHide: true }
    )
  }
  return relPath
}
