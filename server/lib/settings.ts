// Settings stored one key per row, read as one merged object, cached for 5 s. Owned by the scaffold.
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  deepMerge,
  mergeSettings,
  SettingsSchema,
  type Settings,
  type SettingsKey,
} from '../../shared/settings.ts'
import { getDb, type Db } from '../db/client.ts'
import { settings as settingsTable } from '../db/schema.ts'
import { badRequest, zodMessage } from './http.ts'

export const SETTINGS_CACHE_MS = 5_000

interface CacheEntry {
  at: number
  value: Settings
}

// One entry per database instance. The app has one; tests make a few short-lived ones.
const cache = new Map<Db, CacheEntry>()

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read all rows and merge them onto the defaults. Rows with bad values fall back to defaults. */
export async function loadSettings(db: Db = getDb()): Promise<Settings> {
  const rows = await db.select().from(settingsTable)
  const stored: Record<string, unknown> = {}
  for (const row of rows) {
    if ((SETTINGS_KEYS as string[]).includes(row.key)) stored[row.key] = row.value
  }
  try {
    return mergeSettings(stored)
  } catch {
    // One bad row should not take the app down: keep the keys that parse, default the rest.
    const safe: Record<string, unknown> = {}
    for (const key of SETTINGS_KEYS) {
      if (!(key in stored)) continue
      const candidate = deepMerge(DEFAULT_SETTINGS, { [key]: stored[key] })
      if (SettingsSchema.safeParse(candidate).success) safe[key] = stored[key]
    }
    return mergeSettings(safe)
  }
}

/** Current settings, cached for 5 seconds per database. */
export async function getSettings(db: Db = getDb()): Promise<Settings> {
  const hit = cache.get(db)
  const now = Date.now()
  if (hit && now - hit.at < SETTINGS_CACHE_MS) return hit.value
  const value = await loadSettings(db)
  cache.set(db, { at: now, value })
  return value
}

/** Drop the cache for one database, or for all when none is given. */
export function invalidateSettingsCache(db?: Db): void {
  if (db) cache.delete(db)
  else cache.clear()
}

/**
 * Validate and store a partial update. Nested objects merge (so { channels: { mail: true } } keeps
 * the other channels), arrays replace. Unknown keys are a 400. Returns the full new settings.
 */
export async function updateSettings(partial: unknown, db: Db = getDb()): Promise<Settings> {
  if (!isPlainObject(partial)) throw badRequest('Settings update must be an object', 'VALIDATION')
  const unknown = Object.keys(partial).filter((k) => !(SETTINGS_KEYS as string[]).includes(k))
  if (unknown.length > 0) {
    throw badRequest(`Unknown setting: ${unknown.join(', ')}`, 'VALIDATION')
  }
  const current = await loadSettings(db)
  const parsed = SettingsSchema.safeParse(deepMerge(current, partial))
  if (!parsed.success) {
    throw badRequest(`Invalid settings: ${zodMessage(parsed.error)}`, 'VALIDATION')
  }
  const next = parsed.data

  for (const key of Object.keys(partial) as SettingsKey[]) {
    await upsertSetting(db, key, next[key])
  }
  cache.set(db, { at: Date.now(), value: next })
  return next
}

async function upsertSetting(db: Db, key: SettingsKey, value: unknown): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
}

/** Make sure settings.webhook_secret exists. Called once on boot. Returns the secret. */
export async function ensureWebhookSecret(db: Db = getDb()): Promise<string> {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'webhook_secret'))
  const existing = rows[0]?.value
  if (typeof existing === 'string' && existing.length >= 16) return existing
  const secret = randomBytes(24).toString('hex')
  await upsertSetting(db, 'webhook_secret', secret)
  cache.delete(db)
  return secret
}
