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

const keyframeSchema = z.object({
  atMediaFlicks: z.number(),
  value: z.number(),
  ease: z.enum(['linear', 'easeInOut'])
})

const animatableParamSchema = z.enum([
  'posX',
  'posY',
  'scale',
  'rotation',
  'opacity',
  'exposure',
  'contrast',
  'saturation',
  'temperature'
])

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
  pan: z.number().default(0),
  // keyframe animation tracks (z.object strips unknown keys, so kf must be declared)
  kf: z.partialRecord(animatableParamSchema, z.array(keyframeSchema)).optional(),
  duck: z
    .object({
      ranges: z.array(
        z.object({ fromClipFlicks: z.number().nonnegative(), toClipFlicks: z.number().positive() })
      ),
      amountDb: z.number()
    })
    .optional()
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

const clipRoleSchema = z.enum(['dialogue', 'music', 'sfx'])

const markerSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  atMediaFlicks: z.number().nonnegative(),
  text: z.string(),
  color: z.enum(['blue', 'green', 'orange', 'red'])
})

const spineClipSchema = z.object({
  kind: z.literal('clip'),
  id: z.string().min(1),
  assetId: z.string().min(1),
  mediaInFlicks: z.number().nonnegative(),
  durationFlicks: z.number().positive(),
  sourceDurationFlicks: z.number().positive(),
  fx: clipFxSchema.optional(),
  /** Detach Audio: video-only spine clip; its audio lives in a lane −1 connected clip. */
  audioDisabled: z.boolean().optional(),
  role: clipRoleSchema.optional()
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
  titleData: titleDataSchema.optional(),
  audioDisabled: z.boolean().optional(),
  /** Loop-to-fill music bed (z.object strips unknown keys — must be declared). */
  loop: z.boolean().optional(),
  role: clipRoleSchema.optional()
})

const captionSettingsSchema = z.object({
  enabled: z.boolean(),
  preset: z.enum(['pop-in', 'karaoke', 'block']),
  font: z.string(),
  sizePx: z.number().positive(),
  color: z.string(),
  highlightColor: z.string(),
  position: z.enum(['bottom', 'middle', 'top'])
})

export const sequenceSchema = z.object({
  id: z.string().min(1),
  fps: rationalSchema,
  spine: z.array(z.discriminatedUnion('kind', [spineClipSchema, gapClipSchema])),
  connected: z.array(connectedClipSchema),
  transitions: z.array(transitionSchema).optional(),
  // z.object strips unknown keys on the saveSequence round-trip, so every
  // sequence-level field MUST be declared here or it is silently lost
  captions: captionSettingsSchema.optional(),
  mutedRoles: z.array(clipRoleSchema).optional(),
  markers: z.array(markerSchema).optional()
})

export const saveSequencePayloadSchema = z.object({
  projectId: z.string().min(1),
  sequence: sequenceSchema
})
export type SaveSequencePayload = z.infer<typeof saveSequencePayloadSchema>

export const assetIdPayloadSchema = z.object({ assetId: z.string().min(1) })

export const captionsPickDestinationPayloadSchema = z.object({
  format: z.enum(['srt', 'vtt'])
})

export const captionsWriteSidecarPayloadSchema = z.object({
  destination: z.string().min(1),
  content: z.string()
})

/** One derived marketing-handoff segment (mirrors shared/timeline/segments.ts). */
const handoffSegmentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive()
})

/**
 * Marketing handoff sidecar write: the renderer has already produced
 * <destDir>/video.mp4 via the normal export round-trip and serialized the
 * caption cues. Main writes captions.srt/vtt + segments.json (stamping
 * exportedAt from its own clock) and re-checks the zero-segments invariant.
 */
export const marketingHandoffWritePayloadSchema = z.object({
  destDir: z.string().min(1),
  fps: rationalSchema,
  segments: z.array(handoffSegmentSchema),
  srt: z.string(),
  vtt: z.string()
})
export type MarketingHandoffWritePayload = z.infer<typeof marketingHandoffWritePayloadSchema>
export type MarketingHandoffSegment = z.infer<typeof handoffSegmentSchema>

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
  deleteAsset(assetId: string): Promise<void>
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
  /** Smart render (video passthrough): open the temp mix wav next to the destination. */
  smartExportStart(args: {
    destination: string
    assetId: string
    /** Trim start within the source, seconds (-ss; keyframe-snapped on copy). */
    inSec: number
    /** Trim duration, seconds (-t and the mix length). */
    durSec: number
    sampleRate: number
    channels: number
  }): Promise<void>
  /** One interleaved Int16 PCM chunk; resolves after it hit the wav on disk. */
  smartExportAudioChunk(pcm: ArrayBuffer): Promise<void>
  /** Finalize the wav, stream-copy video + encode audio in one ffmpeg run. */
  smartExportMux(): Promise<void>
  smartExportCancel(): Promise<void>
  /** ffmpeg -progress pushes during the smartExportMux copy phase. */
  onSmartExportProgress(cb: (progress: { outTimeSec: number }) => void): () => void
  /** Queue (or re-queue) transcription of an asset with audio. */
  transcribeAsset(assetId: string): Promise<void>
  /** Queue voice cleanup (denoise); playback prefers the result when done. */
  denoiseAsset(assetId: string): Promise<void>
  /** Measure (cached) integrated loudness in LUFS; null when unmeasurable. */
  audioLoudness(assetId: string): Promise<number | null>
  /** Native save dialog for a caption sidecar; null when cancelled. */
  captionsPickDestination(format: 'srt' | 'vtt'): Promise<string | null>
  /** Write a serialized SRT/VTT sidecar to the given path. */
  captionsWriteSidecar(destination: string, content: string): Promise<void>
  /** Native directory dialog for the marketing handoff bundle; null when cancelled. */
  marketingHandoffPickDir(): Promise<string | null>
  /** Write captions.srt/vtt + segments.json into destDir; returns the segment count. */
  marketingHandoffWrite(args: {
    destDir: string
    fps: { num: number; den: number }
    segments: MarketingHandoffSegment[]
    srt: string
    vtt: string
  }): Promise<{ segments: number }>
  getSettings(): Promise<{
    autoTranscribe: boolean
    anthropicApiKey: string | null
    agentAccess: boolean
    agentToken: string | null
    agentMediaFolders: string[]
    copilotProvider: 'subscription' | 'apiKey' | null
  }>
  setSettings(settings: {
    autoTranscribe?: boolean
    anthropicApiKey?: string | null
    agentAccess?: boolean
    agentToken?: string
    agentMediaFolders?: string[]
    copilotProvider?: 'subscription' | 'apiKey'
  }): Promise<void>
  /** Is the agent sidecar running, on which loopback port, with which token. */
  agentStatus(): Promise<{ running: boolean; port: number | null; token: string | null }>
  /** Native directory dialog to add an Agent Access media folder; null when cancelled. */
  agentFolderPickDialog(): Promise<string | null>
  /** Is the Claude Code CLI installed and resolvable, and which version. */
  copilotCliStatus(): Promise<{ found: boolean; version: string | null }>
  /** External agent tool calls pushed from the sidecar for the gateway to run. */
  onAgentRequest(cb: (request: { id: string; tool: string; input: unknown }) => void): () => void
  /** The gateway's answer for a pushed agent request. */
  agentRespond(id: string, result: unknown): Promise<void>
  /** Copilot tool calls pushed from the turn's loopback server for the executor to run. */
  onCopilotToolRequest(cb: (request: { id: string; tool: string; input: unknown }) => void): () => void
  /** The turn executor's answer for a pushed copilot tool request. */
  copilotToolRespond(id: string, ok: boolean, content: unknown): Promise<void>
  copilotCliTurn(args: {
    turnId: string
    prompt: string
    resumeSessionId: string | null
    tools: { name: string; description: string; inputSchema: unknown }[]
  }): Promise<
    { ok: true; reply: string; sessionId: string | null } | { ok: false; message: string }
  >
  copilotCliCancel(turnId: string): Promise<void>
  onCopilotCliDelta(cb: (delta: { turnId: string; text: string }) => void): () => void
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
