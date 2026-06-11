/**
 * Render caches for clip bodies: filmstrip images and waveform peaks, keyed
 * by asset id. Loads are fire-and-forget; `onMediaReady` lets the canvas
 * schedule a redraw when something arrives.
 */

export interface PeaksData {
  sampleRate: number
  buckets: [number, number][]
}

const stripImages = new Map<string, HTMLImageElement | 'loading'>()
const peaks = new Map<string, PeaksData | 'loading'>()
let notify: (() => void) | null = null

export function onMediaReady(cb: () => void): void {
  notify = cb
}

export function stripImageFor(assetId: string, url: string): HTMLImageElement | null {
  const cached = stripImages.get(assetId)
  if (cached === 'loading') return null
  if (cached !== undefined) return cached
  stripImages.set(assetId, 'loading')
  const image = new Image()
  image.onload = () => {
    stripImages.set(assetId, image)
    notify?.()
  }
  image.onerror = () => {
    stripImages.delete(assetId)
  }
  image.src = url
  return null
}

export function peaksFor(assetId: string, url: string): PeaksData | null {
  const cached = peaks.get(assetId)
  if (cached === 'loading') return null
  if (cached !== undefined) return cached
  peaks.set(assetId, 'loading')
  fetch(url)
    .then((response) => response.json())
    .then((data: PeaksData) => {
      peaks.set(assetId, data)
      notify?.()
    })
    .catch(() => {
      peaks.delete(assetId)
    })
  return null
}
