/**
 * Pure loudness math shared by the main-process meter (ffmpeg ebur128) and
 * the renderer's normalize actions. Measurement is IO; this is not.
 */

/** Integrated loudness (I:) from an ebur128 summary; null when unmeasurable. */
export function parseIntegratedLufs(output: string): number | null {
  const match = /I:\s*(-?[\d.]+)\s*LUFS/.exec(output)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** The streaming-friendly default target (YouTube/Spotify land at −14). */
export const DEFAULT_TARGET_LUFS = -14

/** volumeDb that brings `measured` LUFS to `target`, clamped to the mixer range. */
export function normalizeGainDb(measuredLufs: number, targetLufs: number): number {
  return Math.min(12, Math.max(-96, targetLufs - measuredLufs))
}
