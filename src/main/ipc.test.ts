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
  getProject: () => ({
    id: 'p1',
    name: 'P',
    sequence: { id: 's1', fps: { num: 30, den: 1 }, spine: [], connected: [] }
  }),
  saveSequence: () => {}
}

function registeredChannels(): string[] {
  return vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
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
