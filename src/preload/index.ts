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
  transcribeAsset: (assetId) => ipcRenderer.invoke(IPC.transcribeRun, { assetId }),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (settings) => ipcRenderer.invoke(IPC.settingsSet, settings),
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
    importPaths: (paths) => ipcRenderer.invoke(IPC.testImportPaths, { paths })
  }
}

contextBridge.exposeInMainWorld('api', api)
