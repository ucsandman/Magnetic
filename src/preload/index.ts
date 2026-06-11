import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/channels'
import type { MagneticApi } from '../shared/ipc'

const api: MagneticApi = {
  diagBinaries: () => ipcRenderer.invoke(IPC.diagBinaries)
}

contextBridge.exposeInMainWorld('api', api)
