import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import { handleImportMedia, type ImportMediaDeps } from './agent-import'

let dir: string
let allowed: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magnetic-import-media-'))
  userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
  allowed = join(dir, 'allowed')
  mkdirSync(allowed)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deps(overrides: Partial<ImportMediaDeps> = {}): ImportMediaDeps {
  return {
    allowlist: () => [allowed],
    importAndProcess: async (paths) => ({
      importedIds: paths.map((_, i) => `id-${i}`),
      errors: []
    }),
    fileNameOf: (id) => `${id}.mp4`,
    ...overrides
  }
}

describe('handleImportMedia — payload shape', () => {
  it('rejects a non-array paths value', async () => {
    await expect(handleImportMedia({ paths: 'not-an-array' }, deps())).rejects.toThrow()
  })

  it('rejects an empty paths array', async () => {
    await expect(handleImportMedia({ paths: [] }, deps())).rejects.toThrow()
  })

  it('rejects non-string entries in paths', async () => {
    await expect(handleImportMedia({ paths: [123] }, deps())).rejects.toThrow()
  })
})

describe('handleImportMedia — allowlist and existence', () => {
  it('rejects the whole call, naming the offending path, when one path is outside the allowlist', async () => {
    const good = join(allowed, 'clip.mp4')
    writeFileSync(good, '')
    const outside = join(dir, 'outside.mp4')
    writeFileSync(outside, '')
    let called = false
    const d = deps({
      importAndProcess: async (paths) => {
        called = true
        return { importedIds: paths.map((_, i) => `id-${i}`), errors: [] }
      }
    })
    await expect(handleImportMedia({ paths: [good, outside] }, d)).rejects.toThrow(
      /outside.mp4/
    )
    expect(called).toBe(false)
  })

  it('rejects the whole call, naming the offending path, when an allowlisted path does not exist', async () => {
    const good = join(allowed, 'clip.mp4')
    writeFileSync(good, '')
    const missing = join(allowed, 'missing.mp4')
    let called = false
    const d = deps({
      importAndProcess: async (paths) => {
        called = true
        return { importedIds: paths.map((_, i) => `id-${i}`), errors: [] }
      }
    })
    await expect(handleImportMedia({ paths: [good, missing] }, d)).rejects.toThrow(
      /missing\.mp4/
    )
    expect(called).toBe(false)
  })
})

describe('handleImportMedia — success', () => {
  it('imports once and maps assetId/fileName', async () => {
    const a = join(allowed, 'a.mp4')
    const b = join(allowed, 'b.mp4')
    writeFileSync(a, '')
    writeFileSync(b, '')
    const result = await handleImportMedia({ paths: [a, b] }, deps())
    expect(result).toEqual({
      assets: [
        { assetId: 'id-0', fileName: 'id-0.mp4' },
        { assetId: 'id-1', fileName: 'id-1.mp4' }
      ]
    })
  })
})
