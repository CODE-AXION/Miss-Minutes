import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Unit tests for the pure shared modules (SS·T3); the alias mirrors electron.vite.config.ts.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
