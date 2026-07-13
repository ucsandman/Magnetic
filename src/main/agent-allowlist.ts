import { realpathSync } from 'fs'
import { resolve, sep } from 'path'
import { getAgentMediaFolders } from './project-io/library'

export { getAgentMediaFolders }

/**
 * Pure allowlist check for Agent Access media reads (Agent Access v2). Empty
 * allowlist = reject everything; a directory only grants access once the
 * user opts in via Settings (see getAgentMediaFolders / the Sidebar's
 * Agent Access folder list). Both sides are canonicalized with realpath so a
 * symlink that lives inside an allowed folder but points outside it cannot
 * be used to escape the allowlist, and lexical `..` traversal is collapsed
 * the same way. Comparison is case-insensitive on win32 to match the OS's
 * case-insensitive (case-preserving) filesystem.
 */
export function isAllowedPath(candidate: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false
  const real = canonicalize(candidate)
  return allowlist.some((dir) => isInside(real, canonicalize(dir)))
}

/** realpath resolves symlinks and `..`; fall back to lexical resolve() for
 * paths that don't exist on disk yet (still collapses traversal). */
function canonicalize(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

function isInside(real: string, realDir: string): boolean {
  const a = process.platform === 'win32' ? real.toLowerCase() : real
  const b = process.platform === 'win32' ? realDir.toLowerCase() : realDir
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}
