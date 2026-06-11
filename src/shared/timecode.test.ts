import { describe, expect, it } from 'vitest'
import {
  FLICKS_PER_SECOND,
  flicksToSeconds,
  formatDurationFlicks,
  frameDurationFlicks,
  parseRational,
  secondsToFlicks
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
    expect(frameDurationFlicks({ num: 24, den: 1 })).toBe(29_400_000)
    expect(frameDurationFlicks({ num: 25, den: 1 })).toBe(28_224_000)
    expect(frameDurationFlicks({ num: 30, den: 1 })).toBe(23_520_000)
    // NTSC 29.97: 705600000 * 1001 / 30000 is exactly 23543520
    expect(frameDurationFlicks({ num: 30000, den: 1001 })).toBe(23_543_520)
  })

  it('formats durations as m:ss', () => {
    expect(formatDurationFlicks(secondsToFlicks(10))).toBe('0:10')
    expect(formatDurationFlicks(secondsToFlicks(8))).toBe('0:08')
    expect(formatDurationFlicks(secondsToFlicks(33.604))).toBe('0:34')
    expect(formatDurationFlicks(secondsToFlicks(65))).toBe('1:05')
  })
})
