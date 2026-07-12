/**
 * IPC channel names, dependency-free on purpose: the sandboxed preload cannot
 * require node_modules (e.g. zod), so it imports channels from here and only
 * type-imports from ipc.ts. Every channel handled in main must validate its
 * payload with the zod schemas in ipc.ts.
 */
export const IPC = {
  diagBinaries: 'diag:binaries',
  libraryGet: 'library:get',
  libraryImportPaths: 'library:importPaths',
  libraryImportDialog: 'library:importDialog',
  assetSetRating: 'asset:setRating',
  assetDelete: 'asset:delete',
  projectGet: 'project:get',
  projectSaveSequence: 'project:saveSequence',
  mediaEnsurePcm: 'media:ensurePcm',
  mediaEnsureProxy: 'media:ensureProxy',
  mediaDenoise: 'media:denoise',
  diagMemory: 'diag:memory',
  exportPickDestination: 'export:pickDestination',
  exportStart: 'export:start',
  exportFrame: 'export:frame',
  exportFinish: 'export:finish',
  exportCancel: 'export:cancel',
  smartExportStart: 'smartExport:start',
  smartExportAudioChunk: 'smartExport:audioChunk',
  smartExportMux: 'smartExport:mux',
  smartExportCancel: 'smartExport:cancel',
  /** main -> renderer push: ffmpeg -progress out_time during the copy/mux phase */
  smartExportProgress: 'smartExport:progress',
  transcribeRun: 'transcribe:run',
  captionsPickDestination: 'captions:pickDestination',
  captionsWriteSidecar: 'captions:writeSidecar',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** main -> renderer push: full library snapshot after any change */
  libraryChanged: 'library:changed',
  /** main -> renderer push: Edit menu command ('undo' | 'redo') */
  editCommand: 'edit:command',
  /** renderer -> main notify: undo/redo availability for menu enablement */
  editStateChanged: 'edit:stateChanged',
  relinkAsset: 'asset:relink',
  /** Registered only when MAGNETIC_TEST=1 (see ipc.ts registerIpc). */
  testImportPaths: 'test:importPaths',
  testRelinkPath: 'test:relinkPath'
} as const
