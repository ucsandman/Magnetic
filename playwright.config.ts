import { defineConfig } from '@playwright/test'

/**
 * E2E runs against the BUILT app (out/main/index.js) — run `npm run build`
 * before `npm run test:e2e`. One worker: a single Electron instance at a time.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
