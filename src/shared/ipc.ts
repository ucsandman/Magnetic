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

/** The typed API exposed to the renderer via contextBridge as `window.api`. */
export interface MagneticApi {
  diagBinaries(): Promise<DiagBinariesResult>
  getLibrary(): Promise<import('./types').LibrarySnapshot>
  /** Open the OS file picker (main process) and import the chosen files. */
  importDialog(): Promise<import('./types').ImportResult>
  importPaths(paths: string[]): Promise<import('./types').ImportResult>
  setAssetRating(assetId: string, rating: z.infer<typeof ratingSchema>): Promise<void>
  onLibraryChanged(cb: (snapshot: import('./types').LibrarySnapshot) => void): () => void
  /** Resolve the on-disk path of a dragged-in File (webUtils). */
  pathForFile(file: File): string
  /** Present only when the app runs with MAGNETIC_TEST=1. */
  __test?: {
    importPaths(paths: string[]): Promise<import('./types').ImportResult>
  }
}
