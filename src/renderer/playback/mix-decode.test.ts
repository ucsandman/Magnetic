import { describe, expect, it } from 'vitest'
import { decodeAssetsOnce } from './mix-decode'

/**
 * Regression guard for the ">=N same-asset clips fail to export with 'Unable to
 * decode audio data'" bug. Root cause: renderMixdownWav decoded PCM per CLIP, so
 * a spine of N clips sharing one recording issued N concurrent ensurePcm calls,
 * and ensurePcm's cold-cache check-then-write raced N ffmpeg processes onto one
 * cache wav → a torn read → decodeAudioData rejection. decodeAssetsOnce decodes
 * each distinct asset exactly once, which removes the concurrent duplicate loads.
 */
describe('decodeAssetsOnce', () => {
  it('loads a shared asset exactly once for a 12-clip same-recording spine', async () => {
    const calls: string[] = []
    let inFlightSameAsset = 0
    let maxInFlightSameAsset = 0
    const loadBuffer = async (assetId: string): Promise<AudioBuffer> => {
      calls.push(assetId)
      inFlightSameAsset += 1
      maxInFlightSameAsset = Math.max(maxInFlightSameAsset, inFlightSameAsset)
      await Promise.resolve() // yield so any concurrent duplicate loads overlap here
      inFlightSameAsset -= 1
      return { assetId } as unknown as AudioBuffer
    }

    // The failing spine shape: 12 short clips, all splits of one recording.
    const assetIds = Array.from({ length: 12 }, () => 'take-1')
    const decoded = await decodeAssetsOnce(assetIds, loadBuffer)

    // Exactly one ensurePcm/decode for the shared asset — no concurrent cold
    // writes to race the pcm cache.
    expect(calls).toEqual(['take-1'])
    expect(maxInFlightSameAsset).toBe(1)
    expect(decoded.size).toBe(1)
    expect(decoded.get('take-1')).not.toBeNull()
  })

  it('decodes distinct assets once each and keeps a per-asset buffer lookup', async () => {
    const calls: string[] = []
    const loadBuffer = async (assetId: string): Promise<AudioBuffer> => {
      calls.push(assetId)
      return { assetId } as unknown as AudioBuffer
    }

    const decoded = await decodeAssetsOnce(['a', 'b', 'a', 'b', 'a'], loadBuffer)

    expect([...calls].sort()).toEqual(['a', 'b'])
    expect(decoded.size).toBe(2)
    expect((decoded.get('a') as unknown as { assetId: string }).assetId).toBe('a')
    expect((decoded.get('b') as unknown as { assetId: string }).assetId).toBe('b')
  })

  it('carries a null buffer through for an asset with no audio', async () => {
    const decoded = await decodeAssetsOnce(['silent'], async () => null)
    expect(decoded.get('silent')).toBeNull()
  })
})
