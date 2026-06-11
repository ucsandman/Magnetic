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
