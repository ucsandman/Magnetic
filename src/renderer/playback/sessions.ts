import type { AssetView } from '../../shared/types'
import { openSample, type DecoderHandle } from './decoder/sample-decoder'

/**
 * Per-asset decoder sessions. Assets whose native codec WebCodecs cannot
 * decode get a one-time H.264 preview proxy (transcoded in main, cached in
 * the library) and decode from that — playback never crashes on codecs.
 */

const SUPPORTED_CODECS = new Set(['h264'])

export function needsProxy(asset: AssetView): boolean {
  return asset.video !== undefined && !SUPPORTED_CODECS.has(asset.video.codec)
}

const sessions = new Map<string, Promise<DecoderHandle>>()

export function sessionFor(asset: AssetView): Promise<DecoderHandle> {
  let session = sessions.get(asset.id)
  if (session === undefined) {
    session = (async () => {
      const url = needsProxy(asset)
        ? (asset.proxyUrl ?? (await window.api.ensureProxy(asset.id)))
        : asset.mediaUrl
      return openSample(url)
    })()
    session.catch(() => sessions.delete(asset.id)) // retry next time on failure
    sessions.set(asset.id, session)
  }
  return session
}

export async function closeAllSessions(): Promise<void> {
  const open = [...sessions.values()]
  sessions.clear()
  for (const session of open) {
    try {
      ;(await session).close()
    } catch {
      // session failed to open in the first place — nothing to close
    }
  }
}
