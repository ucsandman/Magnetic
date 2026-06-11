import { z } from 'zod'

export { IPC } from './channels'

export const binaryProbeResultSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  firstLine: z.string()
})
export type BinaryProbeResult = z.infer<typeof binaryProbeResultSchema>

export const diagBinariesResultSchema = z.object({
  ffprobe: binaryProbeResultSchema,
  whisper: binaryProbeResultSchema
})
export type DiagBinariesResult = z.infer<typeof diagBinariesResultSchema>

export const ratingSchema = z.enum(['none', 'favorite', 'rejected'])

export const importPathsPayloadSchema = z.object({
  paths: z.array(z.string().min(1)).min(1)
})
export type ImportPathsPayload = z.infer<typeof importPathsPayloadSchema>

export const setRatingPayloadSchema = z.object({
  assetId: z.string().min(1),
  rating: ratingSchema
})
export type SetRatingPayload = z.infer<typeof setRatingPayloadSchema>

const rationalSchema = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive()
})

const clipFxSchema = z.object({
  posX: z.number(),
  posY: z.number(),
  scale: z.number(),
  rotation: z.number(),
  opacity: z.number(),
  // phase-8 color board + audio params; defaults keep older saved fx valid
  exposure: z.number().default(0),
  contrast: z.number().default(1),
  saturation: z.number().default(1),
  temperature: z.number().default(0),
  fadeInFlicks: z.number().default(0),
  fadeOutFlicks: z.number().default(0),
  volumeDb: z.number().default(0),
  pan: z.number().default(0)
})

const titleDataSchema = z.object({
  text: z.string(),
  font: z.string(),
  sizePx: z.number(),
  color: z.string(),
  x: z.number(),
  y: z.number(),
  preset: z.enum(['basic', 'lowerThird', 'bumper'])
})

const transitionSchema = z.object({
  id: z.string().min(1),
  afterClipId: z.string().min(1),
  durationFlicks: z.number().positive(),
  kind: z.enum(['dissolve', 'wipeL', 'wipeR', 'fadeBlack'])
})

const spineClipSchema = z.object({
  kind: z.literal('clip'),
  id: z.string().min(1),
  assetId: z.string().min(1),
  mediaInFlicks: z.number().nonnegative(),
  durationFlicks: z.number().positive(),
  sourceDurationFlicks: z.number().positive(),
  fx: clipFxSchema.optional()
})

const gapClipSchema = z.object({
  kind: z.literal('gap'),
  id: z.string().min(1),
  durationFlicks: z.number().positive()
})

const connectedClipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  parentClipId: z.string().min(1),
  offsetFlicks: z.number(),
  lane: z.number().int(),
  mediaInFlicks: z.number().nonnegative(),
  durationFlicks: z.number().positive(),
  sourceDurationFlicks: z.number().positive(),
  fx: clipFxSchema.optional(),
  titleData: titleDataSchema.optional()
})

export const sequenceSchema = z.object({
  id: z.string().min(1),
  fps: rationalSchema,
  spine: z.array(z.discriminatedUnion('kind', [spineClipSchema, gapClipSchema])),
  connected: z.array(connectedClipSchema),
  transitions: z.array(transitionSchema).optional()
})

export const saveSequencePayloadSchema = z.object({
  projectId: z.string().min(1),
  sequence: sequenceSchema
})
export type SaveSequencePayload = z.infer<typeof saveSequencePayloadSchema>

export const assetIdPayloadSchema = z.object({ assetId: z.string().min(1) })

export interface MemoryUsage {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
}

/** The typed API exposed to the renderer via contextBridge as `window.api`. */
export interface MagneticApi {
  diagBinaries(): Promise<DiagBinariesResult>
  getLibrary(): Promise<import('./types').LibrarySnapshot>
  /** Open the OS file picker (main process) and import the chosen files. */
  importDialog(): Promise<import('./types').ImportResult>
  importPaths(paths: string[]): Promise<import('./types').ImportResult>
  setAssetRating(assetId: string, rating: z.infer<typeof ratingSchema>): Promise<void>
  /** Default project (created on first call), including its persisted sequence. */
  getProject(): Promise<import('./types').Project>
  saveSequence(projectId: string, sequence: import('./types').Sequence): Promise<void>
  /** Extract (once) and return the asset's PCM wav URL; null when it has no audio. */
  ensurePcm(assetId: string): Promise<string | null>
  /** Transcode (once) and return the asset's H.264 preview proxy URL. */
  ensureProxy(assetId: string): Promise<string>
  /** Main-process memory usage (playback stability E2E). */
  diagMemory(): Promise<MemoryUsage>
  /** Native save dialog; null when cancelled. */
  exportPickDestination(): Promise<string | null>
  exportStart(args: {
    destination: string
    width: number
    height: number
    fps: { num: number; den: number }
    scaleTo: { width: number; height: number } | null
    wav: ArrayBuffer
  }): Promise<void>
  /** One rawvideo RGBA frame; resolves after ffmpeg's stdin accepted it. */
  exportFrame(frame: ArrayBuffer): Promise<void>
  /** Close the pipe, await ffmpeg, atomic-rename `.part` → destination. */
  exportFinish(): Promise<void>
  exportCancel(): Promise<void>
  /** Queue (or re-queue) transcription of an asset with audio. */
  transcribeAsset(assetId: string): Promise<void>
  getSettings(): Promise<{ autoTranscribe: boolean }>
  setSettings(settings: { autoTranscribe: boolean }): Promise<void>
  /** Relink a missing asset via the OS file picker (duration must match). */
  relinkAsset(assetId: string): Promise<void>
  onLibraryChanged(cb: (snapshot: import('./types').LibrarySnapshot) => void): () => void
  /** Edit menu Undo/Redo clicks pushed from main. */
  onEditCommand(cb: (command: 'undo' | 'redo') => void): () => void
  /** Tell main whether undo/redo are currently possible (menu enablement). */
  notifyEditState(state: { canUndo: boolean; canRedo: boolean }): void
  /** Resolve the on-disk path of a dragged-in File (webUtils). */
  pathForFile(file: File): string
  /** Present only when the app runs with MAGNETIC_TEST=1. */
  __test?: {
    importPaths(paths: string[]): Promise<import('./types').ImportResult>
    relinkPath(assetId: string, path: string): Promise<void>
  }
}
