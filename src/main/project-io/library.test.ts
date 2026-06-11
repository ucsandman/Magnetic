import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import { LibraryStore, getAutoTranscribe, setAutoTranscribe } from './library'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magnetic-library-'))
  userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('rememberAsLastUsed', () => {
  it('preserves other settings keys instead of clobbering them', () => {
    const store = LibraryStore.create(join(dir, 'Test.mglib'))
    setAutoTranscribe(false)
    store.rememberAsLastUsed()
    expect(getAutoTranscribe()).toBe(false) // was wiped back to default true
    expect(LibraryStore.resolveStartupPath()).toBe(join(dir, 'Test.mglib'))
  })
})
