import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJson, writeJsonAtomic } from './atomic'

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
