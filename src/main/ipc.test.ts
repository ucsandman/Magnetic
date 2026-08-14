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
    agentToken: null,
    agentMediaFolders: [],
    copilotProvider: null
  }),
  setSettings: () => {},
  agentStatus: () => ({ running: false, port: null, token: null }),
  agentFolderPickDialog: async () => null,
  copilotCliStatus: async () => ({ found: false, version: null }),
  agentRespond: () => {},
  copilotToolRespond: () => {},
  copilotCliTurn: async () => ({ ok: true, reply: '', sessionId: null }),
  copilotCliCancel: () => {},
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
    expect(handlers.length).toBeGreaterThanOrEqual(15)
    // a payload that satisfies NO channel schema (wrong types everywhere)
    const garbage = { assetId: 42, paths: 'nope', rating: 'meh', projectId: null, bogus: true }
    for (const [channel, handler] of handlers) {
      await expect(handler({}, garbage), `channel ${channel} accepted garbage`).rejects.toThrow(
        /Invalid payload/
      )
    }
  })
})

describe('copilot CLI channels reject targeted malformed payloads', () => {
  it('rejects junk shaped close to the real payload', async () => {
    registerIpc(deps, { MAGNETIC_TEST: '1' })
    const handlers = vi.mocked(ipcMain.handle).mock.calls as unknown as [
      string,
      (event: unknown, payload: unknown) => Promise<unknown>
    ][]
    const handlerFor = (channel: string): ((event: unknown, payload: unknown) => Promise<unknown>) => {
      const found = handlers.find(([registered]) => registered === channel)
      if (found === undefined) throw new Error(`no handler registered for ${channel}`)
      return found[1]
    }
    await expect(
      handlerFor(IPC.copilotCliTurn)({}, { turnId: 5 }),
      `channel ${IPC.copilotCliTurn} accepted garbage`
    ).rejects.toThrow(/Invalid payload/)
    await expect(
      handlerFor(IPC.copilotCliCancel)({}, {}),
      `channel ${IPC.copilotCliCancel} accepted garbage`
    ).rejects.toThrow(/Invalid payload/)
    await expect(
      handlerFor(IPC.copilotToolRespond)({}, { id: 1 }),
      `channel ${IPC.copilotToolRespond} accepted garbage`
    ).rejects.toThrow(/Invalid payload/)
    await expect(
      handlerFor(IPC.copilotCliStatus)({}, 'x'),
      `channel ${IPC.copilotCliStatus} accepted garbage`
    ).rejects.toThrow(/Invalid payload/)
  })
})

describe('settingsSet copilotProvider validation', () => {
  it('rejects a bogus provider and accepts a valid one', async () => {
    registerIpc(deps, { MAGNETIC_TEST: '1' })
    const handlers = vi.mocked(ipcMain.handle).mock.calls as unknown as [
      string,
      (event: unknown, payload: unknown) => Promise<unknown>
    ][]
    const handlerFor = (channel: string): ((event: unknown, payload: unknown) => Promise<unknown>) => {
      const found = handlers.find(([registered]) => registered === channel)
      if (found === undefined) throw new Error(`no handler registered for ${channel}`)
      return found[1]
    }
    await expect(
      handlerFor(IPC.settingsSet)({}, { copilotProvider: 'bogus' }),
      `channel ${IPC.settingsSet} accepted a bogus provider`
    ).rejects.toThrow(/Invalid payload/)
    await expect(
      handlerFor(IPC.settingsSet)({}, { copilotProvider: 'subscription' })
    ).resolves.toBeUndefined()
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
