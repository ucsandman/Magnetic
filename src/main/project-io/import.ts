import { createHash } from 'crypto'
import { copyFileSync, createReadStream, existsSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import type { ImportResult, MediaAsset } from '../../shared/types'
import type { LibraryStore } from './library'
import { probeMedia } from './probe'

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
      copyFileSync(sourcePath, destPath)
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
