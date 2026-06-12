import type { Sequence } from '../../shared/timeline/model'
import type { LibrarySnapshot, Transcript } from '../../shared/types'

/**
 * Shared transcript cache (by assetId), used by the TranscriptPanel and the
 * playback engine (burned-in captions). Transcript JSON is immutable per
 * asset, so entries never invalidate; in-flight fetches are deduplicated.
 */

const byAsset = new Map<string, Transcript>()
const inFlight = new Map<string, Promise<void>>()
const failed = new Map<string, string>()
let version = 0

/** assetId -> error for transcripts that failed to fetch/parse (retried next ensure). */
export function transcriptFailures(): ReadonlyMap<string, string> {
  return failed
}

/** Bumped whenever a new transcript lands — cheap cache key for derived data. */
export function transcriptCacheVersion(): number {
  return version
}

function referencedAssetIds(sequence: Sequence): Set<string> {
  const wanted = new Set<string>()
  for (const item of sequence.spine) if (item.kind === 'clip') wanted.add(item.assetId)
  for (const cc of sequence.connected) if (cc.titleData === undefined) wanted.add(cc.assetId)
  return wanted
}

/**
 * Fetch (once) every available transcript the sequence references and return
 * an assetId → Transcript map. Assets without a transcriptUrl yet are simply
 * absent — callers re-run when the library snapshot changes.
 */
export async function ensureTranscripts(
  sequence: Sequence,
  snapshot: LibrarySnapshot
): Promise<Map<string, Transcript>> {
  const wanted = referencedAssetIds(sequence)
  const pending: Promise<void>[] = []
  for (const assetId of wanted) {
    if (byAsset.has(assetId)) continue
    const url = snapshot.assets[assetId]?.transcriptUrl
    if (url === undefined) continue
    let fetchPromise = inFlight.get(assetId)
    if (fetchPromise === undefined) {
      fetchPromise = fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`transcript fetch: HTTP ${response.status}`)
          return response.json()
        })
        .then((data: Transcript) => {
          byAsset.set(assetId, data)
          failed.delete(assetId)
          version += 1
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          failed.set(assetId, message)
          console.error(`transcript unavailable for asset ${assetId}: ${message}`)
        })
        .finally(() => {
          inFlight.delete(assetId)
        })
      inFlight.set(assetId, fetchPromise)
    }
    pending.push(fetchPromise)
  }
  await Promise.all(pending)
  const result = new Map<string, Transcript>()
  for (const assetId of wanted) {
    const transcript = byAsset.get(assetId)
    if (transcript !== undefined) result.set(assetId, transcript)
  }
  return result
}
