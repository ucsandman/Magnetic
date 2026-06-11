import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      include: ['src/shared/timeline/**'],
      exclude: ['src/shared/timeline/testing.ts', 'src/shared/timeline/**/*.test.ts']
    }
  }
})
