import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Same rule as server/db/client.ts: Replit's Postgres DATABASE_URL is not ours.
    url:
      process.env.OUTREACH_DATABASE_URL ||
      (/^(file|libsql|https?|wss?):/i.test(process.env.DATABASE_URL ?? '')
        ? process.env.DATABASE_URL!
        : 'file:./data/outreach.db'),
  },
  strict: true,
  verbose: true,
})
