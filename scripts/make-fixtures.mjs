/**
 * make-fixtures.mjs — generate deterministic test media into fixtures/ (gitignored).
 *
 *   bars-1080p30.mp4  10 s testsrc2 1080p30 + 440 Hz sine (h264/aac)
 *   red-720p25.mp4     8 s solid red 720p25 (video only)
 *   green-prores.mov   4 s solid green ProRes — WebCodecs-unsupported (proxy fallback test)
 *   tone.wav           5 s 440 Hz sine (audio only)
 *   speech.wav         Windows SAPI TTS reading fixtures-script.txt
 *
 * Requires resources/bin (run `npm run fetch-binaries` first).
 * Every fixture is ffprobe-verified and its duration printed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
  process.exit(1)
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = join(ROOT, 'resources', 'bin')
const FIXTURES_DIR = join(ROOT, 'fixtures')
const FFMPEG = join(BIN_DIR, 'ffmpeg.exe')
const FFPROBE = join(BIN_DIR, 'ffprobe.exe')
const SCRIPT_TXT = join(ROOT, 'fixtures-script.txt')

if (!existsSync(FFMPEG) || !existsSync(FFPROBE)) {
  console.error('ffmpeg/ffprobe not found in resources/bin — run `npm run fetch-binaries` first.')
  process.exit(1)
}

mkdirSync(FIXTURES_DIR, { recursive: true })

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' })
}

function probeDuration(filePath) {
  const out = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath
    ],
    { encoding: 'utf8' }
  )
  return Number.parseFloat(out.trim())
}

try {
  console.log('[1/4] bars-1080p30.mp4 — 10 s testsrc2 1080p30 + sine, h264/aac')
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '10',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    join(FIXTURES_DIR, 'bars-1080p30.mp4')
  ])

  console.log('[2/4] red-720p25.mp4 — 8 s solid red 720p25, video only')
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=1280x720:rate=25',
    '-t',
    '8',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    join(FIXTURES_DIR, 'red-720p25.mp4')
  ])

  console.log('[3/5] green-prores.mov — 4 s solid green ProRes (WebCodecs-unsupported)')
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=green:size=640x360:rate=30',
    '-t',
    '4',
    '-c:v',
    'prores_ks',
    '-profile:v',
    '2',
    '-pix_fmt',
    'yuv422p10le',
    join(FIXTURES_DIR, 'green-prores.mov')
  ])

  console.log('[4/5] tone.wav — 5 s 440 Hz sine, audio only')
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '5',
    join(FIXTURES_DIR, 'tone.wav')
  ])

  console.log('[5/5] speech.wav — Windows SAPI TTS reading fixtures-script.txt')
  const speechPath = join(FIXTURES_DIR, 'speech.wav')
  const scriptText = readFileSync(SCRIPT_TXT, 'utf8').replace(/\s+/g, ' ').trim()
  const psCommand = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.SetOutputToWaveFile('${speechPath.replace(/'/g, "''")}');`,
    `$s.Speak('${scriptText.replace(/'/g, "''")}');`,
    '$s.Dispose()'
  ].join(' ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
    stdio: 'inherit'
  })

  console.log('\nffprobe verification:')
  const fixtures = [
    'bars-1080p30.mp4',
    'red-720p25.mp4',
    'green-prores.mov',
    'tone.wav',
    'speech.wav'
  ]
  let allOk = true
  for (const name of fixtures) {
    const filePath = join(FIXTURES_DIR, name)
    if (!existsSync(filePath)) {
      console.error(`  ${name}: MISSING`)
      allOk = false
      continue
    }
    const duration = probeDuration(filePath)
    const ok = Number.isFinite(duration) && duration > 0
    if (!ok) allOk = false
    console.log(`  ${name}: ${duration.toFixed(3)} s ${ok ? 'OK' : 'INVALID'}`)
  }
  if (!allOk) {
    console.error('fixture verification FAILED')
    process.exit(1)
  }
  console.log(`All ${fixtures.length} fixtures generated and ffprobe-verified.`)
} catch (error) {
  console.error('make-fixtures FAILED:', error.message ?? error)
  process.exit(1)
}
