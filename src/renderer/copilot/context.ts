import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { effectiveRole, visibleMarkers, type Sequence } from '../../shared/timeline/model'
import type { AudioEnvelope, Transcript } from '../../shared/types'
import { detectSilence } from '../silence/detect'
import { projectTranscript } from '../transcript/projection'

/**
 * The copilot's perception: a deterministic plain-text rendering of the open
 * sequence — clips, dead air, and the timestamped transcript — computed live
 * from the same pure projections the panels use. Pure and testable; NEVER
 * includes anything the human can't already see.
 */

/** Transcript section budget. Overruns are ANNOUNCED in-context, never silent. */
export const TRANSCRIPT_CHAR_CAP = 20_000

function fmtTime(flicks: number): string {
  const totalSec = flicks / FLICKS_PER_SECOND
  const min = Math.floor(totalSec / 60)
  const sec = totalSec - min * 60
  return `${min}:${sec.toFixed(1).padStart(4, '0')}`
}

function fmtDur(flicks: number): string {
  return `${(flicks / FLICKS_PER_SECOND).toFixed(1)}s`
}

export function buildCopilotContext(
  sequence: Sequence,
  transcripts: Map<string, Transcript>,
  envelopes: ReadonlyMap<string, AudioEnvelope>,
  assetNames: ReadonlyMap<string, string>
): string {
  const lines: string[] = ['# Timeline']

  if (sequence.spine.length === 0 && sequence.connected.length === 0) {
    lines.push('The timeline is empty — no clips yet.')
    return lines.join('\n')
  }

  const total = sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
  const fps = sequence.fps.num / sequence.fps.den
  lines.push(
    `Sequence: ${sequence.spine.length} spine item(s), ${sequence.connected.length} connected clip(s), total ${fmtDur(total)} at ${Number.isInteger(fps) ? fps : fps.toFixed(3)} fps.`
  )

  lines.push('', '## Spine (in order)')
  let position = 0
  let index = 1
  for (const item of sequence.spine) {
    const start = position
    position += item.durationFlicks
    if (item.kind === 'gap') {
      lines.push(
        `- gap — ${fmtTime(start)} to ${fmtTime(position)} (${fmtDur(item.durationFlicks)})`
      )
      continue
    }
    const name = assetNames.get(item.assetId) ?? item.assetId
    const role = effectiveRole(item)
    const notes =
      (item.audioDisabled === true ? ' [audio detached]' : '') +
      (role !== null && role !== 'dialogue' ? ` [role: ${role}]` : '')
    lines.push(
      `${index}. ${name} [id=${item.id}] [file=${name}] — ${fmtTime(start)} to ${fmtTime(position)} (${fmtDur(item.durationFlicks)}), source in ${fmtTime(item.mediaInFlicks)}${notes}`
    )
    index += 1
  }
  lines.push('Edit point N (0-based) is the cut between spine items N and N+1 in the list above.')

  if (sequence.connected.length > 0) {
    lines.push('', '## Connected clips')
    for (const cc of sequence.connected) {
      const role = effectiveRole(cc)
      const fileName = cc.titleData === undefined ? (assetNames.get(cc.assetId) ?? cc.assetId) : null
      const label =
        cc.titleData !== undefined
          ? `title "${cc.titleData.text}"`
          : fileName +
            (cc.loop === true ? ' (looped bed)' : '') +
            (role !== null && role !== 'dialogue' ? ` [role: ${role}]` : '')
      const fileTag = fileName !== null ? ` [file=${fileName}]` : ''
      lines.push(
        `- ${label} [id=${cc.id}]${fileTag}, lane ${cc.lane}, ${fmtDur(cc.durationFlicks)} attached to ${cc.parentClipId}`
      )
    }
  }

  const markers = visibleMarkers(sequence)
  if (markers.length > 0) {
    lines.push('', '## Markers')
    for (const { marker, seqFlicks } of markers) {
      lines.push(
        `- [${marker.color}] ${fmtTime(seqFlicks)} [id=${marker.id}]${marker.text.length > 0 ? ` — ${marker.text}` : ''}`
      )
    }
  }

  lines.push('', '## Dead air (silence detection, default sensitivity)')
  const silences = detectSilence(sequence, envelopes)
  if (silences.length === 0) {
    lines.push('none detected (or audio analysis still running)')
  } else {
    for (const range of silences) {
      lines.push(
        `- ${fmtTime(range.fromFlicks)} to ${fmtTime(range.toFlicks)} (${fmtDur(range.toFlicks - range.fromFlicks)})`
      )
    }
  }

  lines.push('', '## Transcript (sequence time)')
  const words = projectTranscript(sequence, transcripts)
  if (words.length === 0) {
    lines.push('no transcript available yet (transcription runs in the background after import)')
  } else {
    let chars = 0
    let included = 0
    let line: string[] = []
    let lineStart = 0
    const flush = (): void => {
      if (line.length === 0) return
      lines.push(`[${fmtTime(lineStart)}] ${line.join(' ')}`)
      line = []
    }
    for (const word of words) {
      if (chars > TRANSCRIPT_CHAR_CAP) break
      if (line.length === 0) lineStart = word.seqStartFlicks
      line.push(word.text)
      chars += word.text.length + 1
      included += 1
      if (word.clipBoundary && line.length > 1) {
        const boundaryWord = line.pop()!
        flush()
        line = [boundaryWord]
        lineStart = word.seqStartFlicks
      } else if (line.join(' ').length > 110) {
        flush()
      }
    }
    flush()
    if (included < words.length) {
      lines.push(
        `[transcript truncated: showing the first ${included} of ${words.length} words — ask about a specific time range for detail]`
      )
    }
  }

  return lines.join('\n')
}
