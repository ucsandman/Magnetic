import type { AssetView } from '../../shared/types'
import { openSample, type DecoderHandle } from './decoder/sample-decoder'

/**
 * Per-asset decoder sessions. Assets whose native codec WebCodecs cannot
 * decode get a one-time H.264 preview proxy (transcoded in main, cached in
 * the library) and decode from that — playback never crashes on codecs.
 * Assets whose CONTAINER cannot demux (MKV/AVI byte-copies, fragmented MP4s
 * that bypassed the import remux) get the same proxy fallback when the
 * direct demux rejects, instead of staying black forever.
 */

const SUPPORTED_CODECS = new Set(['h264'])

export function needsProxy(asset: AssetView): boolean {
  return asset.video !== undefined && !SUPPORTED_CODECS.has(asset.video.codec)
}

/**
 * Retained handles keep their full sample table (~tens of MB for multi-hour
 * clips), so the cache is a small LRU. Evicted entries are only dropped from
 * the map — active pumps may still hold the handle; GC reclaims it when the
 * last generator finishes.
 */
const MAX_SESSIONS = 6

const sessions = new Map<string, Promise<DecoderHandle>>()

async function proxyHandle(asset: AssetView): Promise<DecoderHandle> {
  const proxyUrl = asset.proxyUrl ?? (await window.api.ensureProxy(asset.id))
  return openSample(proxyUrl)
}

export function sessionFor(asset: AssetView): Promise<DecoderHandle> {
  let session = sessions.get(asset.id)
  if (session !== undefined) {
    // LRU touch: re-insert as most recently used.
    sessions.delete(asset.id)
    sessions.set(asset.id, session)
    return session
  }
  session = (async () => {
    if (needsProxy(asset)) return proxyHandle(asset)
    try {
      return await openSample(asset.mediaUrl)
    } catch (error) {
      // Container the demuxer can't parse (MKV/AVI/fMP4) — fall back to the
      // H.264 preview proxy once rather than black-screening the clip.
      console.error(
        `decoder: direct demux failed for ${asset.fileName}; falling back to preview proxy:`,
        error
      )
      return proxyHandle(asset)
    }
  })()
  session.catch((error: unknown) => {
    console.error(`decoder session failed for ${asset.fileName}:`, error)
    sessions.delete(asset.id) // retry next time on failure
  })
  sessions.set(asset.id, session)
  for (const oldestId of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS) break
    sessions.delete(oldestId)
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
