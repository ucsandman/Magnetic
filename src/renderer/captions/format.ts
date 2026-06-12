import { FLICKS_PER_SECOND } from '../../shared/timecode'

/**
 * SRT/VTT sidecar serializers. Pure text math: flicks → HH:MM:SS,mmm (SRT,
 * CRLF) / HH:MM:SS.mmm (VTT, LF). Cue text may contain newlines (multi-line
 * captions) — each line is emitted as its own subtitle line.
 */

export interface SidecarCue {
  startFlicks: number
  endFlicks: number
  text: string
}

function timestamp(flicks: number, msSeparator: ',' | '.'): string {
  const totalMs = Math.round((flicks / FLICKS_PER_SECOND) * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSeparator}${pad(ms, 3)}`
}

export function toSrt(cues: SidecarCue[]): string {
  const blocks = cues.map((cue, index) =>
    [
      String(index + 1),
      `${timestamp(cue.startFlicks, ',')} --> ${timestamp(cue.endFlicks, ',')}`,
      ...cue.text.split('\n')
    ].join('\r\n')
  )
  return blocks.length === 0 ? '' : blocks.join('\r\n\r\n') + '\r\n'
}

export function toVtt(cues: SidecarCue[]): string {
  const blocks = cues.map((cue) =>
    [
      `${timestamp(cue.startFlicks, '.')} --> ${timestamp(cue.endFlicks, '.')}`,
      ...cue.text.split('\n')
    ].join('\n')
  )
  return blocks.length === 0 ? 'WEBVTT\n' : 'WEBVTT\n\n' + blocks.join('\n\n') + '\n'
}
