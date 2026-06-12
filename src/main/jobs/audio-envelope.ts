import { mkdirSync } from 'fs'
import { join } from 'path'
import type { AudioEnvelope, EnvelopeInfo, MediaAsset } from '../../shared/types'
import { writeJsonAtomic } from '../project-io/atomic'
import { decodePcm, SAMPLE_RATE } from './waveform'

const WINDOW_MS = 50
const SAMPLES_PER_WINDOW = (SAMPLE_RATE * WINDOW_MS) / 1000 // 400 samples at 8 kHz
/** dBFS reported for digital silence (log of zero is -Infinity). */
const SILENCE_FLOOR_DB = -100

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

  const pcm = await decodePcm(join(libraryRoot, asset.libraryRelPath))
  const sampleCount = Math.floor(pcm.length / 2)
  const windowCount = Math.ceil(sampleCount / SAMPLES_PER_WINDOW)
  const rmsDb: number[] = []
  for (let window = 0; window < windowCount; window += 1) {
    const start = window * SAMPLES_PER_WINDOW
    const end = Math.min(sampleCount, start + SAMPLES_PER_WINDOW)
    let sumSquares = 0
    for (let i = start; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768
      sumSquares += value * value
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start))
    const db = rms <= 0 ? SILENCE_FLOOR_DB : Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms))
    rmsDb.push(Math.round(db * 10) / 10)
  }

  const outDir = join(libraryRoot, 'cache', 'envelope')
  mkdirSync(outDir, { recursive: true })
  const envelopePath = join('cache', 'envelope', `${asset.id}.json`)
  const envelope: AudioEnvelope = { windowMs: WINDOW_MS, rmsDb }
  writeJsonAtomic(join(libraryRoot, envelopePath), envelope)
  return { envelopePath }
}
