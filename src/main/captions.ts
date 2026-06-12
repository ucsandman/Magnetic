import { dialog, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { IPC } from '../shared/channels'
import {
  captionsPickDestinationPayloadSchema,
  captionsWriteSidecarPayloadSchema
} from '../shared/ipc'

/**
 * Caption sidecar export: the renderer serializes the current cues to SRT/VTT
 * and main only picks a destination (native save dialog) and writes the text.
 */

export function registerCaptionsIpc(): void {
  ipcMain.handle(IPC.captionsPickDestination, async (_event, payload: unknown) => {
    const parsed = captionsPickDestinationPayloadSchema.safeParse(payload)
    if (!parsed.success) throw new Error(`Invalid sidecar request: ${parsed.error.message}`)
    const format = parsed.data.format
    const picked = await dialog.showSaveDialog({
      title: format === 'srt' ? 'Export SRT Captions' : 'Export VTT Captions',
      defaultPath: `captions.${format}`,
      filters: [
        format === 'srt'
          ? { name: 'SubRip Subtitles', extensions: ['srt'] }
          : { name: 'WebVTT Subtitles', extensions: ['vtt'] }
      ]
    })
    return picked.canceled ? null : picked.filePath
  })

  ipcMain.handle(IPC.captionsWriteSidecar, async (_event, payload: unknown) => {
    const parsed = captionsWriteSidecarPayloadSchema.safeParse(payload)
    if (!parsed.success) throw new Error(`Invalid sidecar payload: ${parsed.error.message}`)
    writeFileSync(parsed.data.destination, parsed.data.content, 'utf8')
  })
}
