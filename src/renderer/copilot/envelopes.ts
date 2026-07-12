import type { Sequence } from '../../shared/timeline/model'
import type { AudioEnvelope, LibrarySnapshot } from '../../shared/types'

/**
 * Plain (non-hook) envelope fetcher with a module cache — the agent gateway
 * and the draft cards need envelopes outside React's hook rules. Mirrors the
 * transcript cache's contract: fetch once per asset, absent entries simply
 * missing from the result.
 */

const cache = new Map<string, AudioEnvelope>()

export async function ensureEnvelopes(
  sequence: Sequence,
  snapshot: LibrarySnapshot
): Promise<Map<string, AudioEnvelope>> {
  const wanted = new Set<string>()
  for (const item of sequence.spine) if (item.kind === 'clip') wanted.add(item.assetId)
  for (const cc of sequence.connected) if (cc.titleData === undefined) wanted.add(cc.assetId)
  await Promise.all(
    [...wanted].map(async (assetId) => {
      if (cache.has(assetId)) return
      const url = snapshot.assets[assetId]?.envelopeUrl
      if (url === undefined) return
      try {
        const response = await fetch(url)
        if (response.ok) cache.set(assetId, (await response.json()) as AudioEnvelope)
      } catch {
        // analysis missing — the context/flow simply won't include it
      }
    })
  )
  const result = new Map<string, AudioEnvelope>()
  for (const assetId of wanted) {
    const envelope = cache.get(assetId)
    if (envelope !== undefined) result.set(assetId, envelope)
  }
  return result
}
