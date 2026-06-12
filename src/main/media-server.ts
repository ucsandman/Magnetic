import { randomUUID } from 'crypto'
import { createReadStream, statSync } from 'fs'
import { createServer } from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import { extname, isAbsolute, normalize, sep } from 'path'

/**
 * Loopback HTTP server that serves library video/audio files to <video>
 * elements (and the WebCodecs decoder's fetch) with standard Range semantics.
 *
 * Video CANNOT be served through the mfile custom protocol: Electron's
 * protocol.handle response plumbing wedges Chromium's media loader on
 * multi-GB files — playback from byte 0 works, but any seek outside the
 * buffered head stalls forever or fatally stops the pipeline
 * ("FFmpegDemuxer: av_read_frame(): I/O error"), regardless of how the 206
 * is backed (Node stream, pull stream, bounded chunks; net.fetch(file://)
 * ignores Range entirely). The identical range logic over real HTTP plays
 * and deep-seeks correctly, so media goes over 127.0.0.1 and everything
 * else (filmstrips, peaks, transcripts, PCM) stays on mfile.
 *
 * Security: bound to 127.0.0.1, every URL carries an unguessable per-session
 * token, and only paths inside the allowed roots are served.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac'
}

export interface MediaServer {
  port: number
  urlForPath(absolutePath: string): string
  close(): Promise<void>
}

export function startMediaServer(getAllowedRoots: () => string[]): Promise<MediaServer> {
  const token = randomUUID()

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const segments = (req.url ?? '').split(/[?#]/)[0].split('/')
    // expected shape: ['', token, encoded path segments...]
    if (segments.length < 3 || segments[1] !== token) {
      res.writeHead(403).end()
      return
    }
    const filePath = normalize(segments.slice(2).map(decodeURIComponent).join(sep))
    if (!isAbsolute(filePath) || !isInsideAllowedRoot(filePath, getAllowedRoots())) {
      res.writeHead(403).end()
      return
    }
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      res.writeHead(404).end()
      return
    }
    serveFile(req, res, filePath, size)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('media server: no port assigned'))
        return
      }
      const port = address.port
      resolve({
        port,
        urlForPath: (absolutePath: string): string => {
          const encoded = absolutePath.replace(/\\/g, '/').split('/').map(encodeURIComponent)
          return `http://127.0.0.1:${port}/${token}/${encoded.join('/')}`
        },
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
          })
      })
    })
  })
}

function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number
): void {
  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  }
  const range = req.headers.range === undefined ? null : parseRange(req.headers.range, size)

  if (req.headers.range !== undefined && range === null) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return
  }

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  res.writeHead(range === null ? 200 : 206, {
    ...baseHeaders,
    'Content-Length': String(end - start + 1),
    ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` })
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(filePath, { start, end })
  stream.pipe(res)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
}

export function parseRange(header: string, size: number): { start: number; end: number } | null {
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
