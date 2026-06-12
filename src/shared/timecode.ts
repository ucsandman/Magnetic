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

/**
 * Parse user-typed timecode into flicks (FCP style). Two accepted shapes:
 * - colon-separated fields read right-to-left as FF, SS, MM, HH
 *   ("1:02:12" → 1 m 2 s 12 f)
 * - a bare digit run read right-to-left in pairs into the same fields
 *   ("1234" → 12 s 34 f, "90" → 90 f)
 * Overflowing fields normalize via frame math (90 f @ 30 fps → 3 s).
 * Returns null for anything else; clamping to a duration is the caller's job.
 */
export function parseTimecode(text: string, fps: Rational): number | null {
  const trimmed = text.trim()
  let fields: number[]
  if (/^\d+(:\d+)+$/.test(trimmed)) {
    fields = trimmed.split(':').map((part) => Number.parseInt(part, 10))
  } else if (/^\d+$/.test(trimmed)) {
    fields = []
    for (let end = trimmed.length; end > 0; end -= 2) {
      fields.unshift(Number.parseInt(trimmed.slice(Math.max(0, end - 2), end), 10))
    }
  } else {
    return null
  }
  if (fields.length > 4) return null
  while (fields.length < 4) fields.unshift(0)
  const [hh, mm, ss, ff] = fields
  const nominalFps = Math.round(fps.num / fps.den)
  const totalFrames = ((hh * 60 + mm) * 60 + ss) * nominalFps + ff
  return frameToFlicks(totalFrames, fps)
}

/** Format a duration as m:ss (rounded to the nearest second), e.g. 0:10, 1:05. */
export function formatDurationFlicks(flicks: number): string {
  const totalSeconds = Math.round(flicksToSeconds(flicks))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
