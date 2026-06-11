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
  projectGet: 'project:get',
  projectSaveSequence: 'project:saveSequence',
  /** main -> renderer push: full library snapshot after any change */
  libraryChanged: 'library:changed',
  /** Registered only when MAGNETIC_TEST=1 (see ipc.ts registerIpc). */
  testImportPaths: 'test:importPaths'
} as const
