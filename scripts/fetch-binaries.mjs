/**
 * fetch-binaries.mjs — download + sha256-verify the native binaries Magnetic
 * needs into resources/bin/ (gitignored).
 *
 *   - ffmpeg.exe / ffprobe.exe   (gyan.dev release-essentials, pinned 8.1.1)
 *   - whisper-cli.exe (+ DLLs)   (whisper.cpp v1.8.6 win-x64 prebuilt)
 *   - ggml-base.en.bin           (whisper base.en model, Hugging Face)
 *
 * Idempotent: a second run verifies hashes and skips everything that is
 * already present and verified. Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
  process.exit(1)
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = join(ROOT, 'resources', 'bin')
const CACHE_DIR = join(BIN_DIR, '.cache')

const FFMPEG = {
  name: 'ffmpeg 8.1.1 essentials',
  url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.1-essentials_build.zip',
  sha256: '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541',
  archive: 'ffmpeg-8.1.1-essentials_build.zip',
  outputs: ['ffmpeg.exe', 'ffprobe.exe']
}

const WHISPER = {
  name: 'whisper.cpp v1.8.6 win-x64',
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip',
  sha256: 'b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822',
  archive: 'whisper-bin-x64.zip',
  // Release zips have shipped the CLI as whisper-cli.exe (older releases: main.exe).
  outputsAnyOf: ['whisper-cli.exe', 'main.exe']
}

const MODEL = {
  name: 'whisper ggml-base.en model',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  file: 'ggml-base.en.bin'
}

async function sha256OfFile(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function download(url, destination) {
  console.log(`  downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`)
  }
  const partial = `${destination}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  renameSync(partial, destination)
  const size = statSync(destination).size
  console.log(`  downloaded ${(size / 1024 / 1024).toFixed(1)} MB`)
}

/** Download url into the cache (skipping if already cached + verified) and verify sha256. */
async function fetchVerified(url, archiveName, expectedSha256) {
  const cached = join(CACHE_DIR, archiveName)
  if (existsSync(cached)) {
    const actual = await sha256OfFile(cached)
    if (actual === expectedSha256) {
      console.log(`  cache hit: ${archiveName} (sha256 verified)`)
      return cached
    }
    console.log(`  cache entry corrupt (sha256 mismatch) — re-downloading`)
    rmSync(cached)
  }
  await download(url, cached)
  const actual = await sha256OfFile(cached)
  if (actual !== expectedSha256) {
    rmSync(cached)
    throw new Error(
      `sha256 mismatch for ${archiveName}\n  expected ${expectedSha256}\n  actual   ${actual}`
    )
  }
  console.log(`  sha256 verified: ${actual}`)
  return cached
}

function extractZip(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  // Windows 10+ ships bsdtar (System32\tar.exe), which extracts zip archives.
  // Absolute path: a GNU tar earlier in PATH (e.g. Git's) cannot read zips.
  const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(bsdtar, ['-xf', zipPath, '-C', targetDir], { stdio: 'inherit' })
}

/** Recursively collect files under dir matching the predicate. */
function walk(dir, predicate, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) walk(fullPath, predicate, found)
    else if (predicate(entry.name)) found.push(fullPath)
  }
  return found
}

async function installFfmpeg() {
  console.log(`[1/3] ${FFMPEG.name}`)
  const satisfied = FFMPEG.outputs.every((file) => existsSync(join(BIN_DIR, file)))
  if (satisfied && existsSync(join(CACHE_DIR, FFMPEG.archive))) {
    const cachedHash = await sha256OfFile(join(CACHE_DIR, FFMPEG.archive))
    if (cachedHash === FFMPEG.sha256) {
      console.log('  skip — ffmpeg.exe + ffprobe.exe already present, archive sha256 verified')
      return
    }
  }
  const zip = await fetchVerified(FFMPEG.url, FFMPEG.archive, FFMPEG.sha256)
  const tmp = join(CACHE_DIR, 'ffmpeg-extract')
  rmSync(tmp, { recursive: true, force: true })
  extractZip(zip, tmp)
  for (const output of FFMPEG.outputs) {
    const [source] = walk(tmp, (name) => name.toLowerCase() === output)
    if (source === undefined) throw new Error(`${output} not found inside ${FFMPEG.archive}`)
    copyFileSync(source, join(BIN_DIR, output))
    console.log(`  installed ${output}`)
  }
  rmSync(tmp, { recursive: true, force: true })
}

async function installWhisper() {
  console.log(`[2/3] ${WHISPER.name}`)
  const exePresent = WHISPER.outputsAnyOf.some((file) => existsSync(join(BIN_DIR, file)))
  if (exePresent && existsSync(join(CACHE_DIR, WHISPER.archive))) {
    const cachedHash = await sha256OfFile(join(CACHE_DIR, WHISPER.archive))
    if (cachedHash === WHISPER.sha256) {
      console.log('  skip — whisper CLI already present, archive sha256 verified')
      return
    }
  }
  const zip = await fetchVerified(WHISPER.url, WHISPER.archive, WHISPER.sha256)
  const tmp = join(CACHE_DIR, 'whisper-extract')
  rmSync(tmp, { recursive: true, force: true })
  extractZip(zip, tmp)
  // Flatten every exe + dll next to each other so the CLI finds its DLLs.
  const binaries = walk(tmp, (name) => /\.(exe|dll)$/i.test(name))
  if (binaries.length === 0) throw new Error(`no exe/dll found inside ${WHISPER.archive}`)
  for (const source of binaries) {
    const fileName = source.split(/[\\/]/).pop()
    copyFileSync(source, join(BIN_DIR, fileName))
    console.log(`  installed ${fileName}`)
  }
  if (!WHISPER.outputsAnyOf.some((file) => existsSync(join(BIN_DIR, file)))) {
    throw new Error(`whisper CLI (${WHISPER.outputsAnyOf.join(' or ')}) missing after extraction`)
  }
  rmSync(tmp, { recursive: true, force: true })
}

async function installModel() {
  console.log(`[3/3] ${MODEL.name}`)
  const target = join(BIN_DIR, MODEL.file)
  if (existsSync(target)) {
    const actual = await sha256OfFile(target)
    if (actual === MODEL.sha256) {
      console.log(`  skip — ${MODEL.file} already present, sha256 verified`)
      return
    }
    console.log('  existing model failed sha256 check — re-downloading')
    rmSync(target)
  }
  const cached = await fetchVerified(MODEL.url, MODEL.file, MODEL.sha256)
  copyFileSync(cached, target)
  console.log(`  installed ${MODEL.file}`)
}

mkdirSync(CACHE_DIR, { recursive: true })
try {
  await installFfmpeg()
  await installWhisper()
  await installModel()
  console.log('All binaries present and sha256-verified.')
} catch (error) {
  console.error('fetch-binaries FAILED:', error.message ?? error)
  process.exit(1)
}
