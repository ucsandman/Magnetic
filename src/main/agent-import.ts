import { existsSync } from 'fs'
import { importPathsPayloadSchema } from '../shared/ipc'
import { isAllowedPath } from './agent-allowlist'
import type { ImportResult } from '../shared/types'

/**
 * import_media (Agent Access v2): validation + orchestration for the
 * sidecar's only main-routed tool. Dependency-injected so the validation
 * layer is unit-testable without a real LibraryStore/Electron app.
 */
export interface ImportMediaDeps {
  /** Live snapshot of the allowlisted agent media folders. */
  allowlist(): string[]
  /** The real import pipeline (src/main/app-state.ts importAndProcess) — reused, never reimplemented. */
  importAndProcess(paths: string[]): Promise<ImportResult>
  /** Look up an imported asset's display fileName by id. */
  fileNameOf(assetId: string): string | undefined
}

export interface ImportMediaAsset {
  assetId: string
  fileName: string
}

/**
 * Validate ALL paths before importing anything: one bad path (outside the
 * allowlist, or missing on disk) rejects the whole call, naming it — nothing
 * imports. Only then is importAndProcess called, exactly once.
 */
export async function handleImportMedia(
  input: unknown,
  deps: ImportMediaDeps
): Promise<{ assets: ImportMediaAsset[] }> {
  const parsed = importPathsPayloadSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`invalid import_media payload: ${parsed.error.message}`)
  }

  const allowlist = deps.allowlist()
  for (const path of parsed.data.paths) {
    if (!isAllowedPath(path, allowlist)) {
      throw new Error(`path is outside the allowlisted agent media folders: ${path}`)
    }
    if (!existsSync(path)) {
      throw new Error(`file does not exist: ${path}`)
    }
  }

  const result = await deps.importAndProcess(parsed.data.paths)
  const assets = result.importedIds.flatMap((assetId) => {
    const fileName = deps.fileNameOf(assetId)
    return fileName === undefined ? [] : [{ assetId, fileName }]
  })
  return { assets }
}
