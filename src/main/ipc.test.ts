import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '../shared/channels'
import { registerIpc, isTestMode, type IpcDeps } from './ipc'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false }
}))

const deps: IpcDeps = {
  getSnapshot: () => ({ id: 'l', name: 'L', path: 'p', events: [], assets: {} }),
  importPaths: async () => ({ importedIds: [], errors: [] }),
  importDialog: async () => ({ importedIds: [], errors: [] }),
  setRating: () => {},
  deleteAsset: () => {},
  getProject: () => ({
    id: 'p1',
    name: 'P',
    sequence: { id: 's1', fps: { num: 30, den: 1 }, spine: [], connected: [] }
  }),
  saveSequence: () => {},
  ensurePcm: async () => null,
  ensureProxy: async () => 'mfile:///proxy.mp4',
  transcribe: () => {},
  denoise: () => {},
  loudness: async () => -23,
  getSettings: () => ({
    autoTranscribe: true,
    anthropicApiKey: null,
    agentAccess: false,
    agentToken: null
  }),
  setSettings: () => {},
  agentStatus: () => ({ running: false, port: null, token: null }),
  agentRespond: () => {},
  relink: async () => {},
  relinkPath: async () => {}
}

function registeredChannels(): string[] {
  return vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
})

describe('malformed payloads reject on every channel', () => {
  it('every registered handler rejects a garbage payload instead of running', async () => {
    registerIpc(deps, { MAGNETIC_TEST: '1' })
    const handlers = vi.mocked(ipcMain.handle).mock.calls as unknown as [
      string,
      (event: unknown, payload: unknown) => Promise<unknown>
    ][]
    expect(handlers.length).toBeGreaterThanOrEqual(14)
    // a payload that satisfies NO channel schema (wrong types everywhere)
    const garbage = { assetId: 42, paths: 'nope', rating: 'meh', projectId: null, bogus: true }
    for (const [channel, handler] of handlers) {
      await expect(handler({}, garbage), `channel ${channel} accepted garbage`).rejects.toThrow(
        /Invalid payload/
      )
    }
  })
})

describe('__test IPC surface gating', () => {
  it('does NOT register test channels without MAGNETIC_TEST=1', () => {
    registerIpc(deps, {})
    expect(registeredChannels()).not.toContain(IPC.testImportPaths)
  })

  it('does not treat other values as test mode', () => {
    expect(isTestMode({})).toBe(false)
    expect(isTestMode({ MAGNETIC_TEST: '0' })).toBe(false)
    expect(isTestMode({ MAGNETIC_TEST: 'true' })).toBe(false)
    expect(isTestMode({ MAGNETIC_TEST: '1' })).toBe(true)
  })

  it('registers the test channel only when MAGNETIC_TEST=1', () => {
    registerIpc(deps, { MAGNETIC_TEST: '1' })
    expect(registeredChannels()).toContain(IPC.testImportPaths)
  })

  it('always registers the production channels', () => {
    registerIpc(deps, {})
    const channels = registeredChannels()
    for (const channel of [
      IPC.diagBinaries,
      IPC.libraryGet,
      IPC.libraryImportPaths,
      IPC.libraryImportDialog,
      IPC.assetSetRating
    ]) {
      expect(channels).toContain(channel)
    }
  })
})
