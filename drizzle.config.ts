import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'
import { resolveDatabaseConfig } from './server/db/client.ts'

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle/postgres',
  dbCredentials: { url: resolveDatabaseConfig().url },
  strict: false,
})
