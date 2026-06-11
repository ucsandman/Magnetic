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

/** The typed API exposed to the renderer via contextBridge as `window.api`. */
export interface MagneticApi {
  diagBinaries(): Promise<DiagBinariesResult>
}
