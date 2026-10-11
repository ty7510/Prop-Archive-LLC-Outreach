// Boot: .env -> env -> db + migrations -> seed on first boot -> app -> listen -> autopilot.
// Owned by the scaffold.
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { createApp } from './app.ts'
import { modules } from './contracts.ts'
import { applyMigrations, ephemeralDbProblem, getDb, resolveDatabaseConfig } from './db/client.ts'
import { settings as settingsTable } from './db/schema.ts'
import { env, isProduction, presentProviders } from './env.ts'
import { logActivity } from './lib/activity.ts'
import { ensureWebhookSecret } from './lib/settings.ts'
import { nowIso } from './lib/time.ts'
import { seed } from './seed/index.ts'
// Builders register their modules by importing these. Stubs register nothing.
import './sources/index.ts'
import './enrich/index.ts'
import './outreach/index.ts'
import './autopilot/index.ts'

const SEEDED_KEY = '_seeded_at'

async function seedOnFirstBoot(): Promise<void> {
  const db = getDb()
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, SEEDED_KEY))
  if (rows.length > 0) return
  const result = await seed(db)
  await db.insert(settingsTable).values({ key: SEEDED_KEY, value: nowIso() })
  await logActivity('info', 'seed', result)
}

async function main(): Promise<void> {
  const dbConfig = resolveDatabaseConfig()
  if (dbConfig.ignored) console.warn(`[boot] ${dbConfig.ignored}`)
  const dbProblem = ephemeralDbProblem(dbConfig.url)
  if (dbProblem) {
    console.error(`[boot] ${dbProblem}`)
    process.exit(1)
  }
  if (!env.APP_PASSWORD) {
    console.warn('[boot] APP_PASSWORD is not set. Nobody can log in until you add it to .env.')
  }

  const db = getDb()
  await applyMigrations(db)
  await ensureWebhookSecret(db)
  await seedOnFirstBoot()

  const app = createApp(db)
  const server = app.listen(env.PORT, () => {
    const providers = presentProviders()
    const on = Object.entries(providers)
      .filter(([, v]) => v)
      .map(([k]) => k)
    console.log(
      `[boot] outreach listening on http://localhost:${env.PORT} (${env.NODE_ENV})` +
        (isProduction ? '' : `; client dev server proxies /api here`),
    )
    console.log(`[boot] providers with keys: ${on.length ? on.join(', ') : 'none'}`)
    console.log(`[boot] autopilot module: ${modules.autopilot ? 'registered' : 'not built yet'}`)
  })

  modules.autopilot?.start()

  const shutdown = (signal: string) => {
    console.log(`[boot] ${signal} received, shutting down`)
    modules.autopilot?.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[boot] failed to start', err)
  process.exit(1)
})
