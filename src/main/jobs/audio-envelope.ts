import { mkdirSync } from 'fs'
import { join } from 'path'
import type { AudioEnvelope, EnvelopeInfo, MediaAsset } from '../../shared/types'
import { writeJsonAtomic } from '../project-io/atomic'
import { streamPcm, SAMPLE_RATE } from './waveform'

const WINDOW_MS = 50
const SAMPLES_PER_WINDOW = (SAMPLE_RATE * WINDOW_MS) / 1000 // 400 samples at 8 kHz
/** dBFS reported for digital silence (log of zero is -Infinity). */
const SILENCE_FLOOR_DB = -100

/**
 * Incremental RMS over fixed 50 ms windows. PCM chunks stream straight
 * through (a 4-hour recording is ~244 MB of PCM — never buffered); chunk
 * boundaries may split a 16-bit sample, so one carry byte bridges chunks.
 */
export class RmsWindowAccumulator {
  private carryByte: number | null = null
  private sumSquares = 0
  private samplesInWindow = 0
  private readonly rmsDb: number[] = []

  push(chunk: Buffer): void {
    let buffer = chunk
    if (this.carryByte !== null) {
      buffer = Buffer.concat([Buffer.from([this.carryByte]), chunk])
      this.carryByte = null
    }
    const usable = buffer.length - (buffer.length % 2)
    for (let i = 0; i < usable; i += 2) {
      const value = buffer.readInt16LE(i) / 32768
      this.sumSquares += value * value
      this.samplesInWindow += 1
      if (this.samplesInWindow === SAMPLES_PER_WINDOW) this.flushWindow()
    }
    if (usable < buffer.length) this.carryByte = buffer[buffer.length - 1]
  }

  /** Flush any partial trailing window and return the per-window dBFS values. */
  finish(): number[] {
    if (this.samplesInWindow > 0) this.flushWindow()
    return this.rmsDb
  }

  private flushWindow(): void {
    const rms = Math.sqrt(this.sumSquares / Math.max(1, this.samplesInWindow))
    const db = rms <= 0 ? SILENCE_FLOOR_DB : Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms))
    this.rmsDb.push(Math.round(db * 10) / 10)
    this.sumSquares = 0
    this.samplesInWindow = 0
  }
}

/**
 * Decode audio to mono 16-bit PCM (same ffmpeg path as generateWaveform) and
 * compute RMS loudness in fixed 50 ms windows, stored as JSON in
 * cache/envelope/<assetId>.json. One decode up front means the renderer can
 * re-threshold silence detection instantly without re-running ffmpeg.
 */
export async function generateAudioEnvelope(
  libraryRoot: string,
  asset: MediaAsset
): Promise<EnvelopeInfo> {
  if (asset.audio === undefined) throw new Error('envelope requires an audio stream')

  const accumulator = new RmsWindowAccumulator()
  await streamPcm(join(libraryRoot, asset.libraryRelPath), (chunk) => accumulator.push(chunk))
  const rmsDb = accumulator.finish()

  const outDir = join(libraryRoot, 'cache', 'envelope')
  mkdirSync(outDir, { recursive: true })
  const envelopePath = join('cache', 'envelope', `${asset.id}.json`)
  const envelope: AudioEnvelope = { windowMs: WINDOW_MS, rmsDb }
  writeJsonAtomic(join(libraryRoot, envelopePath), envelope)
  return { envelopePath }
}
