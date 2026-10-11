import { defineConfig } from 'drizzle-kit'
import { resolveDatabaseUrl } from './server/db/url.ts'

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: resolveDatabaseUrl(process.env.DATABASE_URL),
  },
  strict: true,
  verbose: true,
})
