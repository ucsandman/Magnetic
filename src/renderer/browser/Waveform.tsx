import { useEffect, useState, type ReactNode } from 'react'

interface PeaksFile {
  buckets: [number, number][]
}

/** Mini waveform rendered from the peaks JSON (mfile:// fetch). */
export function Waveform({ url }: { url: string }): ReactNode {
  const [points, setPoints] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    fetch(url)
      .then((response) => response.json() as Promise<PeaksFile>)
      .then((peaks) => {
        if (disposed) return
        const step = Math.max(1, Math.floor(peaks.buckets.length / 120))
        const sampled = peaks.buckets.filter((_, index) => index % step === 0)
        const w = 120
        const h = 60
        const top = sampled
          .map(([, max], i) => `${(i / sampled.length) * w},${h / 2 - max * (h / 2 - 2)}`)
          .join(' ')
        const bottom = sampled
          .map(([min], i) => `${(i / sampled.length) * w},${h / 2 - min * (h / 2 - 2)}`)
          .reverse()
          .join(' ')
        setPoints(`${top} ${bottom}`)
      })
      .catch(() => setPoints(null))
    return () => {
      disposed = true
    }
  }, [url])

  if (points === null) return <span className="asset-audio-glyph">♪</span>
  return (
    <svg className="asset-waveform" viewBox="0 0 120 60" preserveAspectRatio="none">
      <polygon points={points} />
    </svg>
  )
}
