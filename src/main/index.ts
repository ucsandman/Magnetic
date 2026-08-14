import { app, dialog, shell, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { buildAppMenu, watchEditState } from './menu'
import { registerExportIpc } from './export/encoder'
import { registerSmartExportIpc } from './export/smart-render'
import { registerMarketingHandoffIpc } from './export/marketing-handoff'
import { registerCaptionsIpc } from './captions'
import { registerMfileScheme, installMfileHandler } from './protocol'
import { resolveClaudeCli } from './copilot-cli'
import { resolveCopilotToolRequest } from './copilot-bridge'
import { runCopilotCliTurn, cancelCopilotCliTurn } from './copilot-turn'
import {
  assetLoudness,
  buildSnapshot,
  ensurePcmUrl,
  ensureProxyUrl,
  enqueueDenoise,
  enqueueTranscription,
  getStore,
  importAndProcess,
  importViaDialog,
  initAppState,
  initMediaServer,
  relinkAsset,
  relinkViaDialog
} from './app-state'
import { randomUUID } from 'crypto'
import {
  agentSidecarStatus,
  resolveAgentRequest,
  startAgentSidecar,
  stopAgentSidecar
} from './agent-sidecar'
import {
  getAgentAccess,
  getAgentMediaFolders,
  getAgentToken,
  getAnthropicApiKey,
  getAutoTranscribe,
  setAgentAccess,
  setAgentMediaFolders,
  setAgentToken,
  setAnthropicApiKey,
  setAutoTranscribe
} from './project-io/library'

// E2E launches must not share localStorage/caches with each other or with the
// real profile — isolate userData next to the per-test library directory.
if (process.env.MAGNETIC_TEST === '1' && process.env.MAGNETIC_LIBRARY_PATH !== undefined) {
  app.setPath('userData', process.env.MAGNETIC_LIBRARY_PATH + '-userData')
}

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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.practicalsystems.magnetic')
  nativeTheme.themeSource = 'dark'

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initAppState()
  await initMediaServer()
  installMfileHandler(() => [getStore().root])
  registerIpc({
    getSnapshot: () => buildSnapshot(),
    importPaths: (paths) => importAndProcess(paths),
    importDialog: () => importViaDialog(),
    setRating: (assetId, rating) => getStore().setRating(assetId, rating),
    deleteAsset: (assetId) => getStore().deleteAsset(assetId),
    getProject: () => getStore().getOrCreateDefaultProject(),
    saveSequence: (projectId, sequence) => getStore().saveProjectSequence(projectId, sequence),
    ensurePcm: (assetId) => ensurePcmUrl(assetId),
    ensureProxy: (assetId) => ensureProxyUrl(assetId),
    transcribe: (assetId) => enqueueTranscription(assetId),
    denoise: (assetId) => enqueueDenoise(assetId),
    loudness: (assetId) => assetLoudness(assetId),
    getSettings: () => ({
      autoTranscribe: getAutoTranscribe(),
      anthropicApiKey: getAnthropicApiKey(),
      agentAccess: getAgentAccess(),
      agentToken: getAgentToken(),
      agentMediaFolders: getAgentMediaFolders()
    }),
    setSettings: (settings) => {
      if (settings.autoTranscribe !== undefined) setAutoTranscribe(settings.autoTranscribe)
      if (settings.anthropicApiKey !== undefined) setAnthropicApiKey(settings.anthropicApiKey)
      if (settings.agentToken !== undefined) setAgentToken(settings.agentToken)
      if (settings.agentMediaFolders !== undefined) setAgentMediaFolders(settings.agentMediaFolders)
      if (settings.agentAccess !== undefined) {
        setAgentAccess(settings.agentAccess)
        if (settings.agentAccess) {
          let sidecarToken = getAgentToken()
          if (sidecarToken === null) {
            sidecarToken = randomUUID()
            setAgentToken(sidecarToken)
          }
          void startAgentSidecar(sidecarToken)
        } else {
          void stopAgentSidecar()
        }
      } else if (settings.agentToken !== undefined && agentSidecarStatus().running) {
        // token rotated while running: bounce the sidecar onto the new token
        void stopAgentSidecar().then(() => startAgentSidecar(settings.agentToken as string))
      }
    },
    agentStatus: () => agentSidecarStatus(),
    agentRespond: (id, result) => resolveAgentRequest(id, result),
    agentFolderPickDialog: async () => {
      const picked = await dialog.showOpenDialog({
        title: 'Agent Access — allow a media folder',
        properties: ['openDirectory']
      })
      return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
    },
    copilotCliStatus: async () => {
      const status = await resolveClaudeCli()
      return { found: status.found, version: status.version }
    },
    relink: (assetId) => relinkViaDialog(assetId),
    relinkPath: (assetId, path) => relinkAsset(assetId, path),
    copilotToolRespond: (id, ok, content) => resolveCopilotToolRequest(id, ok, content),
    copilotCliTurn: (args) => runCopilotCliTurn(args),
    copilotCliCancel: (turnId) => cancelCopilotCliTurn(turnId)
  })
  // Flush any debounced library/project writes before the process exits.
  app.on('before-quit', () => getStore().saveNow())
  buildAppMenu({ onImportMedia: () => void importViaDialog() })
  watchEditState()
  registerExportIpc()
  registerSmartExportIpc()
  registerMarketingHandoffIpc()
  registerCaptionsIpc()
  createWindow()

  // Agent Access: opt-in via the Sidebar toggle (persisted) or MAGNETIC_AGENT=1
  if (process.env.MAGNETIC_AGENT === '1' || getAgentAccess()) {
    let sidecarToken = process.env.MAGNETIC_AGENT_TOKEN ?? getAgentToken()
    if (sidecarToken === null || sidecarToken === '') {
      sidecarToken = randomUUID()
      setAgentToken(sidecarToken)
    }
    void startAgentSidecar(sidecarToken)
  }

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
