import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJson, renameWithRetry, writeJsonAtomic } from './atomic'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magnetic-atomic-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes and reads back JSON', () => {
    const file = join(dir, 'library.json')
    writeJsonAtomic(file, { hello: 'world' })
    expect(readJson(file)).toEqual({ hello: 'world' })
  })

  it('replaces an existing file atomically (no partial state)', () => {
    const file = join(dir, 'library.json')
    writeJsonAtomic(file, { version: 1 })
    writeJsonAtomic(file, { version: 2 })
    expect(readJson(file)).toEqual({ version: 2 })
    // no stray temp files left behind
    expect(readdirSync(dir)).toEqual(['library.json'])
  })

  it('a throwing serializer leaves the previous file untouched', () => {
    const file = join(dir, 'library.json')
    writeJsonAtomic(file, { version: 1 })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic // JSON.stringify throws on cycles
    expect(() => writeJsonAtomic(file, cyclic)).toThrow()
    expect(readJson(file)).toEqual({ version: 1 })
  })

  it('a crash between temp-write and rename leaves the previous file valid', () => {
    const file = join(dir, 'library.json')
    writeJsonAtomic(file, { version: 1 })
    // Simulate the crash: a partial temp file exists, rename never happened.
    writeFileSync(join(dir, '.tmp-9999-library.json'), '{"version": 2, "trunca', 'utf8')
    expect(readJson(file)).toEqual({ version: 1 })
  })
})

describe('rename retry (Windows EBUSY from AV/indexer scans)', () => {
  const ebusy = (): never => {
    const error = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException
    error.code = 'EBUSY'
    throw error
  }
  const noSleep = (): void => {}

  it('retries EBUSY renames and succeeds once the lock clears', () => {
    let calls = 0
    let renamed: [string, string] | null = null
    renameWithRetry(
      'from',
      'to',
      (from, to) => {
        calls += 1
        if (calls <= 2) ebusy()
        renamed = [from, to]
      },
      noSleep
    )
    expect(calls).toBe(3)
    expect(renamed).toEqual(['from', 'to'])
  })

  it('gives up after persistent EBUSY and rethrows', () => {
    let calls = 0
    expect(() =>
      renameWithRetry(
        'from',
        'to',
        () => {
          calls += 1
          ebusy()
        },
        noSleep
      )
    ).toThrow(/EBUSY/)
    expect(calls).toBe(6)
  })

  it('does not retry non-lock errors', () => {
    let calls = 0
    expect(() =>
      renameWithRetry(
        'from',
        'to',
        () => {
          calls += 1
          const error = new Error('ENOENT: no such file') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        },
        noSleep
      )
    ).toThrow(/ENOENT/)
    expect(calls).toBe(1)
  })
})
