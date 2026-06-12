import { describe, expect, it } from 'vitest'
import {
  FLICKS_PER_SECOND,
  flicksPerFrame,
  flicksToFrame,
  flicksToSeconds,
  flicksToTimecode,
  formatDurationFlicks,
  frameToFlicks,
  parseRational,
  parseTimecode,
  secondsToFlicks,
  type Rational
} from './timecode'

describe('timecode', () => {
  it('round-trips seconds <-> flicks', () => {
    expect(secondsToFlicks(1)).toBe(FLICKS_PER_SECOND)
    expect(secondsToFlicks(10)).toBe(7_056_000_000)
    expect(flicksToSeconds(secondsToFlicks(33.604))).toBeCloseTo(33.604, 9)
  })

  it('parses ffprobe rationals, rejecting junk and 0/0', () => {
    expect(parseRational('30000/1001')).toEqual({ num: 30000, den: 1001 })
    expect(parseRational('25/1')).toEqual({ num: 25, den: 1 })
    expect(parseRational('0/0')).toBeNull()
    expect(parseRational('29.97')).toBeNull()
    expect(parseRational('')).toBeNull()
  })

  it('gives exact integer frame durations for standard rates', () => {
    expect(flicksPerFrame({ num: 24, den: 1 })).toBe(29_400_000)
    expect(flicksPerFrame({ num: 25, den: 1 })).toBe(28_224_000)
    expect(flicksPerFrame({ num: 30, den: 1 })).toBe(23_520_000)
    // NTSC 29.97: 705600000 * 1001 / 30000 is exactly 23543520
    expect(flicksPerFrame({ num: 30000, den: 1001 })).toBe(23_543_520)
  })

  const RATES: [string, Rational][] = [
    ['23.976', { num: 24000, den: 1001 }],
    ['24', { num: 24, den: 1 }],
    ['25', { num: 25, den: 1 }],
    ['30', { num: 30, den: 1 }],
    ['59.94', { num: 60000, den: 1001 }],
    ['60', { num: 60, den: 1 }]
  ]

  it.each(RATES)(
    'frame -> flicks -> frame round-trips exactly for 1 hour at %s fps',
    (_label, fps) => {
      const oneHourFrames = Math.ceil((3600 * fps.num) / fps.den)
      for (let frame = 0; frame <= oneHourFrames; frame += 1) {
        const flicks = frameToFlicks(frame, fps)
        if (flicksToFrame(flicks, fps) !== frame) {
          // explicit throw keeps the loop fast (no per-iteration expect overhead)
          throw new Error(`drift at frame ${frame}: ${flicksToFrame(flicks, fps)}`)
        }
      }
      // and the hour boundary lands exactly where integer math says it should
      expect(flicksToFrame(frameToFlicks(oneHourFrames, fps), fps)).toBe(oneHourFrames)
    }
  )

  it('formats non-drop timecode', () => {
    const fps30: Rational = { num: 30, den: 1 }
    expect(flicksToTimecode(0, fps30)).toBe('00:00:00:00')
    expect(flicksToTimecode(frameToFlicks(1, fps30), fps30)).toBe('00:00:00:01')
    expect(flicksToTimecode(frameToFlicks(30, fps30), fps30)).toBe('00:00:01:00')
    expect(flicksToTimecode(frameToFlicks(30 * 3600, fps30), fps30)).toBe('01:00:00:00')
    const ntsc: Rational = { num: 30000, den: 1001 }
    expect(flicksToTimecode(frameToFlicks(30, ntsc), ntsc)).toBe('00:00:01:00')
  })

  it('parses typed timecode: colon fields right-to-left FF, SS, MM, HH', () => {
    const fps30: Rational = { num: 30, den: 1 }
    expect(parseTimecode('00:01:02:12', fps30)).toBe(frameToFlicks((60 + 2) * 30 + 12, fps30))
    expect(parseTimecode('1:02:12', fps30)).toBe(frameToFlicks((60 + 2) * 30 + 12, fps30))
    expect(parseTimecode('02:12', fps30)).toBe(frameToFlicks(2 * 30 + 12, fps30))
    expect(parseTimecode(' 00:00:02:00 ', fps30)).toBe(frameToFlicks(60, fps30))
  })

  it('parses typed timecode: bare digit runs in right-to-left pairs', () => {
    const fps30: Rational = { num: 30, den: 1 }
    expect(parseTimecode('1234', fps30)).toBe(frameToFlicks(12 * 30 + 34, fps30))
    expect(parseTimecode('12', fps30)).toBe(frameToFlicks(12, fps30))
    expect(parseTimecode('10203', fps30)).toBe(frameToFlicks((60 + 2) * 30 + 3, fps30))
  })

  it('normalizes overflowing timecode fields via frame math', () => {
    const fps30: Rational = { num: 30, den: 1 }
    expect(parseTimecode('90', fps30)).toBe(frameToFlicks(90, fps30)) // = 3 s
    expect(flicksToTimecode(parseTimecode('90', fps30)!, fps30)).toBe('00:00:03:00')
    expect(flicksToTimecode(parseTimecode('0:90:00', fps30)!, fps30)).toBe('00:01:30:00')
  })

  it('rejects garbage timecode input', () => {
    const fps30: Rational = { num: 30, den: 1 }
    for (const bad of ['', '  ', 'abc', '-3', '1:2:3:4:5', '123456789', '1:a2', '1..2']) {
      expect(parseTimecode(bad, fps30)).toBeNull()
    }
  })

  it('parses typed timecode at NTSC rates with exact frame flicks', () => {
    const ntsc: Rational = { num: 30000, den: 1001 }
    expect(parseTimecode('00:00:01:00', ntsc)).toBe(frameToFlicks(30, ntsc))
  })

  it('formats durations as m:ss', () => {
    expect(formatDurationFlicks(secondsToFlicks(10))).toBe('0:10')
    expect(formatDurationFlicks(secondsToFlicks(8))).toBe('0:08')
    expect(formatDurationFlicks(secondsToFlicks(33.604))).toBe('0:34')
    expect(formatDurationFlicks(secondsToFlicks(65))).toBe('1:05')
  })
})
