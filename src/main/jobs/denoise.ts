import { execFile } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { MediaAsset } from '../../shared/types'
import { ffmpegPath } from '../binaries'

const execFileAsync = promisify(execFile)

/**
 * Voice cleanup: ffmpeg's FFT denoiser over the asset's audio into
 * cache/denoised/<id>.wav (48 kHz stereo PCM — same contract as the pcm
 * cache, so ensurePcm can extract from it directly). Deletes the stale
 * denoised-pcm derivative so playback re-extracts from the fresh result.
 */
export async function generateDenoised(libraryRoot: string, asset: MediaAsset): Promise<string> {
  if (asset.audio === undefined) throw new Error('denoise requires an audio stream')
  const relPath = join('cache', 'denoised', `${asset.id}.wav`)
  const absPath = join(libraryRoot, relPath)
  mkdirSync(join(libraryRoot, 'cache', 'denoised'), { recursive: true })
  await execFileAsync(
    ffmpegPath(),
    [
      '-v',
      'error',
      '-y',
      '-i',
      join(libraryRoot, asset.libraryRelPath),
      '-vn',
      '-af',
      'afftdn=nr=12:nf=-30',
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
  const stalePcm = join(libraryRoot, 'cache', 'pcm', `${asset.id}.denoised.wav`)
  if (existsSync(stalePcm)) rmSync(stalePcm)
  return relPath
}
