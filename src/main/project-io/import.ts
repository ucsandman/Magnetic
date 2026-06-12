import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { copyFileSync, createReadStream, existsSync, linkSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import type { ImportResult, MediaAsset } from '../../shared/types'
import { ffmpegPath } from '../binaries'
import type { LibraryStore } from './library'
import { probeMedia } from './probe'

const execFileAsync = promisify(execFile)

/** MP4-family containers get a lossless faststart remux at import so the
 * moov atom sits up front — Chromium's media stack cannot stream
 * moov-at-end files over the custom mfile:// scheme. */
const REMUX_EXTENSIONS = new Set(['.mp4', '.mov', '.m4a', '.m4v'])

/**
 * Byte-identical placement into the library: hardlink when source and
 * destination share a volume (instant, zero extra disk for a multi-GB
 * recording), byte copy on ANY link failure (cross-volume EXDEV, permissions,
 * FAT, …). Deleting a hardlinked library file never touches the original.
 * Exported for the fs-mocked unit test.
 */
export function linkOrCopy(sourcePath: string, destPath: string): void {
  try {
    linkSync(sourcePath, destPath)
  } catch {
    copyFileSync(sourcePath, destPath)
  }
}

async function copyIntoLibrary(sourcePath: string, destPath: string): Promise<void> {
  if (REMUX_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
    try {
      await execFileAsync(
        ffmpegPath(),
        ['-v', 'error', '-y', '-i', sourcePath, '-c', 'copy', '-movflags', '+faststart', destPath],
        { windowsHide: true }
      )
      return // the remux WRITES a new file — only the byte-copy path can hardlink
    } catch {
      // fall through to byte copy — the file probed fine, so keep it playable-as-is
    }
  }
  linkOrCopy(sourcePath, destPath)
}

async function sha1OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Pick a collision-free destination name inside media/. */
function destinationName(store: LibraryStore, fileName: string): string {
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  let candidate = fileName
  let counter = 1
  while (existsSync(join(store.mediaDir(), candidate))) {
    candidate = `${stem}-${counter}${ext}`
    counter += 1
  }
  return candidate
}

/**
 * Import files into the library: probe metadata, copy into media/, hash, and
 * register a MediaAsset. Unreadable files are reported per-file, not thrown.
 */
export async function importPaths(store: LibraryStore, paths: string[]): Promise<ImportResult> {
  const result: ImportResult = { importedIds: [], errors: [] }

  for (const sourcePath of paths) {
    try {
      if (!existsSync(sourcePath)) throw new Error('file does not exist')
      const probe = await probeMedia(sourcePath)
      const fileName = destinationName(store, basename(sourcePath))
      const destPath = join(store.mediaDir(), fileName)
      await copyIntoLibrary(sourcePath, destPath)
      const contentHash = await sha1OfFile(destPath)
      const asset: MediaAsset = {
        id: randomUUID(),
        fileName,
        libraryRelPath: join('media', fileName),
        contentHash,
        durationFlicks: probe.durationFlicks,
        video: probe.video,
        audio: probe.audio,
        rating: 'none'
      }
      store.addAsset(asset)
      result.importedIds.push(asset.id)
    } catch (error) {
      result.errors.push({
        file: basename(sourcePath),
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return result
}
