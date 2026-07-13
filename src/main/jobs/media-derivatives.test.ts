import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from '../../shared/types'
import { ensurePcm } from './media-derivatives'

/**
 * Integration guard for the atomic pcm-cache write: ensurePcm extracts to a
 * private temp and renames into place, so concurrent same-asset cold callers
 * can never hand a half-written cache/pcm/<id>.wav to a reader (the export
 * "Unable to decode audio data" race — see renderer/playback/mix-decode.ts).
 * Runs the real ffmpeg against the tone fixture, like transcribe.test.ts.
 */

const ROOT = join(__dirname, '..', '..', '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
const FIXTURE = join(ROOT, 'fixtures', 'tone.wav')
const available = existsSync(FFMPEG) && existsSync(FIXTURE)

vi.mock('../binaries', async () => {
  const { join: joinPath } = await import('path')
  return {
    ffmpegPath: () => joinPath(__dirname, '..', '..', '..', 'resources', 'bin', 'ffmpeg.exe')
  }
})

function makeLibrary(): { root: string; asset: MediaAsset } {
  const root = mkdtempSync(join(tmpdir(), 'magnetic-pcm-test-'))
  mkdirSync(join(root, 'media'), { recursive: true })
  copyFileSync(FIXTURE, join(root, 'media', 'tone.wav'))
  const asset = {
    id: 'tone',
    fileName: 'tone.wav',
    libraryRelPath: join('media', 'tone.wav'),
    contentHash: 'x',
    durationFlicks: 0,
    audio: { codec: 'pcm_s16le', sampleRate: 48_000, channels: 2 },
    rating: 'none'
  } as unknown as MediaAsset
  return { root, asset }
}

function expectValidWav(absPath: string): void {
  const bytes = readFileSync(absPath)
  expect(bytes.length).toBeGreaterThan(44) // RIFF header + samples
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
}

describe.skipIf(!available)('ensurePcm atomic cache write (integration)', () => {
  it('produces the final wav with no lingering temp sibling', async () => {
    const { root, asset } = makeLibrary()
    const relPath = await ensurePcm(root, asset)
    expect(relPath).toBe(join('cache', 'pcm', 'tone.wav'))
    const absPath = join(root, relPath!)
    expectValidWav(absPath)
    const siblings = readdirSync(join(root, 'cache', 'pcm'))
    expect(siblings).toEqual(['tone.wav']) // no *.tmp-* leftovers
  }, 60_000)

  it('two concurrent cold calls for one asset both resolve to one valid wav', async () => {
    const { root, asset } = makeLibrary()
    const [a, b] = await Promise.all([ensurePcm(root, asset), ensurePcm(root, asset)])
    expect(a).toBe(join('cache', 'pcm', 'tone.wav'))
    expect(b).toBe(a)
    expectValidWav(join(root, a!))
    const siblings = readdirSync(join(root, 'cache', 'pcm'))
    expect(siblings).toEqual(['tone.wav'])
  }, 60_000)

  it('returns null for an asset with no audio stream', async () => {
    const { root, asset } = makeLibrary()
    expect(await ensurePcm(root, { ...asset, audio: undefined })).toBeNull()
  })
})
