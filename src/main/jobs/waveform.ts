import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { MediaAsset, WaveformInfo } from '../../shared/types'
import { writeJsonAtomic } from '../project-io/atomic'
import { ffmpegPath } from '../binaries'

export const SAMPLE_RATE = 8000
const BUCKET_COUNT = 1000

/**
 * Decode audio to mono 16-bit PCM and reduce to ~1000 [min,max] peak pairs
 * (normalized -1..1), stored as JSON in cache/peaks/<assetId>.json.
 */
export async function generateWaveform(
  libraryRoot: string,
  asset: MediaAsset
): Promise<WaveformInfo> {
  if (asset.audio === undefined) throw new Error('waveform requires an audio stream')

  const pcm = await decodePcm(join(libraryRoot, asset.libraryRelPath))
  const sampleCount = Math.floor(pcm.length / 2)
  const buckets: [number, number][] = []
  const bucketCount = Math.min(BUCKET_COUNT, Math.max(1, sampleCount))
  const samplesPerBucket = sampleCount / bucketCount

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * samplesPerBucket)
    const end = Math.min(
      sampleCount,
      Math.max(start + 1, Math.floor((bucket + 1) * samplesPerBucket))
    )
    let min = 1
    let max = -1
    for (let i = start; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768
      if (value < min) min = value
      if (value > max) max = value
    }
    buckets.push([Math.round(min * 1000) / 1000, Math.round(max * 1000) / 1000])
  }

  const outDir = join(libraryRoot, 'cache', 'peaks')
  mkdirSync(outDir, { recursive: true })
  const peaksRelPath = join('cache', 'peaks', `${asset.id}.json`)
  writeJsonAtomic(join(libraryRoot, peaksRelPath), { sampleRate: SAMPLE_RATE, buckets })
  return { peaksPath: peaksRelPath }
}

/**
 * Stream the first audio stream as mono 16-bit PCM at 8 kHz. Chunks go to the
 * caller as they decode — multi-hour files never accumulate in memory (the
 * audio-envelope job uses this; ~244 MB of PCM for a 4-hour recording).
 */
export function streamPcm(filePath: string, onData: (chunk: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath(),
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-map',
        'a:0',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-f',
        's16le',
        'pipe:1'
      ],
      { windowsHide: true }
    )
    let stderr = ''
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg pcm decode failed (${code}): ${stderr.split(/\r?\n/)[0]}`))
    })
  })
}

/** Decode the whole PCM stream into one buffer (waveform peaks need the total length). */
export async function decodePcm(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  await streamPcm(filePath, (chunk) => chunks.push(chunk))
  return Buffer.concat(chunks)
}
