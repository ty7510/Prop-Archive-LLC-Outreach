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
    environment: 'node',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
    globals: true,
    env: {
      NODE_ENV: 'test',
      APP_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret-that-is-long-enough',
      DATABASE_URL: 'file::memory:',
    },
  },
})
