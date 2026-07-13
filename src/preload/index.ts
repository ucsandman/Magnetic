import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/channels'
import type { MagneticApi } from '../shared/ipc'
import type { LibrarySnapshot } from '../shared/types'

const api: MagneticApi = {
  diagBinaries: () => ipcRenderer.invoke(IPC.diagBinaries),
  getLibrary: () => ipcRenderer.invoke(IPC.libraryGet),
  importDialog: () => ipcRenderer.invoke(IPC.libraryImportDialog),
  importPaths: (paths) => ipcRenderer.invoke(IPC.libraryImportPaths, { paths }),
  setAssetRating: (assetId, rating) => ipcRenderer.invoke(IPC.assetSetRating, { assetId, rating }),
  deleteAsset: (assetId) => ipcRenderer.invoke(IPC.assetDelete, { assetId }),
  getProject: () => ipcRenderer.invoke(IPC.projectGet),
  saveSequence: (projectId, sequence) =>
    ipcRenderer.invoke(IPC.projectSaveSequence, { projectId, sequence }),
  ensurePcm: (assetId) => ipcRenderer.invoke(IPC.mediaEnsurePcm, { assetId }),
  ensureProxy: (assetId) => ipcRenderer.invoke(IPC.mediaEnsureProxy, { assetId }),
  diagMemory: () => ipcRenderer.invoke(IPC.diagMemory),
  exportPickDestination: () => ipcRenderer.invoke(IPC.exportPickDestination),
  exportStart: (args) => ipcRenderer.invoke(IPC.exportStart, args),
  exportFrame: (frame) => ipcRenderer.invoke(IPC.exportFrame, { frame }),
  exportFinish: () => ipcRenderer.invoke(IPC.exportFinish),
  exportCancel: () => ipcRenderer.invoke(IPC.exportCancel),
  smartExportStart: (args) => ipcRenderer.invoke(IPC.smartExportStart, args),
  smartExportAudioChunk: (pcm) => ipcRenderer.invoke(IPC.smartExportAudioChunk, { pcm }),
  smartExportMux: () => ipcRenderer.invoke(IPC.smartExportMux),
  smartExportCancel: () => ipcRenderer.invoke(IPC.smartExportCancel),
  onSmartExportProgress: (cb) => {
    const listener = (_event: unknown, progress: { outTimeSec: number }): void => cb(progress)
    ipcRenderer.on(IPC.smartExportProgress, listener)
    return () => ipcRenderer.removeListener(IPC.smartExportProgress, listener)
  },
  transcribeAsset: (assetId) => ipcRenderer.invoke(IPC.transcribeRun, { assetId }),
  denoiseAsset: (assetId) => ipcRenderer.invoke(IPC.mediaDenoise, { assetId }),
  audioLoudness: (assetId) => ipcRenderer.invoke(IPC.mediaLoudness, { assetId }),
  captionsPickDestination: (format) => ipcRenderer.invoke(IPC.captionsPickDestination, { format }),
  captionsWriteSidecar: (destination, content) =>
    ipcRenderer.invoke(IPC.captionsWriteSidecar, { destination, content }),
  marketingHandoffPickDir: () => ipcRenderer.invoke(IPC.marketingHandoffPickDir),
  marketingHandoffWrite: (args) => ipcRenderer.invoke(IPC.marketingHandoffWrite, args),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings),
  agentStatus: () => ipcRenderer.invoke(IPC.agentStatus),
  onAgentRequest: (cb) => {
    const listener = (
      _event: unknown,
      request: { id: string; tool: string; input: unknown }
    ): void => cb(request)
    ipcRenderer.on(IPC.agentRequest, listener)
    return () => ipcRenderer.removeListener(IPC.agentRequest, listener)
  },
  agentRespond: (id, result) => ipcRenderer.invoke(IPC.agentRespond, { id, result }),
  relinkAsset: (assetId) => ipcRenderer.invoke(IPC.relinkAsset, { assetId }),
  onLibraryChanged: (cb) => {
    const listener = (_event: unknown, snapshot: LibrarySnapshot): void => cb(snapshot)
    ipcRenderer.on(IPC.libraryChanged, listener)
    return () => ipcRenderer.removeListener(IPC.libraryChanged, listener)
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEditCommand: (cb) => {
    const listener = (_event: unknown, command: 'undo' | 'redo'): void => cb(command)
    ipcRenderer.on(IPC.editCommand, listener)
    return () => ipcRenderer.removeListener(IPC.editCommand, listener)
  },
  notifyEditState: (state) => ipcRenderer.send(IPC.editStateChanged, state)
}

// Test-only hook; the backing channel is only registered in main when
// MAGNETIC_TEST=1, so this is inert in production builds.
if (process.env.MAGNETIC_TEST === '1') {
  api.__test = {
    importPaths: (paths) => ipcRenderer.invoke(IPC.testImportPaths, { paths }),
    relinkPath: (assetId, path) => ipcRenderer.invoke(IPC.testRelinkPath, { assetId, path })
  }
}

contextBridge.exposeInMainWorld('api', api)
