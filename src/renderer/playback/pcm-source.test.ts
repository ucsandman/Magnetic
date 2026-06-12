import { describe, expect, it } from 'vitest'
import {
  int16ToFloat32Channels,
  parseWavHeader,
  windowByteRange,
  type WavFormat
} from './pcm-source'

/**
 * Pure-math proof for the windowed PCM reader: RIFF header discovery across
 * extra/odd chunks and lying size fields, frame↔byte window math at the data
 * chunk edges, and the Int16→Float32 fill that replaces decodeAudioData.
 * Synthetic wavs are built in-memory — no fixtures.
 */

function makeWav(opts: {
  sampleRate?: number
  channels?: number
  /** Interleaved Int16 samples. */
  samples?: number[]
  /** Chunks inserted between fmt and data (odd sizes get a pad byte). */
  extraChunks?: { id: string; bytes: number[] }[]
  declaredDataBytes?: number
}): DataView {
  const sampleRate = opts.sampleRate ?? 48_000
  const channels = opts.channels ?? 2
  const samples = opts.samples ?? []
  const extra = opts.extraChunks ?? []
  const extraBytes = extra.reduce((sum, c) => sum + 8 + c.bytes.length + (c.bytes.length % 2), 0)
  const dataBytes = samples.length * 2
  const view = new DataView(new ArrayBuffer(44 + extraBytes + dataBytes))
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, view.byteLength - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  let offset = 36
  for (const chunk of extra) {
    ascii(offset, chunk.id)
    view.setUint32(offset + 4, chunk.bytes.length, true)
    for (let i = 0; i < chunk.bytes.length; i++) view.setUint8(offset + 8 + i, chunk.bytes[i])
    offset += 8 + chunk.bytes.length + (chunk.bytes.length % 2)
  }
  ascii(offset, 'data')
  view.setUint32(offset + 4, opts.declaredDataBytes ?? dataBytes, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(offset + 8 + i * 2, samples[i], true)
  return view
}

describe('parseWavHeader', () => {
  it('parses a minimal canonical stereo wav', () => {
    const view = makeWav({ samples: [1, 2, 3, 4, 5, 6, 7, 8] }) // 4 stereo frames
    const format = parseWavHeader(view, view.byteLength)
    expect(format).toEqual({
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 16,
      durationSec: 4 / 48_000
    })
  })

  it('parses mono and computes duration from blockAlign', () => {
    const view = makeWav({ channels: 1, sampleRate: 8_000, samples: [0, 0, 0, 0] })
    const format = parseWavHeader(view, view.byteLength)
    expect(format.channels).toBe(1)
    expect(format.dataBytes).toBe(8)
    expect(format.durationSec).toBe(4 / 8_000)
  })

  it('skips extra chunks (LIST) and odd-size chunks with pad bytes before data', () => {
    const view = makeWav({
      samples: [9, 9],
      extraChunks: [
        { id: 'LIST', bytes: [73, 78, 70, 79] }, // "INFO"
        { id: 'junk', bytes: [1, 2, 3] } // odd size → 1 pad byte
      ]
    })
    const format = parseWavHeader(view, view.byteLength)
    expect(format.dataOffset).toBe(44 + 12 + 12)
    expect(format.dataBytes).toBe(4)
  })

  it('derives dataBytes from the file size when the declared size lies (>4 GB wavs)', () => {
    for (const declared of [0, 0xffffffff]) {
      const view = makeWav({ samples: [1, 2, 3, 4], declaredDataBytes: declared })
      expect(parseWavHeader(view, view.byteLength).dataBytes).toBe(8)
    }
    // declared overflows the actual file → clamp (and floor to whole frames)
    const view = makeWav({ samples: [1, 2, 3, 4], declaredDataBytes: 5_000 })
    expect(parseWavHeader(view, view.byteLength + 2).dataBytes).toBe(8)
  })

  it('trusts a sane declared size when the probe is only a prefix of the file', () => {
    const view = makeWav({ declaredDataBytes: 1_000 })
    const format = parseWavHeader(view, 44 + 1_000)
    expect(format.dataOffset).toBe(44)
    expect(format.dataBytes).toBe(1_000)
  })

  it('rejects non-RIFF, missing data, non-PCM and non-16-bit files', () => {
    expect(() => parseWavHeader(new DataView(new ArrayBuffer(44)), 44)).toThrow(/RIFF/)

    const noData = makeWav({})
    new Uint8Array(noData.buffer)[36] = 'X'.charCodeAt(0) // 'data' → 'Xata'
    expect(() => parseWavHeader(noData, noData.byteLength)).toThrow(/no data chunk/)

    const float32 = makeWav({})
    float32.setUint16(20, 3, true) // IEEE float
    expect(() => parseWavHeader(float32, float32.byteLength)).toThrow(/codec 3/)

    const deep = makeWav({})
    deep.setUint16(34, 24, true)
    expect(() => parseWavHeader(deep, deep.byteLength)).toThrow(/depth 24/)
  })
})

describe('windowByteRange', () => {
  // 10 Hz stereo keeps the math readable: blockAlign 4, 100 frames, 10 s
  const format: WavFormat = {
    sampleRate: 10,
    channels: 2,
    bitsPerSample: 16,
    dataOffset: 44,
    dataBytes: 400,
    durationSec: 10
  }

  it('maps a full-file window to the exact data chunk bytes', () => {
    expect(windowByteRange(format, 0, 10)).toEqual({ start: 44, end: 443, frames: 100 })
  })

  it('maps an interior window by frame × blockAlign', () => {
    // frames 20..49 → bytes 124..243
    expect(windowByteRange(format, 2, 3)).toEqual({ start: 124, end: 243, frames: 30 })
  })

  it('clamps the final partial window to the data chunk end', () => {
    expect(windowByteRange(format, 8, 10)).toEqual({ start: 364, end: 443, frames: 20 })
  })

  it('returns null for windows entirely outside the data chunk', () => {
    expect(windowByteRange(format, 10, 5)).toBeNull()
    expect(windowByteRange(format, 12, 1)).toBeNull()
    expect(windowByteRange(format, 0, 0)).toBeNull()
  })

  it('clamps a negative start to the first frame', () => {
    expect(windowByteRange(format, -1, 2)).toEqual({ start: 44, end: 123, frames: 20 })
  })

  it('rounds odd window edges to the nearest frame', () => {
    // 0.25 s × 10 Hz = frame 2.5 → 3; 0.5 s → 5 frames
    expect(windowByteRange(format, 0.25, 0.5)).toEqual({ start: 56, end: 75, frames: 5 })
  })

  it('keeps chained windows byte-contiguous at a real sample rate', () => {
    const real: WavFormat = {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 48_000 * 4 * 100, // 100 s
      durationSec: 100
    }
    const mediaBase = 0.337 // deliberately not frame-aligned
    let previousEnd: number | null = null
    for (let i = 0; i < 9; i++) {
      const window = windowByteRange(real, mediaBase + i * 10, 10)!
      if (previousEnd !== null) expect(window.start).toBe(previousEnd + 1)
      previousEnd = window.end
    }
  })
})

describe('int16ToFloat32Channels', () => {
  const viewOf = (samples: number[]): DataView => {
    const view = new DataView(new ArrayBuffer(samples.length * 2))
    samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
    return view
  }

  it('converts extremes symmetrically around x / 32768', () => {
    const [mono] = int16ToFloat32Channels(viewOf([-32768, 32767, 0, 16384]), 1)
    expect(Array.from(mono)).toEqual([-1, 32767 / 32768, 0, 0.5])
  })

  it('de-interleaves stereo frames', () => {
    const [left, right] = int16ToFloat32Channels(viewOf([100, -100, 200, -200]), 2)
    expect(Array.from(left)).toEqual([100 / 32768, 200 / 32768])
    expect(Array.from(right)).toEqual([-100 / 32768, -200 / 32768])
  })

  it('truncates a trailing partial frame', () => {
    const view = new DataView(viewOf([1, 2, 3, 4]).buffer, 0, 6) // 1.5 stereo frames
    const [left, right] = int16ToFloat32Channels(view, 2)
    expect(left).toHaveLength(1)
    expect(right).toHaveLength(1)
  })
})
