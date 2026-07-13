import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import { isAllowedPath, getAgentMediaFolders } from './agent-allowlist'
import { setAgentMediaFolders } from './project-io/library'

// Symlinks require elevated privileges on some Windows CI runners — probe
// once and skip the escape test there rather than fail the whole suite.
const symlinkProbeDir = mkdtempSync(join(tmpdir(), 'magnetic-symlink-probe-'))
let symlinksSupported = true
try {
  const target = join(symlinkProbeDir, 'target')
  writeFileSync(target, '')
  symlinkSync(target, join(symlinkProbeDir, 'link'), 'file')
} catch {
  symlinksSupported = false
} finally {
  rmSync(symlinkProbeDir, { recursive: true, force: true })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'magnetic-allowlist-'))
  userData = join(dir, 'userData')
  mkdirSync(userData, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('isAllowedPath', () => {
  it('rejects everything when the allowlist is empty', () => {
    expect(isAllowedPath(dir, [])).toBe(false)
  })

  it('allows a file inside an allowlisted directory', () => {
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    const file = join(allowed, 'clip.mp4')
    writeFileSync(file, '')
    expect(isAllowedPath(file, [allowed])).toBe(true)
  })

  it('rejects a file outside every allowlisted directory', () => {
    const allowed = join(dir, 'allowed')
    const outside = join(dir, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    const file = join(outside, 'clip.mp4')
    writeFileSync(file, '')
    expect(isAllowedPath(file, [allowed])).toBe(false)
  })

  it('rejects a ..\\ traversal that resolves outside the allowlist', () => {
    const allowed = join(dir, 'allowed')
    mkdirSync(allowed)
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'outside', 'clip.mp4'), '')
    // built with raw string concatenation (not path.join/resolve) so the
    // literal ".." segment survives into isAllowedPath for it to resolve
    const traversal = `${allowed}${sep}..${sep}outside${sep}clip.mp4`
    expect(isAllowedPath(traversal, [allowed])).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')(
    'is case-insensitive on win32 for drive/dir casing',
    () => {
      const allowed = join(dir, 'Allowed')
      mkdirSync(allowed)
      const file = join(allowed, 'Clip.mp4')
      writeFileSync(file, '')
      const differentCase = join(dir, 'ALLOWED', 'Clip.mp4')
      expect(isAllowedPath(differentCase, [allowed])).toBe(true)
    }
  )

  it.skipIf(!symlinksSupported)(
    'rejects a symlink inside the allowlist that points outside it',
    () => {
      const allowed = join(dir, 'allowed')
      const outside = join(dir, 'outside')
      mkdirSync(allowed)
      mkdirSync(outside)
      const target = join(outside, 'secret.mp4')
      writeFileSync(target, '')
      const link = join(allowed, 'link.mp4')
      symlinkSync(target, link, 'file')
      expect(isAllowedPath(link, [allowed])).toBe(false)
    }
  )
})

describe('getAgentMediaFolders', () => {
  it('reads the same persisted setting store Agent Access uses', () => {
    expect(getAgentMediaFolders()).toEqual([])
    setAgentMediaFolders([join(dir, 'allowed')])
    expect(getAgentMediaFolders()).toEqual([join(dir, 'allowed')])
  })
})
