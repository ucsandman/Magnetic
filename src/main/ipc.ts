import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { z } from 'zod'
import {
  assetIdPayloadSchema,
  importPathsPayloadSchema,
  saveSequencePayloadSchema,
  setRatingPayloadSchema,
  type BinaryProbeResult,
  type DiagBinariesResult,
  type MemoryUsage
} from '../shared/ipc'
import { IPC } from '../shared/channels'
import type { ImportResult, LibrarySnapshot, Project, Sequence } from '../shared/types'
import { ffprobePath, whisperPath } from './binaries'

/**
 * Register an invoke handler whose payload is validated with zod before the
 * handler body runs. Malformed payloads reject the invoke with a clear error.
 */
function handleValidated<S extends z.ZodType, R>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>) => Promise<R>
): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new Error(`Invalid payload for ${channel}: ${parsed.error.message}`)
    }
    return fn(parsed.data)
  })
}

function probeBinary(command: string, args: string[]): Promise<BinaryProbeResult> {
  return new Promise((resolve) => {
    if (!existsSync(command)) {
      resolve({ ok: false, exitCode: null, firstLine: `not found: ${command}` })
      return
    }
    const child = spawn(command, args, { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', (err) => {
      resolve({ ok: false, exitCode: null, firstLine: String(err) })
    })
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        firstLine: output.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
      })
    })
  })
}

async function diagBinaries(): Promise<DiagBinariesResult> {
  const [ffprobe, whisper] = await Promise.all([
    probeBinary(ffprobePath(), ['-version']),
    probeBinary(whisperPath(), ['--help'])
  ])
  return { ffprobe, whisper }
}

export interface IpcDeps {
  getSnapshot(): LibrarySnapshot
  importPaths(paths: string[]): Promise<ImportResult>
  importDialog(): Promise<ImportResult>
  setRating(assetId: string, rating: 'none' | 'favorite' | 'rejected'): void
  getProject(): Project
  saveSequence(projectId: string, sequence: Sequence): void
  ensurePcm(assetId: string): Promise<string | null>
  ensureProxy(assetId: string): Promise<string>
  transcribe(assetId: string): void
  getSettings(): { autoTranscribe: boolean }
  setSettings(settings: { autoTranscribe: boolean }): void
  relink(assetId: string): Promise<void>
  relinkPath(assetId: string, path: string): Promise<void>
}

export function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAGNETIC_TEST === '1'
}

export function registerIpc(deps: IpcDeps, env: NodeJS.ProcessEnv = process.env): void {
  handleValidated(IPC.diagBinaries, z.undefined(), () => diagBinaries())

  handleValidated(IPC.libraryGet, z.undefined(), async () => deps.getSnapshot())

  handleValidated(IPC.libraryImportPaths, importPathsPayloadSchema, async (payload) =>
    deps.importPaths(payload.paths)
  )

  handleValidated(IPC.libraryImportDialog, z.undefined(), async () => deps.importDialog())

  handleValidated(IPC.assetSetRating, setRatingPayloadSchema, async (payload) => {
    deps.setRating(payload.assetId, payload.rating)
  })

  handleValidated(IPC.projectGet, z.undefined(), async () => deps.getProject())

  handleValidated(IPC.projectSaveSequence, saveSequencePayloadSchema, async (payload) => {
    deps.saveSequence(payload.projectId, payload.sequence)
  })

  handleValidated(IPC.mediaEnsurePcm, assetIdPayloadSchema, (payload) =>
    deps.ensurePcm(payload.assetId)
  )

  handleValidated(IPC.transcribeRun, assetIdPayloadSchema, async (payload) => {
    deps.transcribe(payload.assetId)
  })

  handleValidated(IPC.settingsGet, z.undefined(), async () => deps.getSettings())

  handleValidated(IPC.settingsSet, z.object({ autoTranscribe: z.boolean() }), async (payload) => {
    deps.setSettings(payload)
  })

  handleValidated(IPC.mediaEnsureProxy, assetIdPayloadSchema, (payload) =>
    deps.ensureProxy(payload.assetId)
  )

  handleValidated(IPC.diagMemory, z.undefined(), async (): Promise<MemoryUsage> => {
    const usage = process.memoryUsage()
    return {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external
    }
  })

  handleValidated(IPC.relinkAsset, assetIdPayloadSchema, (payload) => deps.relink(payload.assetId))

  // Test-only surface — never registered outside MAGNETIC_TEST=1.
  if (isTestMode(env)) {
    handleValidated(IPC.testImportPaths, importPathsPayloadSchema, async (payload) =>
      deps.importPaths(payload.paths)
    )
    handleValidated(
      IPC.testRelinkPath,
      z.object({ assetId: z.string().min(1), path: z.string().min(1) }),
      (payload) => deps.relinkPath(payload.assetId, payload.path)
    )
  }
}
