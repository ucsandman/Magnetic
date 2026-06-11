import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { isAbsolute, normalize, sep } from 'path'

/** Must run before app.whenReady(). */
export function registerMfileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mfile',
      privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

/**
 * Serve library files (media, filmstrips, peaks) to the renderer as
 * mfile:///C:/abs/path. Only paths inside the allowed roots are served —
 * everything else gets a 403.
 */
export function installMfileHandler(getAllowedRoots: () => string[]): void {
  protocol.handle('mfile', async (request) => {
    const raw = request.url.replace(/^mfile:\/\/\//, '').split(/[?#]/)[0]
    const filePath = normalize(raw.split('/').map(decodeURIComponent).join(sep))
    if (!isAbsolute(filePath) || !isInsideAllowedRoot(filePath, getAllowedRoots())) {
      return new Response('forbidden', { status: 403 })
    }
    const fileResponse = await net.fetch(pathToFileURL(filePath).toString())
    // The renderer's origin is file:// — allow it to fetch() mfile resources.
    const headers = new Headers(fileResponse.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(fileResponse.body, { status: fileResponse.status, headers })
  })
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
