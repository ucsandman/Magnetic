/**
 * Pure gain-envelope math for clip audio: fade-in/out ramps around a dB
 * plateau. The audio graph feeds these points to linearRampToValueAtTime;
 * being pure, the envelope itself is unit-testable without an AudioContext.
 */

export interface GainEnvelopeArgs {
  /** AudioContext time at which the clip's audio starts. */
  startCtxTime: number
  durationSec: number
  fadeInSec: number
  fadeOutSec: number
  volumeDb: number
}

export interface GainPoint {
  atCtxTime: number
  value: number
}

export function dbToGain(volumeDb: number): number {
  return Math.pow(10, volumeDb / 20)
}

/**
 * Clip a gain polyline at `atTime`: earlier points are dropped and replaced by
 * the linearly interpolated value AT atTime. A chunked offline render whose
 * chunk boundary lands mid-ramp resumes the ramp at the exact value the
 * previous chunk ended on — no seam discontinuity (the live graph instead
 * clamps past anchors to "now", which is fine for an audible seek but would
 * put a click at every chunk boundary of an export).
 */
export function clipGainPoints(points: GainPoint[], atTime: number): GainPoint[] {
  if (points.length === 0 || points[0].atCtxTime >= atTime) return points
  let last = 0
  while (last + 1 < points.length && points[last + 1].atCtxTime < atTime) last += 1
  const from = points[last]
  const next = points[last + 1]
  const value =
    next === undefined || next.atCtxTime <= from.atCtxTime
      ? from.value
      : from.value +
        ((atTime - from.atCtxTime) / (next.atCtxTime - from.atCtxTime)) * (next.value - from.value)
  return [{ atCtxTime: atTime, value }, ...points.slice(last + 1)]
}

export function gainAutomationFor(args: GainEnvelopeArgs): GainPoint[] {
  const gain = dbToGain(args.volumeDb)
  // fades never overlap: each clamps to half the clip
  const fadeIn = Math.min(Math.max(0, args.fadeInSec), args.durationSec / 2)
  const fadeOut = Math.min(Math.max(0, args.fadeOutSec), args.durationSec / 2)
  const start = args.startCtxTime
  const end = args.startCtxTime + args.durationSec
  const points: GainPoint[] = []
  if (fadeIn > 0) {
    points.push({ atCtxTime: start, value: 0 })
    points.push({ atCtxTime: start + fadeIn, value: gain })
  } else {
    points.push({ atCtxTime: start, value: gain })
  }
  if (fadeOut > 0) {
    points.push({ atCtxTime: end - fadeOut, value: gain })
    points.push({ atCtxTime: end, value: 0 })
  }
  return points
}
