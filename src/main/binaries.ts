import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Native binaries live in resources/bin (fetched by scripts/fetch-binaries.mjs,
 * gitignored). In a packaged app they are shipped as extraResources under
 * process.resourcesPath/bin. Unpackaged, resolve relative to the built main
 * bundle (out/main/) — stable no matter how Electron was launched.
 */
export function getBinDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(__dirname, '..', '..', 'resources', 'bin')
}

export function ffmpegPath(): string {
  return join(getBinDir(), 'ffmpeg.exe')
}

export function ffprobePath(): string {
  return join(getBinDir(), 'ffprobe.exe')
}

/** whisper.cpp CLI; release zips have shipped it as whisper-cli.exe (older: main.exe). */
export function whisperPath(): string {
  const cli = join(getBinDir(), 'whisper-cli.exe')
  if (existsSync(cli)) return cli
  return join(getBinDir(), 'main.exe')
}

export function whisperModelPath(): string {
  return join(getBinDir(), 'ggml-base.en.bin')
}
