import { execFile } from 'child_process'
import { cpus, tmpdir } from 'os'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { MediaAsset, Transcript, TranscriptWord } from '../../shared/types'
import { writeJsonAtomic } from '../project-io/atomic'

const execFileAsync = promisify(execFile)

/**
 * Local Whisper transcription: ffmpeg → mono 16 kHz WAV → whisper.cpp with
 * one-word-per-segment timestamps (-ml 1 -sow -oj -ojf) → normalized
 * Transcript JSON in cache/transcripts/<assetId>.json. Binary paths are
 * injected so the accuracy harness can run this outside Electron.
 */

export interface TranscribeBinaries {
  ffmpeg: string
  whisper: string
  model: string
}

interface WhisperSegment {
  offsets: { from: number; to: number }
  text: string
  tokens?: { p?: number }[]
}

const MS_TO_FLICKS = 705_600_000 / 1000

/** Run whisper on any media file and return the normalized transcript. */
export async function transcribeFile(
  binaries: TranscribeBinaries,
  mediaPath: string
): Promise<Transcript> {
  const tempDir = mkdtempSync(join(tmpdir(), 'magnetic-whisper-'))
  try {
    const wavPath = join(tempDir, 'audio.wav')
    await execFileAsync(
      binaries.ffmpeg,
      ['-v', 'error', '-y', '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', wavPath],
      { windowsHide: true }
    )
    const outBase = join(tempDir, 'transcript')
    const threads = Math.max(2, cpus().length - 2)
    await execFileAsync(
      binaries.whisper,
      [
        '-m',
        binaries.model,
        '-f',
        wavPath,
        '-ml',
        '1',
        '-sow',
        '-oj',
        '-ojf',
        '-of',
        outBase,
        '-np',
        '-t',
        String(threads)
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
    const parsed = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as {
      transcription: WhisperSegment[]
    }
    const words: TranscriptWord[] = []
    for (const segment of parsed.transcription) {
      const text = segment.text.trim()
      if (text === '' || text.startsWith('[_')) continue
      const probabilities = (segment.tokens ?? [])
        .map((token) => token.p)
        .filter((p): p is number => typeof p === 'number')
      words.push({
        text,
        startFlicks: Math.round(segment.offsets.from * MS_TO_FLICKS),
        endFlicks: Math.round(segment.offsets.to * MS_TO_FLICKS),
        p:
          probabilities.length === 0
            ? 1
            : probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length
      })
    }
    return { words }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/** Library-cache wrapper used by the background job queue. */
export async function generateTranscript(
  binaries: TranscribeBinaries,
  libraryRoot: string,
  asset: MediaAsset
): Promise<string> {
  if (asset.audio === undefined) throw new Error('transcription requires an audio stream')
  const transcript = await transcribeFile(binaries, join(libraryRoot, asset.libraryRelPath))
  mkdirSync(join(libraryRoot, 'cache', 'transcripts'), { recursive: true })
  const relPath = join('cache', 'transcripts', `${asset.id}.json`)
  writeJsonAtomic(join(libraryRoot, relPath), transcript)
  return relPath
}
