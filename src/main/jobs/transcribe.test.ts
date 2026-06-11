import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { transcribeFile } from './transcribe'

const ROOT = join(__dirname, '..', '..', '..')
const BIN = join(ROOT, 'resources', 'bin')
const FIXTURE = join(ROOT, 'fixtures', 'speech.wav')
const SCRIPT = join(ROOT, 'fixtures-script.txt')

const available =
  existsSync(join(BIN, 'whisper-cli.exe')) &&
  existsSync(join(BIN, 'ggml-base.en.bin')) &&
  existsSync(FIXTURE)

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
}

/** Word error rate via Levenshtein distance on word arrays. */
function wer(reference: string[], hypothesis: string[]): number {
  const rows = reference.length + 1
  const cols = hypothesis.length + 1
  const d = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j < cols; j++) d[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitution = d[i - 1][j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, substitution)
    }
  }
  return d[rows - 1][cols - 1] / reference.length
}

describe.skipIf(!available)('whisper transcription accuracy (integration)', () => {
  it('transcribes the TTS fixture at ≥70% word accuracy with sane timestamps', async () => {
    const transcript = await transcribeFile(
      {
        ffmpeg: join(BIN, 'ffmpeg.exe'),
        whisper: join(BIN, 'whisper-cli.exe'),
        model: join(BIN, 'ggml-base.en.bin')
      },
      FIXTURE
    )
    expect(transcript.words.length).toBeGreaterThan(40)
    // timestamps are monotonic, non-negative, and word-shaped
    for (let i = 0; i < transcript.words.length; i++) {
      const word = transcript.words[i]
      expect(word.startFlicks).toBeGreaterThanOrEqual(0)
      expect(word.endFlicks).toBeGreaterThanOrEqual(word.startFlicks)
      if (i > 0) {
        expect(word.startFlicks).toBeGreaterThanOrEqual(transcript.words[i - 1].startFlicks)
      }
    }
    const reference = normalizeWords(readFileSync(SCRIPT, 'utf8'))
    const hypothesis = normalizeWords(transcript.words.map((word) => word.text).join(' '))
    const accuracy = 1 - wer(reference, hypothesis)
    console.log(
      `whisper accuracy: ${(accuracy * 100).toFixed(1)}% (${hypothesis.length} words vs ${reference.length} reference)`
    )
    expect(accuracy).toBeGreaterThanOrEqual(0.7)
  }, 240_000)
})
