import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, linkSync } from 'fs'
import { linkOrCopy } from './import'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('fs', () => ({
  copyFileSync: vi.fn(),
  createReadStream: vi.fn(),
  existsSync: vi.fn(),
  linkSync: vi.fn()
}))

describe('linkOrCopy', () => {
  beforeEach(() => {
    vi.mocked(linkSync).mockReset()
    vi.mocked(copyFileSync).mockReset()
  })

  it('hardlinks when the volumes allow it — no byte copy', () => {
    linkOrCopy('C:/src/clip.mkv', 'C:/lib/media/clip.mkv')
    expect(linkSync).toHaveBeenCalledWith('C:/src/clip.mkv', 'C:/lib/media/clip.mkv')
    expect(copyFileSync).not.toHaveBeenCalled()
  })

  it('falls back to a byte copy on ANY link failure (EXDEV, permissions, FAT)', () => {
    vi.mocked(linkSync).mockImplementation(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    })
    linkOrCopy('D:/src/clip.mkv', 'C:/lib/media/clip.mkv')
    expect(copyFileSync).toHaveBeenCalledWith('D:/src/clip.mkv', 'C:/lib/media/clip.mkv')
  })
})
