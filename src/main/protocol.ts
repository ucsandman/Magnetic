import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { isAbsolute, extname, normalize, sep } from 'path'
import { Readable } from 'stream'

/** Must run before app.whenReady(). */
export function registerMfileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mfile',
      privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json'
}

/**
 * Serve library files (media, filmstrips, peaks) to the renderer as
 * mfile:///C:/abs/path with HTTP Range support so <video> can seek.
 * Only paths inside the allowed roots are served — everything else is 403.
 */
export function installMfileHandler(getAllowedRoots: () => string[]): void {
  protocol.handle('mfile', (request) => {
    const raw = request.url.replace(/^mfile:\/\/\//, '').split(/[?#]/)[0]
    const filePath = normalize(raw.split('/').map(decodeURIComponent).join(sep))
    if (!isAbsolute(filePath) || !isInsideAllowedRoot(filePath, getAllowedRoots())) {
      return new Response('forbidden', { status: 403 })
    }

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const baseHeaders: Record<string, string> = {
      // The renderer's origin is file:// — allow it to fetch() mfile resources.
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Type': MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    }

    const rangeHeader = request.headers.get('Range')
    const range = rangeHeader === null ? null : parseRange(rangeHeader, size)

    if (range === null) {
      const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(size) }
      })
    }

    const body = Readable.toWeb(
      createReadStream(filePath, { start: range.start, end: range.end })
    ) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`
      }
    })
  })
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return null
  if (startRaw === '') {
    // suffix range: last N bytes
    const suffix = Math.min(size, Number.parseInt(endRaw, 10))
    return { start: size - suffix, end: size - 1 }
  }
  const start = Number.parseInt(startRaw, 10)
  const end = endRaw === '' ? size - 1 : Math.min(size - 1, Number.parseInt(endRaw, 10))
  if (start > end || start >= size) return null
  return { start, end }
}

function isInsideAllowedRoot(filePath: string, roots: string[]): boolean {
  const normalized = filePath.toLowerCase()
  return roots.some((root) => {
    const normalizedRoot = normalize(root)
      .toLowerCase()
      .replace(/[\\/]+$/, '')
    return normalized.startsWith(normalizedRoot + sep) || normalized === normalizedRoot
  })
}
