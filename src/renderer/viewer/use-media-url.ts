import { useEffect, useState } from 'react'
import type { AssetView } from '../../shared/types'
import { needsProxy } from '../playback/sessions'

/**
 * Playable URL for an asset's <video> preview: the original media, or the
 * H.264 preview proxy when the codec is not natively decodable (resolving it
 * on demand via ensureProxy, falling back to the original on failure).
 */
export function useMediaUrl(asset: AssetView): string {
  const proxyNeeded = needsProxy(asset)
  const [resolvedProxyUrl, setResolvedProxyUrl] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    if (!proxyNeeded || asset.proxyUrl !== undefined) {
      return () => {
        disposed = true
      }
    }
    void window.api
      .ensureProxy(asset.id)
      .then((url) => {
        if (!disposed) setResolvedProxyUrl(url)
      })
      .catch((error: unknown) => {
        // Keep the original-media fallback (plays fine for e.g. unusual
        // containers with h264 inside) but say so — a codec the renderer
        // cannot decode will hit the <video> onError overlay instead.
        console.error(`preview proxy failed for ${asset.fileName}:`, error)
        if (!disposed) setResolvedProxyUrl(asset.mediaUrl)
      })
    return () => {
      disposed = true
    }
  }, [asset.id, asset.fileName, asset.mediaUrl, asset.proxyUrl, proxyNeeded])

  return proxyNeeded ? (asset.proxyUrl ?? resolvedProxyUrl ?? '') : asset.mediaUrl
}
