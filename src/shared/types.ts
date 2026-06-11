/** Core data model. Durations are integer flicks (see timecode.ts). */

export type Rating = 'none' | 'favorite' | 'rejected'

export interface VideoInfo {
  codec: string
  w: number
  h: number
  /** Frames per second as an exact rational, e.g. { num: 30000, den: 1001 }. */
  fps: { num: number; den: number }
  durationFlicks: number
}

export interface AudioInfo {
  codec: string
  channels: number
  sampleRate: number
}

export interface FilmstripInfo {
  /** Path of the strip JPEG relative to the library root. */
  stripPath: string
  frameW: number
  frameH: number
  frameCount: number
  intervalFlicks: number
}

export interface WaveformInfo {
  /** Path of the peaks JSON relative to the library root. */
  peaksPath: string
}

export interface MediaAsset {
  id: string
  fileName: string
  /** Path of the imported copy relative to the library root. */
  libraryRelPath: string
  contentHash: string
  durationFlicks: number
  video?: VideoInfo
  audio?: AudioInfo
  rating: Rating
  filmstrip?: FilmstripInfo
  waveform?: WaveformInfo
  /** H.264 preview proxy for codecs WebCodecs cannot decode (phase 7). */
  proxyPath?: string
  /** Whisper transcript JSON, cache-relative (phase 10). */
  transcriptPath?: string
}

/** One transcribed word with media-time bounds (phase 10). */
export interface TranscriptWord {
  text: string
  startFlicks: number
  endFlicks: number
  /** Mean token probability 0..1. */
  p: number
}

export interface Transcript {
  words: TranscriptWord[]
}

export interface Event {
  id: string
  name: string
  assetIds: string[]
  projectIds: string[]
}

/** The real magnetic-timeline sequence (phase 4 kernel). */
export type { Sequence } from './timeline/model'
import type { Sequence } from './timeline/model'

export interface Project {
  id: string
  name: string
  sequence: Sequence
}

export interface Library {
  id: string
  name: string
  /** Absolute path of the .mglib folder on disk. */
  path: string
  events: Event[]
}

/** What the renderer sees. Cache artifacts are exposed as mfile:// URLs. */
export interface AssetView extends Omit<MediaAsset, 'filmstrip' | 'waveform'> {
  filmstrip?: FilmstripInfo & { url: string }
  waveform?: WaveformInfo & { url: string }
  /** mfile:// URL of the imported media file itself. */
  mediaUrl: string
  /** mfile:// URL of the preview proxy, when one has been generated. */
  proxyUrl?: string
  /** mfile:// URL of the transcript JSON, when transcription has finished. */
  transcriptUrl?: string
  /** True when the imported media file is gone from disk (needs relinking). */
  missing: boolean
}

export interface LibrarySnapshot {
  id: string
  name: string
  path: string
  events: Event[]
  assets: Record<string, AssetView>
}

export interface ImportError {
  file: string
  reason: string
}

export interface ImportResult {
  importedIds: string[]
  errors: ImportError[]
}
