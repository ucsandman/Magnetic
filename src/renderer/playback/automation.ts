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
  /** Ducking dips, CLIP-relative seconds (auto-duck under dialogue). */
  ducks?: { fromSec: number; toSec: number }[]
  /** Dip depth in dB (negative); applies to every range in `ducks`. */
  duckDb?: number
}

/** Lead-in/out ramp on each ducking dip. */
export const DUCK_RAMP_SEC = 0.25

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
  const ducks = args.ducks ?? []
  if (ducks.length === 0) return points
  return applyDucks(points, args, dbToGain(args.duckDb ?? -12))
}

/** Piecewise-linear sample of a gain polyline (flat before/after the ends). */
function valueAt(points: GainPoint[], t: number): number {
  if (points.length === 0) return 1
  if (t <= points[0].atCtxTime) return points[0].value
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const next = points[i]
    if (t <= next.atCtxTime) {
      const span = next.atCtxTime - prev.atCtxTime
      if (span <= 0) return next.value
      return prev.value + ((t - prev.atCtxTime) / span) * (next.value - prev.value)
    }
  }
  return points[points.length - 1].value
}

/**
 * Multiply the base envelope by the ducking multiplier: 1 outside every dip,
 * `duckGain` inside, linear DUCK_RAMP_SEC ramps on both sides (min wins where
 * dips overlap). Piecewise-linear × piecewise-linear is sampled at the union
 * of both breakpoint sets — exact at every anchor, inaudibly approximate on
 * the (short) shared ramps.
 */
function applyDucks(base: GainPoint[], args: GainEnvelopeArgs, duckGain: number): GainPoint[] {
  const start = args.startCtxTime
  const end = args.startCtxTime + args.durationSec
  const ducks = (args.ducks ?? []).map((duck) => ({
    fromCtx: start + duck.fromSec,
    toCtx: start + duck.toSec
  }))
  const duckMultAt = (t: number): number => {
    let mult = 1
    for (const duck of ducks) {
      if (t >= duck.fromCtx && t <= duck.toCtx) {
        mult = Math.min(mult, duckGain)
      } else if (t > duck.fromCtx - DUCK_RAMP_SEC && t < duck.fromCtx) {
        const progress = (duck.fromCtx - t) / DUCK_RAMP_SEC
        mult = Math.min(mult, duckGain + (1 - duckGain) * progress)
      } else if (t > duck.toCtx && t < duck.toCtx + DUCK_RAMP_SEC) {
        const progress = (t - duck.toCtx) / DUCK_RAMP_SEC
        mult = Math.min(mult, duckGain + (1 - duckGain) * progress)
      }
    }
    return mult
  }
  const times = new Set<number>(base.map((p) => p.atCtxTime))
  for (const duck of ducks) {
    for (const t of [
      duck.fromCtx - DUCK_RAMP_SEC,
      duck.fromCtx,
      duck.toCtx,
      duck.toCtx + DUCK_RAMP_SEC
    ]) {
      if (t >= start && t <= end) times.add(t)
    }
  }
  return [...times]
    .sort((a, b) => a - b)
    .map((t) => ({ atCtxTime: t, value: valueAt(base, t) * duckMultAt(t) }))
}
