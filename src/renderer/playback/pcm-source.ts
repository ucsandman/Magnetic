/**
 * Random-access reader for the PCM wav cache (media-derivatives.ts writes
 * pcm_s16le, i.e. 16-bit little-endian integer frames). One small Range fetch
 * parses the RIFF header; after that any time window maps to an exact byte
 * range (offset = dataOffset + frame × blockAlign), so a 6-hour file plays
 * without ever holding more than a window of samples in memory.
 *
 * The header parser, byte-range math and Int16→Float32 conversion are pure
 * (DataView in, numbers/Float32Array out) and unit-tested without an
 * AudioContext; only openPcm/windowBuffer touch fetch and AudioBuffer.
 */

export interface WavFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Absolute byte offset of the first PCM frame (start of the data chunk body). */
  dataOffset: number
  /** Byte length of the PCM payload, clamped to the real file size and whole frames. */
  dataBytes: number
  durationSec: number
}

export interface PcmSource extends WavFormat {
  /**
   * Range-fetch exactly the PCM bytes covering [fromSec, fromSec + durSec)
   * and fill an AudioBuffer directly (no decodeAudioData). Returns null when
   * the window is clamped to nothing (entirely outside the data chunk).
   */
  windowBuffer(ctx: BaseAudioContext, fromSec: number, durSec: number): Promise<AudioBuffer | null>
}

/** RIFF chunks before `data` (fmt, LIST/INFO, fact…) comfortably fit here. */
const HEADER_PROBE_BYTES = 65_536

const fourcc = (view: DataView, offset: number): string =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )

/**
 * Walk the RIFF chunk list in `view` (the head of the file) and locate fmt +
 * data. Handles extra chunks (e.g. ffmpeg's LIST/INFO) and odd-size padding.
 * `fileSize` is the real on-disk size: the declared data size is distrusted
 * when it is 0/0xFFFFFFFF or overflows the file (ffmpeg wavs beyond 4 GB).
 */
export function parseWavHeader(view: DataView, fileSize: number): WavFormat {
  if (view.byteLength < 12 || fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null
  let data: { offset: number; declaredBytes: number } | null = null
  let offset = 12
  while (offset + 8 <= view.byteLength && (fmt === null || data === null)) {
    const id = fourcc(view, offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      if (offset + 24 > view.byteLength) throw new Error('truncated fmt chunk')
      const audioFormat = view.getUint16(offset + 8, true)
      if (audioFormat !== 1) throw new Error(`unsupported wav codec ${audioFormat} (want PCM)`)
      const bitsPerSample = view.getUint16(offset + 22, true)
      if (bitsPerSample !== 16) throw new Error(`unsupported wav depth ${bitsPerSample} (want 16)`)
      fmt = {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample
      }
    } else if (id === 'data') {
      data = { offset: offset + 8, declaredBytes: size }
    }
    // chunks are word-aligned: odd sizes carry one pad byte
    offset += 8 + size + (size % 2)
  }
  if (fmt === null) throw new Error(`no fmt chunk in the first ${view.byteLength} bytes`)
  if (data === null) throw new Error(`no data chunk in the first ${view.byteLength} bytes`)
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8)
  const available = fileSize - data.offset
  const declared = data.declaredBytes
  const usable =
    declared === 0 || declared === 0xffffffff || declared > available ? available : declared
  const dataBytes = Math.max(0, usable - (usable % blockAlign))
  return {
    ...fmt,
    dataOffset: data.offset,
    dataBytes,
    durationSec: dataBytes / blockAlign / fmt.sampleRate
  }
}

export interface ByteWindow {
  /** Inclusive byte range (Range-header style) within the file. */
  start: number
  end: number
  frames: number
}

/** Byte range covering [fromSec, fromSec + durSec), clamped to the data chunk. */
export function windowByteRange(
  format: WavFormat,
  fromSec: number,
  durSec: number
): ByteWindow | null {
  const blockAlign = format.channels * (format.bitsPerSample / 8)
  const totalFrames = Math.floor(format.dataBytes / blockAlign)
  const startFrame = Math.min(totalFrames, Math.max(0, Math.round(fromSec * format.sampleRate)))
  const frames = Math.min(
    totalFrames - startFrame,
    Math.max(0, Math.round(durSec * format.sampleRate))
  )
  if (frames <= 0) return null
  const start = format.dataOffset + startFrame * blockAlign
  return { start, end: start + frames * blockAlign - 1, frames }
}

/** De-interleave little-endian Int16 PCM into per-channel Float32 (x / 32768). */
export function int16ToFloat32Channels(
  pcm: DataView,
  channels: number
): Float32Array<ArrayBuffer>[] {
  const frames = Math.floor(pcm.byteLength / (channels * 2))
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  let offset = 0
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels; c++) {
      out[c][frame] = pcm.getInt16(offset, true) / 0x8000
      offset += 2
    }
  }
  return out
}

/** Total size from a 206's Content-Range (`bytes a-b/total`); body length otherwise. */
function totalSizeOf(res: Response, bodyBytes: number): number {
  const match = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '')
  return match === null ? bodyBytes : Number.parseInt(match[1], 10)
}

async function fetchWindow(
  url: string,
  format: WavFormat,
  ctx: BaseAudioContext,
  fromSec: number,
  durSec: number
): Promise<AudioBuffer | null> {
  const range = windowByteRange(format, fromSec, durSec)
  if (range === null) return null
  const res = await fetch(url, { headers: { Range: `bytes=${range.start}-${range.end}` } })
  if (!res.ok) throw new Error(`pcm window fetch failed (${res.status}) for ${url}`)
  const bytes = await res.arrayBuffer()
  const expected = range.end - range.start + 1
  if (bytes.byteLength !== expected) {
    throw new Error(`pcm window short read (${bytes.byteLength} of ${expected} bytes) for ${url}`)
  }
  const channelData = int16ToFloat32Channels(new DataView(bytes), format.channels)
  const buffer = ctx.createBuffer(format.channels, range.frames, format.sampleRate)
  for (let c = 0; c < format.channels; c++) buffer.copyToChannel(channelData[c], c)
  return buffer
}

const sources = new Map<string, Promise<PcmSource>>()

/** Parse (once per URL) the wav header via a small Range fetch. */
export function openPcm(url: string): Promise<PcmSource> {
  let pending = sources.get(url)
  if (pending === undefined) {
    pending = (async () => {
      const res = await fetch(url, { headers: { Range: `bytes=0-${HEADER_PROBE_BYTES - 1}` } })
      if (!res.ok) throw new Error(`pcm header fetch failed (${res.status}) for ${url}`)
      const head = await res.arrayBuffer()
      const format = parseWavHeader(new DataView(head), totalSizeOf(res, head.byteLength))
      return {
        ...format,
        windowBuffer: (ctx, fromSec, durSec) => fetchWindow(url, format, ctx, fromSec, durSec)
      }
    })()
    pending.catch(() => sources.delete(url))
    sources.set(url, pending)
  }
  return pending
}
