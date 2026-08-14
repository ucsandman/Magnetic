import { dialog, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { marketingHandoffWritePayloadSchema } from '../../shared/ipc'

/**
 * Marketing handoff bundle writer. The renderer drives the movie export the
 * same way the normal File → Export does (WebGL frame replay / smart-render
 * over the existing export IPC), producing <destDir>/video.mp4, then serializes
 * the caption cues. This handler writes the three remaining sidecars —
 * captions.srt, captions.vtt, and segments.json (last) — into destDir.
 *
 * segments.json is emitted verbatim per the pipeline contract: version 1,
 * fixed video/captions filenames, numeric fps from the sequence settings, and
 * exportedAt stamped from the main-process clock. The zero-segments invariant
 * is re-checked here (defense in depth) even though the dialog disables the
 * option when deriveSegments is empty.
 */
export function registerMarketingHandoffIpc(): void {
  ipcMain.handle(IPC.marketingHandoffPickDir, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Marketing Handoff — choose destination folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })

  ipcMain.handle(IPC.marketingHandoffWrite, async (_event, payload: unknown) => {
    const parsed = marketingHandoffWritePayloadSchema.safeParse(payload)
    if (!parsed.success)
      throw new Error(`Invalid marketing handoff payload: ${parsed.error.message}`)
    const { destDir, fps, segments, srt, vtt } = parsed.data
    if (segments.length === 0) {
      throw new Error('Marketing handoff needs at least one "clip:" segment marker')
    }

    writeFileSync(join(destDir, 'captions.srt'), srt, 'utf8')
    writeFileSync(join(destDir, 'captions.vtt'), vtt, 'utf8')

    const manifest = {
      version: 1,
      video: 'video.mp4',
      captions: 'captions.srt',
      fps: fps.num / fps.den,
      exportedAt: new Date().toISOString(),
      segments
    }
    writeFileSync(join(destDir, 'segments.json'), JSON.stringify(manifest, null, 2), 'utf8')

    return { segments: segments.length }
  })
}
