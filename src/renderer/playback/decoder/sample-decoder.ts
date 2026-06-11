import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample } from 'mp4box'
import { FLICKS_PER_SECOND } from '../../../shared/timecode'

/**
 * WebCodecs decode path: mp4box.js demux -> VideoDecoder. This is the phase-3
 * spike that phase 7's sequence playback engine builds on.
 */
export interface DecoderConfigInfo {
  codec: string
  codedWidth: number
  codedHeight: number
}

export interface DecoderStats {
  /** Peak number of decoded frames buffered at once (backpressure proof). */
  maxQueued: number
}

export interface DecoderHandle {
  config: DecoderConfigInfo
  stats: DecoderStats
  decodeRange(fromFlicks: number, frameCount: number): AsyncGenerator<VideoFrame>
  close(): void
}

const MAX_BUFFERED_FRAMES = 8

interface DemuxResult {
  samples: Sample[]
  config: DecoderConfigInfo
  description: Uint8Array | undefined
  timescale: number
}

async function demux(url: string): Promise<DemuxResult> {
  const buffer = await (await fetch(url)).arrayBuffer()
  return new Promise<DemuxResult>((resolve, reject) => {
    const file = createFile(true)
    const collected: Sample[] = []
    let config: DecoderConfigInfo | null = null
    let description: Uint8Array | undefined
    let timescale = 0

    file.onError = (module: string, message: string) =>
      reject(new Error(`mp4box ${module}: ${message}`))
    file.onReady = (info) => {
      const video = info.videoTracks[0]
      if (video === undefined || video.video === undefined) {
        reject(new Error('no video track in file'))
        return
      }
      config = {
        codec: video.codec,
        codedWidth: video.video.width,
        codedHeight: video.video.height
      }
      timescale = video.timescale
      description = extractDescription(file, video.id)
      file.setExtractionOptions(video.id, null, { nbSamples: 1_000_000 })
      file.start()
    }
    file.onSamples = (_id, _user, samples) => {
      collected.push(...samples)
    }
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0))
    file.flush()
    // Fully-buffered file: extraction callbacks have run synchronously by now.
    queueMicrotask(() => {
      if (config === null) reject(new Error('mp4 demux produced no video config'))
      else resolve({ samples: collected, config, description, timescale })
    })
  })
}

/** Serialize the codec config box (avcC/hvcC/...) minus its 8-byte header. */
function extractDescription(
  file: ReturnType<typeof createFile>,
  trackId: number
): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as unknown as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: unknown[] } } } }
  }
  const entries = (trak.mdia?.minf?.stbl?.stsd?.entries ?? []) as Array<
    Record<string, { write(stream: DataStream): void } | undefined>
  >
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (box !== undefined) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer as ArrayBuffer, 8)
    }
  }
  return undefined
}

function sampleTimestampMicros(sample: Sample, timescale: number): number {
  return Math.round((sample.cts / timescale) * 1_000_000)
}

export async function openSample(url: string): Promise<DecoderHandle> {
  const { samples, config, description, timescale } = await demux(url)
  if (samples.length === 0) throw new Error('no video samples demuxed')
  const stats: DecoderStats = { maxQueued: 0 }

  async function* decodeRange(fromFlicks: number, frameCount: number): AsyncGenerator<VideoFrame> {
    const fromMicros = (fromFlicks / FLICKS_PER_SECOND) * 1_000_000

    // First sample at/after the requested time, backed up to its keyframe.
    let startIndex = samples.findIndex(
      (sample) => sampleTimestampMicros(sample, timescale) >= fromMicros
    )
    if (startIndex === -1) startIndex = samples.length - 1
    while (startIndex > 0 && !samples[startIndex].is_sync) startIndex -= 1

    const buffered: VideoFrame[] = []
    let decodeError: Error | null = null
    const decoder = new VideoDecoder({
      output: (frame) => {
        buffered.push(frame)
        stats.maxQueued = Math.max(stats.maxQueued, buffered.length)
      },
      error: (error) => {
        decodeError = error instanceof Error ? error : new Error(String(error))
      }
    })
    decoder.configure({
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      ...(description === undefined ? {} : { description })
    })

    let feedIndex = startIndex
    let flushed = false
    let produced = 0
    try {
      while (produced < frameCount) {
        if (decodeError !== null) throw decodeError
        if (buffered.length === 0) {
          if (feedIndex < samples.length) {
            // Backpressure: keep at most MAX_BUFFERED_FRAMES in flight.
            if (decoder.decodeQueueSize + buffered.length < MAX_BUFFERED_FRAMES) {
              const sample = samples[feedIndex]
              feedIndex += 1
              decoder.decode(
                new EncodedVideoChunk({
                  type: sample.is_sync ? 'key' : 'delta',
                  timestamp: sampleTimestampMicros(sample, timescale),
                  data: sample.data as BufferSource
                })
              )
            } else {
              await new Promise((resolveSleep) => setTimeout(resolveSleep, 0))
            }
            continue
          }
          if (!flushed) {
            flushed = true
            await decoder.flush()
            continue
          }
          break // out of samples and fully flushed
        }
        const frame = buffered.shift()!
        if (frame.timestamp >= fromMicros - 1) {
          produced += 1
          yield frame
        } else {
          frame.close() // pre-roll frame from the keyframe backup
        }
      }
    } finally {
      for (const frame of buffered) frame.close()
      buffered.length = 0
      if (decoder.state !== 'closed') decoder.close()
    }
  }

  return {
    config,
    stats,
    decodeRange,
    close: () => {
      samples.length = 0
    }
  }
}
