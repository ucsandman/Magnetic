import { BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import type { AssetView, ImportResult, LibrarySnapshot, MediaAsset } from '../shared/types'
import { IPC } from '../shared/channels'
import { LibraryStore } from './project-io/library'
import { importPaths } from './project-io/import'
import { JobQueue } from './jobs/queue'
import { generateFilmstrip } from './jobs/filmstrip'
import { generateWaveform } from './jobs/waveform'
import { ensurePcm, ensureProxy } from './jobs/media-derivatives'
import { generateTranscript } from './jobs/transcribe'
import { ffmpegPath, whisperModelPath, whisperPath } from './binaries'
import { getAutoTranscribe } from './project-io/library'

/**
 * Owns the open library and the background job queue; broadcasts a fresh
 * snapshot to every window after any change.
 */
let store: LibraryStore | null = null
const queue = new JobQueue(2, (label, error) => {
  console.error(`background job failed: ${label}:`, error)
})

export function initAppState(): void {
  const root = LibraryStore.resolveStartupPath()
  store = LibraryStore.open(root)
  store.rememberAsLastUsed()
  store.onChange(() => broadcastSnapshot())
}

export function getStore(): LibraryStore {
  if (store === null) throw new Error('library not initialized')
  return store
}

export function pathToMfileUrl(absolutePath: string): string {
  const segments = absolutePath.replace(/\\/g, '/').split('/')
  return `mfile:///${segments.map(encodeURIComponent).join('/')}`
}

export function buildSnapshot(): LibrarySnapshot {
  const lib = getStore()
  const assets: Record<string, AssetView> = {}
  for (const [id, asset] of Object.entries(lib.assets)) {
    const view: AssetView = {
      ...asset,
      mediaUrl: pathToMfileUrl(join(lib.root, asset.libraryRelPath)),
      filmstrip:
        asset.filmstrip === undefined
          ? undefined
          : { ...asset.filmstrip, url: pathToMfileUrl(join(lib.root, asset.filmstrip.stripPath)) },
      waveform:
        asset.waveform === undefined
          ? undefined
          : { ...asset.waveform, url: pathToMfileUrl(join(lib.root, asset.waveform.peaksPath)) },
      proxyUrl:
        asset.proxyPath === undefined ? undefined : pathToMfileUrl(join(lib.root, asset.proxyPath)),
      transcriptUrl:
        asset.transcriptPath === undefined
          ? undefined
          : pathToMfileUrl(join(lib.root, asset.transcriptPath))
    }
    assets[id] = view
  }
  return { ...lib.library, assets }
}

/** Queue a transcription job (manual trigger or auto-on-import). */
export function enqueueTranscription(assetId: string): void {
  const lib = getStore()
  const asset = lib.assets[assetId]
  if (asset === undefined || asset.audio === undefined) return
  queue.enqueue({
    label: `transcribe:${asset.fileName}`,
    run: async () => {
      const relPath = await generateTranscript(
        { ffmpeg: ffmpegPath(), whisper: whisperPath(), model: whisperModelPath() },
        lib.root,
        asset
      )
      lib.updateAsset(asset.id, { transcriptPath: relPath })
    }
  })
}

/** Extract PCM once and return its mfile URL (null when the asset has no audio). */
export async function ensurePcmUrl(assetId: string): Promise<string | null> {
  const lib = getStore()
  const asset = lib.assets[assetId]
  if (asset === undefined) throw new Error(`unknown asset: ${assetId}`)
  const relPath = await ensurePcm(lib.root, asset)
  return relPath === null ? null : pathToMfileUrl(join(lib.root, relPath))
}

/** Transcode the preview proxy once, record it on the asset, return its URL. */
export async function ensureProxyUrl(assetId: string): Promise<string> {
  const lib = getStore()
  const asset = lib.assets[assetId]
  if (asset === undefined) throw new Error(`unknown asset: ${assetId}`)
  const relPath = await ensureProxy(lib.root, asset)
  if (asset.proxyPath !== relPath) {
    lib.updateAsset(assetId, { proxyPath: relPath })
  }
  return pathToMfileUrl(join(lib.root, relPath))
}

function broadcastSnapshot(): void {
  const snapshot = buildSnapshot()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.libraryChanged, snapshot)
  }
}

function enqueueAssetJobs(asset: MediaAsset): void {
  const lib = getStore()
  if (asset.video !== undefined) {
    queue.enqueue({
      label: `filmstrip:${asset.fileName}`,
      run: async () => {
        const filmstrip = await generateFilmstrip(lib.root, asset)
        lib.updateAsset(asset.id, { filmstrip })
      }
    })
  }
  if (asset.audio !== undefined) {
    queue.enqueue({
      label: `waveform:${asset.fileName}`,
      run: async () => {
        const waveform = await generateWaveform(lib.root, asset)
        lib.updateAsset(asset.id, { waveform })
      }
    })
    if (getAutoTranscribe()) enqueueTranscription(asset.id)
  }
}

/** Import files, then kick off background filmstrip/waveform generation. */
export async function importAndProcess(paths: string[]): Promise<ImportResult> {
  const lib = getStore()
  const result = await importPaths(lib, paths)
  for (const id of result.importedIds) {
    enqueueAssetJobs(lib.assets[id])
  }
  return result
}

/** File → Import Media…: OS picker, then the normal import pipeline. */
export async function importViaDialog(): Promise<ImportResult> {
  const picked = await dialog.showOpenDialog({
    title: 'Import Media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Media',
        extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wav', 'mp3', 'm4a', 'aac', 'flac']
      },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) {
    return { importedIds: [], errors: [] }
  }
  return importAndProcess(picked.filePaths)
}
