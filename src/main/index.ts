import { app, shell, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { buildAppMenu, watchEditState } from './menu'
import { registerExportIpc } from './export/encoder'
import { registerMfileScheme, installMfileHandler } from './protocol'
import {
  buildSnapshot,
  ensurePcmUrl,
  ensureProxyUrl,
  enqueueTranscription,
  getStore,
  importAndProcess,
  importViaDialog,
  initAppState,
  relinkAsset,
  relinkViaDialog
} from './app-state'
import { getAutoTranscribe, setAutoTranscribe } from './project-io/library'

registerMfileScheme()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#161617',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.practicalsystems.magnetic')
  nativeTheme.themeSource = 'dark'

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initAppState()
  installMfileHandler(() => [getStore().root])
  registerIpc({
    getSnapshot: () => buildSnapshot(),
    importPaths: (paths) => importAndProcess(paths),
    importDialog: () => importViaDialog(),
    setRating: (assetId, rating) => getStore().setRating(assetId, rating),
    getProject: () => getStore().getOrCreateDefaultProject(),
    saveSequence: (projectId, sequence) => getStore().saveProjectSequence(projectId, sequence),
    ensurePcm: (assetId) => ensurePcmUrl(assetId),
    ensureProxy: (assetId) => ensureProxyUrl(assetId),
    transcribe: (assetId) => enqueueTranscription(assetId),
    getSettings: () => ({ autoTranscribe: getAutoTranscribe() }),
    setSettings: (settings) => setAutoTranscribe(settings.autoTranscribe),
    relink: (assetId) => relinkViaDialog(assetId),
    relinkPath: (assetId, path) => relinkAsset(assetId, path)
  })
  // Flush any debounced library/project writes before the process exits.
  app.on('before-quit', () => getStore().saveNow())
  buildAppMenu({ onImportMedia: () => void importViaDialog() })
  watchEditState()
  registerExportIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  try {
    getStore().saveNow()
  } catch {
    // library never initialized — nothing to save
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
