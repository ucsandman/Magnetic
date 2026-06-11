import { execFile } from 'child_process'
import { promisify } from 'util'
import type { AudioInfo, VideoInfo } from '../../shared/types'
import { parseRational, secondsToFlicks } from '../../shared/timecode'
import { ffprobePath } from '../binaries'

const execFileAsync = promisify(execFile)

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  channels?: number
  sample_rate?: string
  disposition?: { attached_pic?: number }
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string }
}

export interface ProbeResult {
  durationFlicks: number
  video?: VideoInfo
  audio?: AudioInfo
}

/** ffprobe a media file. Throws with a readable reason for unreadable files. */
export async function probeMedia(filePath: string): Promise<ProbeResult> {
  let raw: string
  try {
    const { stdout } = await execFileAsync(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    raw = stdout
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    throw new Error(`ffprobe failed: ${stderr.trim().split(/\r?\n/)[0] ?? 'unknown error'}`)
  }

  const probe = JSON.parse(raw) as FfprobeOutput
  const durationSeconds = Number.parseFloat(probe.format?.duration ?? '')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('no readable duration (not a media file?)')
  }

  const streams = probe.streams ?? []
  const videoStream = streams.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1
  )
  const audioStream = streams.find((stream) => stream.codec_type === 'audio')
  if (videoStream === undefined && audioStream === undefined) {
    throw new Error('no video or audio stream found')
  }

  const result: ProbeResult = { durationFlicks: secondsToFlicks(durationSeconds) }

  if (videoStream !== undefined) {
    const fps = parseRational(videoStream.r_frame_rate ?? '')
    if (fps === null) throw new Error(`unparseable frame rate: ${videoStream.r_frame_rate}`)
    if (videoStream.width === undefined || videoStream.height === undefined) {
      throw new Error('video stream missing dimensions')
    }
    result.video = {
      codec: videoStream.codec_name ?? 'unknown',
      w: videoStream.width,
      h: videoStream.height,
      fps,
      durationFlicks: result.durationFlicks
    }
  }

  if (audioStream !== undefined) {
    result.audio = {
      codec: audioStream.codec_name ?? 'unknown',
      channels: audioStream.channels ?? 1,
      sampleRate: Number.parseInt(audioStream.sample_rate ?? '0', 10)
    }
  }

  return result
}
