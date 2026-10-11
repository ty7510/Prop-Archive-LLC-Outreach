import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { createTestDb, type Db } from '../db/client.ts'
import { settings as settingsTable } from '../db/schema.ts'
import { HttpError } from './http.ts'
import {
  ensureWebhookSecret,
  getSettings,
  invalidateSettingsCache,
  loadSettings,
  updateSettings,
} from './settings.ts'

let db: Db

beforeEach(async () => {
  db = await createTestDb()
})

describe('getSettings', () => {
  it('returns defaults on an empty database', async () => {
    expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('caches for a few seconds and refreshes after invalidate', async () => {
    const a = await getSettings(db)
    await db.insert(settingsTable).values({ key: 'owner_name', value: 'Someone Else' })
    const b = await getSettings(db)
    expect(b).toBe(a) // same cached object
    invalidateSettingsCache(db)
    const c = await getSettings(db)
    expect(c.owner_name).toBe('Someone Else')
  })

  it('falls back to defaults for a bad stored value', async () => {
    await db.insert(settingsTable).values({ key: 'min_props', value: 'not a number' })
    await db.insert(settingsTable).values({ key: 'owner_name', value: 'Kept' })
    const s = await loadSettings(db)
    expect(s.min_props).toBe(DEFAULT_SETTINGS.min_props)
    expect(s.owner_name).toBe('Kept')
  })
})

describe('updateSettings', () => {
  it('stores and returns the merged settings', async () => {
    const s = await updateSettings({ owner_name: 'Theo', min_props: 4 }, db)
    expect(s.owner_name).toBe('Theo')
    expect(s.min_props).toBe(4)
    expect(s.live_mode).toBe(false)
    const rows = await db.select().from(settingsTable)
    expect(rows.map((r) => r.key).sort()).toEqual(['min_props', 'owner_name'])
    expect(await getSettings(db)).toEqual(s)
  })

  it('merges nested objects instead of replacing them', async () => {
    const s = await updateSettings({ channels: { mail: true } }, db)
    expect(s.channels).toEqual({ ...DEFAULT_SETTINGS.channels, mail: true })
    const s2 = await updateSettings({ daily_caps: { email: 5 } }, db)
    expect(s2.daily_caps.email).toBe(5)
    expect(s2.daily_caps.call).toBe(DEFAULT_SETTINGS.daily_caps.call)
    expect(s2.channels.mail).toBe(true)
  })

  it('replaces arrays', async () => {
    const s = await updateSettings({ target_zips: ['19146'] }, db)
    expect(s.target_zips).toEqual(['19146'])
  })

  it('rejects unknown keys with a 400', async () => {
    await expect(updateSettings({ nope: 1 }, db)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION',
    })
  })

  it('rejects bad values with a 400 and keeps the old value', async () => {
    await updateSettings({ min_icp_score: 60 }, db)
    const err = await updateSettings({ min_icp_score: 500 }, db).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).message).toContain('min_icp_score')
    expect((await getSettings(db)).min_icp_score).toBe(60)
  })

  it('rejects a non-object', async () => {
    await expect(updateSettings('x', db)).rejects.toMatchObject({ status: 400 })
  })
})

describe('ensureWebhookSecret', () => {
  it('creates a secret once and keeps it', async () => {
    const a = await ensureWebhookSecret(db)
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    const b = await ensureWebhookSecret(db)
    expect(b).toBe(a)
    expect((await getSettings(db)).webhook_secret).toBe(a)
  })
})
