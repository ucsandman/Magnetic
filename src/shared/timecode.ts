/**
 * Time math. All durations/positions in Magnetic are integer FLICKS
 * (1/705,600,000 s) — exactly divisible by every common frame rate and audio
 * sample rate, so timeline math never touches floats.
 */
export const FLICKS_PER_SECOND = 705_600_000

export function secondsToFlicks(seconds: number): number {
  return Math.round(seconds * FLICKS_PER_SECOND)
}

export function flicksToSeconds(flicks: number): number {
  return flicks / FLICKS_PER_SECOND
}

export interface Rational {
  num: number
  den: number
}

/** Parse an ffprobe rational like "30000/1001" or "25/1". Returns null for 0/0 ("no rate"). */
export function parseRational(value: string): Rational | null {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim())
  if (match === null) return null
  const num = Number.parseInt(match[1], 10)
  const den = Number.parseInt(match[2], 10)
  if (num === 0 || den === 0) return null
  return { num, den }
}

/** Duration of one frame in flicks. Exact (integer) for all standard rates incl. NTSC. */
export function flicksPerFrame(fps: Rational): number {
  return Math.round((FLICKS_PER_SECOND * fps.den) / fps.num)
}

export function frameToFlicks(frame: number, fps: Rational): number {
  return frame * flicksPerFrame(fps)
}

/** Frame index containing this flicks position (floor). */
export function flicksToFrame(flicks: number, fps: Rational): number {
  return Math.floor(flicks / flicksPerFrame(fps))
}

/**
 * Non-drop-frame timecode HH:MM:SS:FF (NTSC rates display non-drop — noted in
 * UI). FF counts in nominal fps (e.g. 30 for 29.97).
 */
export function flicksToTimecode(flicks: number, fps: Rational): string {
  const nominalFps = Math.round(fps.num / fps.den)
  const totalFrames = flicksToFrame(Math.max(0, flicks), fps)
  const ff = totalFrames % nominalFps
  const totalSeconds = Math.floor(totalFrames / nominalFps)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return [hh, mm, ss, ff].map((part) => String(part).padStart(2, '0')).join(':')
}

/** Format a duration as m:ss (rounded to the nearest second), e.g. 0:10, 1:05. */
export function formatDurationFlicks(flicks: number): string {
  const totalSeconds = Math.round(flicksToSeconds(flicks))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
