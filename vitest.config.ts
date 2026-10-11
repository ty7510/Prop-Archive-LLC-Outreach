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
    // Keep parallel test servers from exhausting small Replit runners.
    maxWorkers: 2,
    environment: 'node',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.ts'],
    globals: true,
    env: {
      NODE_ENV: 'test',
      APP_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret-that-is-long-enough',
      DATABASE_URL: 'file::memory:',
    },
  },
})
