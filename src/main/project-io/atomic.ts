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
  writeFileSync(tmpPath, serialized, 'utf8')
  renameSync(tmpPath, filePath)
}

/** Read + parse a JSON file written by writeJsonAtomic. Throws on missing/corrupt. */
export function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function basenameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx === -1 ? filePath : filePath.slice(idx + 1)
}
