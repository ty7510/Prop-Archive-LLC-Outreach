import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': `${here}shared`,
    },
  },
  test: {
    maxWorkers: 2,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['server/db/testSetup.ts'],
    environment: 'node',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.ts'],
    globals: true,
    env: {
      NODE_ENV: 'test',
      APP_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    },
  },
})
