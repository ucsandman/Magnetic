import { describe, expect, it } from 'vitest'
import { RmsWindowAccumulator } from './audio-envelope'

const SAMPLES_PER_WINDOW = 400 // 50 ms at 8 kHz

/** Reference implementation: whole-buffer RMS windows (the pre-streaming math). */
function referenceRmsDb(pcm: Buffer): number[] {
  const sampleCount = Math.floor(pcm.length / 2)
  const out: number[] = []
  for (let start = 0; start < sampleCount; start += SAMPLES_PER_WINDOW) {
    const end = Math.min(sampleCount, start + SAMPLES_PER_WINDOW)
    let sumSquares = 0
    for (let i = start; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768
      sumSquares += value * value
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start))
    const db = rms <= 0 ? -100 : Math.max(-100, 20 * Math.log10(rms))
    out.push(Math.round(db * 10) / 10)
  }
  return out
}

function syntheticPcm(samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    // deterministic mix of tone and quiet stretches, incl. true zeros
    const value = i % 1000 < 300 ? 0 : Math.round(12000 * Math.sin(i / 7) + 3000 * Math.sin(i / 31))
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2)
  }
  return pcm
}

function accumulate(pcm: Buffer, chunkSizes: number[]): number[] {
  const accumulator = new RmsWindowAccumulator()
  let offset = 0
  let sizeIndex = 0
  while (offset < pcm.length) {
    const size = Math.min(chunkSizes[sizeIndex % chunkSizes.length], pcm.length - offset)
    accumulator.push(pcm.subarray(offset, offset + size))
    offset += size
    sizeIndex += 1
  }
  return accumulator.finish()
}

describe('RmsWindowAccumulator', () => {
  const pcm = syntheticPcm(3 * SAMPLES_PER_WINDOW + 137) // partial trailing window
  const expected = referenceRmsDb(pcm)

  it('matches the whole-buffer computation when fed one chunk', () => {
    expect(accumulate(pcm, [pcm.length])).toEqual(expected)
  })

  it('matches across odd-byte chunk splits (16-bit samples straddle chunks)', () => {
    expect(accumulate(pcm, [1])).toEqual(expected)
    expect(accumulate(pcm, [3, 7, 1])).toEqual(expected)
    expect(accumulate(pcm, [SAMPLES_PER_WINDOW * 2 - 1])).toEqual(expected)
  })

  it('matches across window-straddling chunk sizes', () => {
    expect(accumulate(pcm, [SAMPLES_PER_WINDOW * 2 + 2, 999])).toEqual(expected)
  })

  it('reports the silence floor for all-zero audio and handles empty input', () => {
    const silent = Buffer.alloc(SAMPLES_PER_WINDOW * 2)
    expect(accumulate(silent, [50])).toEqual([-100])
    expect(new RmsWindowAccumulator().finish()).toEqual([])
  })
})
