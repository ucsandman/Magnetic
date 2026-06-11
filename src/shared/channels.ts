/**
 * IPC channel names, dependency-free on purpose: the sandboxed preload cannot
 * require node_modules (e.g. zod), so it imports channels from here and only
 * type-imports from ipc.ts. Every channel handled in main must validate its
 * payload with the zod schemas in ipc.ts.
 */
export const IPC = {
  diagBinaries: 'diag:binaries'
} as const
