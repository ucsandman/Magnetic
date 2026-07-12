import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { parseIntegratedLufs } from '../../shared/loudness'
import type { MediaAsset } from '../../shared/types'
import { ffmpegPath } from '../binaries'

const execFileAsync = promisify(execFile)

/**
 * Loudness measurement: ffmpeg's EBU R128 meter over the asset's audio,
 * cached as cache/loudness/<id>.json. The renderer turns the integrated LUFS
 * into a per-clip volumeDb via shared/loudness.ts — measurement is
 * main-process (ffmpeg), the gain math is pure and shared.
 */

/** Measure (and cache) an asset's integrated loudness in LUFS. */
export async function measureLoudness(
  libraryRoot: string,
  asset: MediaAsset
): Promise<number | null> {
  if (asset.audio === undefined) return null
  const cacheDir = join(libraryRoot, 'cache', 'loudness')
  const cachePath = join(cacheDir, `${asset.id}.json`)
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { lufs: number | null }
      return cached.lufs
    } catch {
      // unreadable cache — re-measure
    }
  }
  // ebur128 reports on stderr; -f null discards the decode
  const { stderr } = await execFileAsync(
    ffmpegPath(),
    [
      '-hide_banner',
      '-i',
      join(libraryRoot, asset.libraryRelPath),
      '-vn',
      '-af',
      'ebur128',
      '-f',
      'null',
      '-'
    ],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  )
  const lufs = parseIntegratedLufs(stderr)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cachePath, JSON.stringify({ lufs }), 'utf8')
  return lufs
}
