import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
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
  // Voice cleanup: once a denoised track exists, playback/export PCM derives
  // from IT — a distinct cache name, so the raw extraction is never reused.
  const denoisedSource =
    asset.denoisedPath !== undefined && existsSync(join(libraryRoot, asset.denoisedPath))
      ? asset.denoisedPath
      : null
  const relPath = join(
    'cache',
    'pcm',
    denoisedSource !== null ? `${asset.id}.denoised.wav` : `${asset.id}.wav`
  )
  const absPath = join(libraryRoot, relPath)
  if (!existsSync(absPath)) {
    mkdirSync(join(libraryRoot, 'cache', 'pcm'), { recursive: true })
    // Never let ffmpeg write absPath directly: concurrent same-asset callers
    // would each pass the missing-file check and race `-y` writes onto one
    // path, and a caller reading it mid-rewrite gets a torn wav (the export
    // "Unable to decode audio data" bug). Extract to a private temp, then
    // rename into place (atomic on the same volume). randomUUID, not pid:
    // concurrent callers share the one main-process pid. The temp has no .wav
    // extension, so `-f wav` names the muxer explicitly.
    const tmpPath = `${absPath}.tmp-${randomUUID()}`
    try {
      await execFileAsync(
        ffmpegPath(),
        [
          '-v',
          'error',
          '-y',
          '-i',
          join(libraryRoot, denoisedSource ?? asset.libraryRelPath),
          '-vn',
          '-acodec',
          'pcm_s16le',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-f',
          'wav',
          tmpPath
        ],
        { windowsHide: true }
      )
      if (existsSync(absPath)) {
        // a concurrent extraction won the race — keep its identical result
        rmSync(tmpPath, { force: true })
      } else {
        renameSync(tmpPath, absPath)
      }
    } catch (error) {
      rmSync(tmpPath, { force: true })
      throw error
    }
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
