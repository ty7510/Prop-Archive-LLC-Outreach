import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { createTestDb, setDefaultDb, type Db } from '../db/client.ts'
import { leads } from '../db/schema.ts'
import { upsertCandidate } from './upsert.ts'

const opts = (db: Db) => ({ db, settings: DEFAULT_SETTINGS, now: new Date('2026-10-11T15:00:00Z') })

describe('upsertCandidate dedupe key', () => {
  let db: Db
  beforeEach(async () => {
    db = await createTestDb()
    setDefaultDb(db)
  })

  it('a lead keyed by email takes the street|zip key once it learns its address, so public records merge', async () => {
    const csv = await upsertCandidate(
      { source: 'csv', full_name: 'Ray Patel', email: 'ray@example.com' },
      opts(db),
    )
    expect(csv.outcome).toBe('created')
    let [ray] = await db.select().from(leads)
    expect(ray!.dedupe_key).toBe('ray@example.com')

    const withAddress = await upsertCandidate(
      {
        source: 'csv',
        email: 'ray@example.com',
        mailing_street: '123 Main St',
        mailing_zip: '19103',
      },
      opts(db),
    )
    expect(withAddress.outcome).toBe('merged')
    ;[ray] = await db.select().from(leads)
    expect(ray!.mailing_street).toBe('123 Main St')
    expect(ray!.dedupe_key).toContain('|19103')

    const opa = await upsertCandidate(
      {
        source: 'opa',
        full_name: 'PATEL RAY',
        mailing_street: '123 MAIN ST',
        mailing_zip: '19103',
        property_count: 4,
      },
      opts(db),
    )
    expect(opa.outcome).toBe('merged')
    expect(opa.lead_id).toBe(ray!.id)
    expect(await db.select().from(leads)).toHaveLength(1)
  })

  it('an address another lead already holds wins the merge; the email-only lead keeps its key', async () => {
    await upsertCandidate(
      { source: 'opa', full_name: 'Other Owner', mailing_street: '9 Oak St', mailing_zip: '19104' },
      opts(db),
    )
    await upsertCandidate({ source: 'csv', full_name: 'Sam', email: 'sam@example.com' }, opts(db))
    const r = await upsertCandidate(
      { source: 'csv', email: 'sam@example.com', mailing_street: '9 Oak St', mailing_zip: '19104' },
      opts(db),
    )
    expect(r.outcome).toBe('merged')
    const rows = await db.select().from(leads)
    expect(rows).toHaveLength(2)
    const sam = rows.find((l) => l.full_name === 'Sam')
    expect(sam!.dedupe_key).toBe('sam@example.com')
    const other = rows.find((l) => l.full_name === 'Other Owner')
    expect(other!.dedupe_key).toBe('9 OAK ST|19104')
  })
})
