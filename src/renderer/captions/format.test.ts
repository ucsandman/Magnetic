import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { toSrt, toVtt, type SidecarCue } from './format'

const S = FLICKS_PER_SECOND

const cues: SidecarCue[] = [
  { startFlicks: 0, endFlicks: 1.25 * S, text: 'hello there' },
  { startFlicks: 61.5 * S, endFlicks: 3_599.999 * S, text: 'almost an hour in' },
  { startFlicks: 3_600 * S, endFlicks: 3_661.042 * S, text: 'line one\nline two' }
]

describe('toSrt', () => {
  it('numbers cues and uses comma-millisecond timestamps with CRLF', () => {
    const srt = toSrt(cues)
    expect(srt).toBe(
      '1\r\n' +
        '00:00:00,000 --> 00:00:01,250\r\n' +
        'hello there\r\n' +
        '\r\n' +
        '2\r\n' +
        '00:01:01,500 --> 00:59:59,999\r\n' +
        'almost an hour in\r\n' +
        '\r\n' +
        '3\r\n' +
        '01:00:00,000 --> 01:01:01,042\r\n' +
        'line one\r\n' +
        'line two\r\n'
    )
  })

  it('serializes no cues as an empty file', () => {
    expect(toSrt([])).toBe('')
  })

  it('never uses bare LF', () => {
    expect(toSrt(cues).replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('toVtt', () => {
  it('emits the WEBVTT header and dot-millisecond timestamps with LF', () => {
    const vtt = toVtt(cues)
    expect(vtt).toBe(
      'WEBVTT\n' +
        '\n' +
        '00:00:00.000 --> 00:00:01.250\n' +
        'hello there\n' +
        '\n' +
        '00:01:01.500 --> 00:59:59.999\n' +
        'almost an hour in\n' +
        '\n' +
        '01:00:00.000 --> 01:01:01.042\n' +
        'line one\n' +
        'line two\n'
    )
    expect(vtt).not.toContain('\r')
  })

  it('serializes no cues as just the header', () => {
    expect(toVtt([])).toBe('WEBVTT\n')
  })
})
