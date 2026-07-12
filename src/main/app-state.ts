import { BrowserWindow, dialog } from 'electron'
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { AssetView, ImportResult, LibrarySnapshot, MediaAsset } from '../shared/types'
import { IPC } from '../shared/channels'
import { LibraryStore } from './project-io/library'
import { importPaths } from './project-io/import'
import { JobQueue } from './jobs/queue'
import { generateFilmstrip } from './jobs/filmstrip'
import { generateWaveform } from './jobs/waveform'
import { generateAudioEnvelope } from './jobs/audio-envelope'
import { ensurePcm, ensureProxy } from './jobs/media-derivatives'
import { generateDenoised } from './jobs/denoise'
import { generateTranscript } from './jobs/transcribe'
import { ffmpegPath, whisperModelPath, whisperPath } from './binaries'
import { startMediaServer, type MediaServer } from './media-server'
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
  // An env override is a test/dev launch — never stamp it as the user's library.
  const envOverride = process.env.MAGNETIC_LIBRARY_PATH
  if (envOverride === undefined || envOverride === '') store.rememberAsLastUsed()
  store.onChange(() => broadcastSnapshot())
  // Heal interrupted imports: regenerate any missing filmstrips/waveforms so
  // assets don't sit in "processing…" forever after a mid-job shutdown.
  for (const asset of Object.values(store.assets)) {
    if (existsSync(join(store.root, asset.libraryRelPath))) enqueueDerivativeJobs(asset)
  }
}

export function getStore(): LibraryStore {
  if (store === null) throw new Error('library not initialized')
  return store
}

export function pathToMfileUrl(absolutePath: string): string {
  const segments = absolutePath.replace(/\\/g, '/').split('/')
  return `mfile:///${segments.map(encodeURIComponent).join('/')}`
}

// Video/audio files are served over loopback HTTP, not mfile — see
// media-server.ts for why <video> cannot play multi-GB files via a custom
// protocol. Filmstrips, peaks and transcripts stay on mfile.
let mediaServer: MediaServer | null = null

export async function initMediaServer(): Promise<void> {
  mediaServer = await startMediaServer(() => [getStore().root])
}

function mediaHttpUrl(absolutePath: string): string {
  if (mediaServer === null) throw new Error('media server not started')
  return mediaServer.urlForPath(absolutePath)
}

export function buildSnapshot(): LibrarySnapshot {
  const lib = getStore()
  const assets: Record<string, AssetView> = {}
  for (const [id, asset] of Object.entries(lib.assets)) {
    const view: AssetView = {
      ...asset,
      missing: !existsSync(join(lib.root, asset.libraryRelPath)),
      mediaUrl: mediaHttpUrl(join(lib.root, asset.libraryRelPath)),
      filmstrip:
        asset.filmstrip === undefined
          ? undefined
          : { ...asset.filmstrip, url: pathToMfileUrl(join(lib.root, asset.filmstrip.stripPath)) },
      waveform:
        asset.waveform === undefined
          ? undefined
          : { ...asset.waveform, url: pathToMfileUrl(join(lib.root, asset.waveform.peaksPath)) },
      proxyUrl:
        asset.proxyPath === undefined ? undefined : mediaHttpUrl(join(lib.root, asset.proxyPath)),
      transcriptUrl:
        asset.transcriptPath === undefined
          ? undefined
          : pathToMfileUrl(join(lib.root, asset.transcriptPath)),
      denoisedUrl:
        asset.denoisedPath === undefined
          ? undefined
          : pathToMfileUrl(join(lib.root, asset.denoisedPath)),
      envelopeUrl:
        asset.envelope === undefined
          ? undefined
          : pathToMfileUrl(join(lib.root, asset.envelope.envelopePath))
    }
    assets[id] = view
  }
  return { ...lib.library, assets }
}

/**
 * Relink a missing asset to a replacement file: the duration must match
 * within one frame, then the file is copied back into the library's media
 * folder under the original relative path.
 */
export async function relinkAsset(assetId: string, newPath: string): Promise<void> {
  const lib = getStore()
  const asset = lib.assets[assetId]
  if (asset === undefined) throw new Error(`unknown asset: ${assetId}`)
  const { probeMedia } = await import('./project-io/probe')
  const probed = await probeMedia(newPath)
  const frameFlicks =
    asset.video !== undefined
      ? 705_600_000 / (asset.video.fps.num / asset.video.fps.den)
      : 23_520_000
  if (Math.abs(probed.durationFlicks - asset.durationFlicks) > frameFlicks) {
    throw new Error(
      `duration mismatch: replacement is ${(probed.durationFlicks / 705_600_000).toFixed(2)}s, asset is ${(asset.durationFlicks / 705_600_000).toFixed(2)}s`
    )
  }
  copyFileSync(newPath, join(lib.root, asset.libraryRelPath))
  lib.updateAsset(assetId, {}) // touch → snapshot broadcast clears the badge
}

/** Production relink: pick the replacement via the OS file dialog. */
export async function relinkViaDialog(assetId: string): Promise<void> {
  const picked = await dialog.showOpenDialog({
    title: 'Relink Media',
    properties: ['openFile']
  })
  if (picked.canceled || picked.filePaths.length === 0) return
  await relinkAsset(assetId, picked.filePaths[0])
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

/** Queue voice cleanup (ffmpeg denoise); playback PCM prefers the result. */
export function enqueueDenoise(assetId: string): void {
  const lib = getStore()
  const asset = lib.assets[assetId]
  if (asset === undefined || asset.audio === undefined) return
  queue.enqueue({
    label: `denoise:${asset.fileName}`,
    run: async () => {
      try {
        const relPath = await generateDenoised(lib.root, asset)
        lib.updateAsset(asset.id, { denoisedPath: relPath, denoiseError: undefined })
      } catch (error) {
        lib.updateAsset(asset.id, {
          denoiseError: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
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
  return mediaHttpUrl(join(lib.root, relPath))
}

function broadcastSnapshot(): void {
  const snapshot = buildSnapshot()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.libraryChanged, snapshot)
  }
}

/** Queue filmstrip/waveform generation for whichever derivatives are absent. */
function enqueueDerivativeJobs(asset: MediaAsset): void {
  const lib = getStore()
  if (asset.video !== undefined && asset.filmstrip === undefined) {
    queue.enqueue({
      label: `filmstrip:${asset.fileName}`,
      run: async () => {
        const filmstrip = await generateFilmstrip(lib.root, asset)
        lib.updateAsset(asset.id, { filmstrip })
      }
    })
  }
  if (asset.audio !== undefined && asset.waveform === undefined) {
    queue.enqueue({
      label: `waveform:${asset.fileName}`,
      run: async () => {
        const waveform = await generateWaveform(lib.root, asset)
        lib.updateAsset(asset.id, { waveform })
      }
    })
  }
  if (asset.audio !== undefined && asset.envelope === undefined) {
    queue.enqueue({
      label: `envelope:${asset.fileName}`,
      run: async () => {
        try {
          const envelope = await generateAudioEnvelope(lib.root, asset)
          lib.updateAsset(asset.id, { envelope, envelopeError: undefined })
        } catch (error) {
          // Persist the failure so the Silence panel can say "analysis failed"
          // instead of the misleading "no dead air detected" empty state.
          lib.updateAsset(asset.id, {
            envelopeError: error instanceof Error ? error.message : String(error)
          })
          throw error
        }
      }
    })
  }
}

/** Whisper on multi-hour recordings costs hours of CPU — auto-transcribe only short clips. */
const AUTO_TRANSCRIBE_MAX_MINUTES = 30
const AUTO_TRANSCRIBE_MAX_FLICKS = AUTO_TRANSCRIBE_MAX_MINUTES * 60 * 705_600_000

function enqueueAssetJobs(asset: MediaAsset): void {
  enqueueDerivativeJobs(asset)
  if (asset.audio === undefined || !getAutoTranscribe()) return
  if (asset.durationFlicks > AUTO_TRANSCRIBE_MAX_FLICKS) {
    console.log(
      `auto-transcribe skipped for ${asset.fileName}: longer than ${AUTO_TRANSCRIBE_MAX_MINUTES} min — use the asset's Transcribe action to run it manually`
    )
    return
  }
  enqueueTranscription(asset.id)
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
