import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseRange, startMediaServer, type MediaServer } from './media-server'

describe('parseRange', () => {
  it('parses absolute, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('rejects malformed and unsatisfiable ranges', () => {
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('frames=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
    expect(parseRange('bytes=9-3', 1000)).toBeNull()
  })
})

describe('media server', () => {
  let root: string
  let outside: string
  let server: MediaServer
  const content = Buffer.from('0123456789'.repeat(100)) // 1000 bytes

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'media-server-root-'))
    outside = mkdtempSync(join(tmpdir(), 'media-server-outside-'))
    writeFileSync(join(root, 'clip.mp4'), content)
    writeFileSync(join(outside, 'secret.mp4'), content)
    server = await startMediaServer(() => [root])
  })

  afterAll(async () => {
    await server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('serves a whole file with 200', async () => {
    const res = await fetch(server.urlForPath(join(root, 'clip.mp4')))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content)
  })

  it('serves ranges with 206 and correct Content-Range', async () => {
    const url = server.urlForPath(join(root, 'clip.mp4'))
    const res = await fetch(url, { headers: { Range: 'bytes=10-19' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/1000')
    expect(await res.text()).toBe('0123456789')

    const openEnded = await fetch(url, { headers: { Range: 'bytes=990-' } })
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get('Content-Range')).toBe('bytes 990-999/1000')
    expect((await openEnded.arrayBuffer()).byteLength).toBe(10)

    const suffix = await fetch(url, { headers: { Range: 'bytes=-5' } })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('Content-Range')).toBe('bytes 995-999/1000')
  })

  it('returns 416 for unsatisfiable ranges', async () => {
    const url = server.urlForPath(join(root, 'clip.mp4'))
    const res = await fetch(url, { headers: { Range: 'bytes=5000-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */1000')
  })

  it('rejects requests with a wrong token', async () => {
    const url = server.urlForPath(join(root, 'clip.mp4'))
    const tampered = url.replace(/:\/\/127\.0\.0\.1:(\d+)\/[^/]+\//, '://127.0.0.1:$1/wrong-token/')
    const res = await fetch(tampered)
    expect(res.status).toBe(403)
  })

  it('rejects paths outside the allowed roots', async () => {
    const res = await fetch(server.urlForPath(join(outside, 'secret.mp4')))
    expect(res.status).toBe(403)
  })

  it('returns 404 for missing files inside the root', async () => {
    const res = await fetch(server.urlForPath(join(root, 'nope.mp4')))
    expect(res.status).toBe(404)
  })

  it('rejects non-GET methods', async () => {
    const res = await fetch(server.urlForPath(join(root, 'clip.mp4')), { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
