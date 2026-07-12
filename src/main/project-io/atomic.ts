import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Crash-safe JSON persistence: serialize first (a throwing serializer never
 * touches disk), write to a `.tmp-` sibling, then rename over the target.
 * Node's rename uses MoveFileEx(REPLACE_EXISTING) on Windows, so a crash at
 * any point leaves either the previous valid file or the new valid file —
 * never a partial one.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2)
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = join(dirname(filePath), `.tmp-${process.pid}-${basenameOf(filePath)}`)
  // owner-only: settings.json carries credentials (API key, agent token) and
  // everything else here is per-user app data; mode is a no-op on Windows,
  // where %APPDATA% ACLs already scope these files to the user
  writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 })
  renameWithRetry(tmpPath, filePath)
}

const RENAME_ATTEMPTS = 6

/**
 * On Windows, Defender / Search Indexer briefly open freshly written files,
 * which makes the rename fail with EBUSY or EPERM. Retry with backoff
 * (~50–300 ms per step) before giving up — anything else means a real error.
 * rename/sleep are injectable for tests (fs module namespaces can't be spied).
 */
export function renameWithRetry(
  fromPath: string,
  toPath: string,
  rename: (from: string, to: string) => void = renameSync,
  sleep: (ms: number) => void = sleepSync
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(fromPath, toPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= RENAME_ATTEMPTS) throw error
      sleep(50 * attempt)
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Read + parse a JSON file written by writeJsonAtomic. Throws on missing/corrupt. */
export function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function basenameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx === -1 ? filePath : filePath.slice(idx + 1)
}
