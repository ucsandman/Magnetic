import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample } from 'mp4box'
import { FLICKS_PER_SECOND } from '../../../shared/timecode'

/**
 * WebCodecs decode path: mp4box.js demux -> VideoDecoder.
 *
 * Demux is STREAMING: only the moov (sample table) is parsed up front via
 * bounded Range reads — mp4box's appendBuffer returns the next offset it
 * wants, so a tail-moov file skips over mdat instead of reading it. Sample
 * bytes are then fetched on demand in bounded batches per decode window.
 * The old whole-file `fetch().arrayBuffer()` demux died on multi-GB files
 * (the renderer cannot allocate a 10 GB ArrayBuffer), which black-screened
 * the sequence viewer for any timeline using such a clip.
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
/** Range-read size while hunting for / parsing moov. */
const METADATA_CHUNK_BYTES = 4 * 1024 * 1024
/** Caps for one on-demand sample-data batch (covers interleaved a/v bytes). */
const BATCH_MAX_SAMPLES = 96
const BATCH_MAX_BYTES = 24 * 1024 * 1024

interface DemuxResult {
  samples: Sample[]
  config: DecoderConfigInfo
  description: Uint8Array | undefined
  timescale: number
}

async function fetchRange(url: string, start: number, endInclusive: number): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } })
  if (response.status === 416) return new ArrayBuffer(0) // past EOF
  if (!response.ok) throw new Error(`media range fetch failed: HTTP ${response.status}`)
  return response.arrayBuffer()
}

/** Parse moov via bounded range reads and return the sample TABLE (no data). */
async function demux(url: string): Promise<DemuxResult> {
  const file = createFile(false)
  let ready: Promise<DemuxResult> | null = null
  let resolveReady: (result: DemuxResult) => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  ready = new Promise<DemuxResult>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let done = false

  file.onError = (module: string, message: string) => {
    done = true
    rejectReady(new Error(`mp4box ${module}: ${message}`))
  }
  file.onReady = (info) => {
    done = true
    const video = info.videoTracks[0]
    if (video === undefined || video.video === undefined) {
      rejectReady(new Error('no video track in file'))
      return
    }
    const samples = file.getTrackSamplesInfo(video.id)
    if (samples.length === 0) {
      // Fragmented MP4s keep samples in moofs, not the moov sample table.
      // Imports are de-fragmented by the faststart remux; anything that
      // slipped past it (remux failure, relink) rides the proxy fallback
      // in sessions.ts — reject with a reason that says so.
      rejectReady(
        new Error(
          info.isFragmented === true
            ? 'fragmented MP4: no sample table in moov (proxy fallback will transcode it)'
            : 'no video samples in sample table'
        )
      )
      return
    }
    resolveReady({
      samples,
      config: {
        codec: video.codec,
        codedWidth: video.video.width,
        codedHeight: video.video.height
      },
      description: extractDescription(file, video.id),
      timescale: video.timescale
    })
  }

  void (async () => {
    try {
      let position = 0
      while (!done) {
        const buffer = await fetchRange(url, position, position + METADATA_CHUNK_BYTES - 1)
        if (buffer.byteLength === 0) {
          if (!done) rejectReady(new Error('mp4 demux: reached EOF before moov'))
          return
        }
        const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, position))
        const appendedEnd = position + buffer.byteLength
        // appendBuffer returns the next byte offset mp4box wants — a jump past
        // what we appended means "skip this box" (e.g. a multi-GB mdat).
        position = next > appendedEnd ? next : appendedEnd
        if (buffer.byteLength < METADATA_CHUNK_BYTES && next <= appendedEnd && !done) {
          rejectReady(new Error('mp4 demux: file ended before moov was found'))
          return
        }
      }
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  return ready
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

export interface BatchPlan {
  /** Exclusive end index of the samples covered by this batch. */
  endIndex: number
  spanStart: number
  /** Inclusive end byte. */
  spanEnd: number
}

/**
 * Plan one contiguous byte span covering table[fromIndex..endIndex). Bounded
 * by sample count and span bytes; stops early if file offsets go backwards
 * (always includes at least table[fromIndex]).
 */
export function planBatch(
  table: readonly Pick<Sample, 'offset' | 'size'>[],
  fromIndex: number,
  maxSamples = BATCH_MAX_SAMPLES,
  maxBytes = BATCH_MAX_BYTES
): BatchPlan {
  const first = table[fromIndex]
  const spanStart = first.offset
  let spanEnd = first.offset + first.size - 1
  let endIndex = fromIndex + 1
  while (endIndex < table.length && endIndex - fromIndex < maxSamples) {
    const sample = table[endIndex]
    if (sample.offset < spanStart || sample.offset + sample.size - 1 <= spanEnd) break
    const newEnd = sample.offset + sample.size - 1
    if (newEnd - spanStart + 1 > maxBytes) break
    spanEnd = newEnd
    endIndex += 1
  }
  return { endIndex, spanStart, spanEnd }
}

interface Batch {
  fromIndex: number
  /** Exclusive. */
  endIndex: number
  base: number
  bytes: Uint8Array
}

/**
 * On-demand sample bytes, shared by every decodeRange generator of a handle:
 * a small LRU of bounded batches (skim stills inside one GOP hit memory after
 * the first fetch) plus one in-flight prefetch of the NEXT batch, kicked off
 * when consumption crosses 75% of the current one, so realtime playback does
 * not stall at every batch boundary.
 */
const MAX_CACHED_BATCHES = 3
const PREFETCH_AT = 0.75

class SampleBytes {
  private cache: Batch[] = []
  private inflight = new Map<number, Promise<Batch>>()

  constructor(
    private readonly url: string,
    private readonly table: Sample[]
  ) {}

  async dataFor(index: number): Promise<Uint8Array> {
    const batch = await this.batchFor(index)
    const sample = this.table[index]
    return batch.bytes.subarray(
      sample.offset - batch.base,
      sample.offset - batch.base + sample.size
    )
  }

  private async batchFor(index: number): Promise<Batch> {
    const cached = this.cache.find((b) => index >= b.fromIndex && index < b.endIndex)
    if (cached !== undefined) {
      this.promote(cached)
      this.maybePrefetch(cached, index)
      return cached
    }
    const pending = this.inflight.get(index)
    const batch = await (pending ?? this.fetchBatch(index))
    // a prefetched batch may not cover `index` exactly (table edits never
    // happen, but stay defensive): fall back to a direct fetch
    if (index < batch.fromIndex || index >= batch.endIndex) {
      return this.fetchBatch(index).then((direct) => {
        this.install(direct)
        return direct
      })
    }
    this.install(batch)
    this.maybePrefetch(batch, index)
    return batch
  }

  private fetchBatch(fromIndex: number): Promise<Batch> {
    const plan = planBatch(this.table, fromIndex)
    const promise = (async (): Promise<Batch> => {
      const buffer = await fetchRange(this.url, plan.spanStart, plan.spanEnd)
      if (buffer.byteLength < plan.spanEnd - plan.spanStart + 1) {
        throw new Error('media range fetch returned fewer bytes than requested')
      }
      return {
        fromIndex,
        endIndex: plan.endIndex,
        base: plan.spanStart,
        bytes: new Uint8Array(buffer)
      }
    })()
    this.inflight.set(fromIndex, promise)
    void promise.finally(() => this.inflight.delete(fromIndex)).catch(() => undefined)
    return promise
  }

  private maybePrefetch(batch: Batch, index: number): void {
    if (batch.endIndex >= this.table.length) return
    const progress = (index - batch.fromIndex + 1) / (batch.endIndex - batch.fromIndex)
    if (progress < PREFETCH_AT) return
    if (this.inflight.has(batch.endIndex)) return
    if (this.cache.some((b) => batch.endIndex >= b.fromIndex && batch.endIndex < b.endIndex)) return
    void this.fetchBatch(batch.endIndex)
      .then((next) => this.install(next))
      .catch(() => undefined) // the on-demand path will surface the error
  }

  private install(batch: Batch): void {
    if (!this.cache.includes(batch)) this.cache.unshift(batch)
    if (this.cache.length > MAX_CACHED_BATCHES) this.cache.length = MAX_CACHED_BATCHES
  }

  private promote(batch: Batch): void {
    const at = this.cache.indexOf(batch)
    if (at > 0) {
      this.cache.splice(at, 1)
      this.cache.unshift(batch)
    }
  }
}

function sampleTimestampMicros(sample: Sample, timescale: number): number {
  return Math.round((sample.cts / timescale) * 1_000_000)
}

/**
 * First sample (in decode order) presenting at/after fromMicros — same result
 * as a linear findIndex over cts, but O(log n + reorder window): binary-search
 * dts (monotonic) starting at target minus the table's max cts-dts reorder
 * offset, then scan forward. Multi-hour tables make a linear scan cost
 * milliseconds per still.
 */
export function startIndexFor(
  samples: readonly Pick<Sample, 'cts' | 'dts'>[],
  timescale: number,
  fromMicros: number,
  maxReorderTs: number
): number {
  const targetTs = (fromMicros / 1_000_000) * timescale
  // every candidate (cts >= target) has dts >= cts - maxReorder >= floor
  const floor = targetTs - maxReorderTs
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (samples[mid].dts < floor) lo = mid + 1
    else hi = mid
  }
  for (let index = lo; index < samples.length; index += 1) {
    if (sampleTimestampMicros(samples[index] as Sample, timescale) >= fromMicros) return index
  }
  return samples.length - 1
}

export async function openSample(url: string): Promise<DecoderHandle> {
  const { samples, config, description, timescale } = await demux(url)
  if (samples.length === 0) throw new Error('no video samples demuxed')
  const stats: DecoderStats = { maxQueued: 0 }
  // Shared across generators: batch LRU + prefetch live at handle level so
  // repeated stills in one GOP reuse fetched bytes.
  const loader = new SampleBytes(url, samples)
  let maxReorderTs = 0
  for (const sample of samples) {
    if (sample.cts - sample.dts > maxReorderTs) maxReorderTs = sample.cts - sample.dts
  }

  async function* decodeRange(fromFlicks: number, frameCount: number): AsyncGenerator<VideoFrame> {
    const fromMicros = (fromFlicks / FLICKS_PER_SECOND) * 1_000_000

    // First sample at/after the requested time, backed up to its keyframe.
    let startIndex = startIndexFor(samples, timescale, fromMicros, maxReorderTs)
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
    let gateStalls = 0
    try {
      while (produced < frameCount) {
        if (decodeError !== null) throw decodeError
        if (buffered.length === 0) {
          if (feedIndex < samples.length) {
            // Backpressure: keep at most MAX_BUFFERED_FRAMES in flight. If the
            // decoder withholds outputs until it sees MORE input (B-frame
            // reordering), the gate would deadlock — break the stall by
            // force-feeding one chunk after ~50 idle ticks.
            if (
              decoder.decodeQueueSize + buffered.length < MAX_BUFFERED_FRAMES ||
              gateStalls > 50
            ) {
              gateStalls = 0
              const sample = samples[feedIndex]
              const data = await loader.dataFor(feedIndex)
              feedIndex += 1
              decoder.decode(
                new EncodedVideoChunk({
                  type: sample.is_sync ? 'key' : 'delta',
                  timestamp: sampleTimestampMicros(sample, timescale),
                  data: data as BufferSource
                })
              )
            } else {
              gateStalls += 1
              await new Promise((resolveSleep) => setTimeout(resolveSleep, 0))
            }
            continue
          }
          if (!flushed) {
            flushed = true
            // VideoDecoder.flush() can intermittently never settle at end of
            // stream (observed on D3D11 h264). Race it: any frames it does
            // deliver land in `buffered` via the output callback either way,
            // and the unreachable trailing frames sit past the media window.
            await Promise.race([
              decoder.flush().catch(() => undefined),
              new Promise((resolveSleep) => setTimeout(resolveSleep, 2000))
            ])
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
