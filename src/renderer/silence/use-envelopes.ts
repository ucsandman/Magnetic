import { useEffect, useMemo, useState } from 'react'
import type { Sequence } from '../../shared/timeline/model'
import type { AudioEnvelope, LibrarySnapshot } from '../../shared/types'

/**
 * Fetch (and cache by assetId) the RMS envelope of every asset the sequence
 * references. Shared by SilencePanel and RoughCutPanel — one fetch discipline,
 * one failure count, so an empty detection list is never mistaken for "no
 * silence" when analysis actually failed.
 */
export function useAssetEnvelopes(
  sequence: Sequence | null,
  snapshot: LibrarySnapshot | null
): { envelopes: Map<string, AudioEnvelope>; analysisFailures: number } {
  const [envelopes, setEnvelopes] = useState<Map<string, AudioEnvelope>>(new Map())
  const [fetchFailed, setFetchFailed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (sequence === null || snapshot === null) return
    const wanted = new Set<string>()
    for (const item of sequence.spine) if (item.kind === 'clip') wanted.add(item.assetId)
    for (const cc of sequence.connected) if (cc.titleData === undefined) wanted.add(cc.assetId)
    let disposed = false
    for (const assetId of wanted) {
      const url = snapshot.assets[assetId]?.envelopeUrl
      if (url === undefined || envelopes.has(assetId)) continue
      if (fetchFailed.has(assetId)) continue
      void fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`envelope fetch: HTTP ${response.status}`)
          return response.json()
        })
        .then((data: AudioEnvelope) => {
          if (disposed) return
          setEnvelopes((current) => {
            const next = new Map(current)
            next.set(assetId, data)
            return next
          })
        })
        .catch((error: unknown) => {
          console.error(`audio envelope unavailable for asset ${assetId}:`, error)
          if (!disposed) setFetchFailed((current) => new Set(current).add(assetId))
        })
    }
    return () => {
      disposed = true
    }
  }, [sequence, snapshot, envelopes, fetchFailed])

  // Referenced assets whose envelope analysis failed (job error or unreadable
  // cache file) — surfaced so an empty list is not mistaken for "no silence".
  const analysisFailures = useMemo(() => {
    if (sequence === null || snapshot === null) return 0
    const wanted = new Set<string>()
    for (const item of sequence.spine) if (item.kind === 'clip') wanted.add(item.assetId)
    for (const cc of sequence.connected) if (cc.titleData === undefined) wanted.add(cc.assetId)
    let count = 0
    for (const assetId of wanted) {
      const failed = snapshot.assets[assetId]?.envelopeError !== undefined
      if (failed || fetchFailed.has(assetId)) count += 1
    }
    return count
  }, [sequence, snapshot, fetchFailed])

  return { envelopes, analysisFailures }
}
