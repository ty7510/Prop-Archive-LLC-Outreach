import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, setDefaultDb, type Db } from '../db/client.ts'
import { activityLog, leads, properties } from '../db/schema.ts'
import { updateSettings } from '../lib/settings.ts'
import type { CartoClient } from './carto.ts'
import { discover } from './discover.ts'
import { liRow, opaRow } from './parsers.test.ts'

const NOW = () => new Date('2026-10-11T15:00:00Z')

/** A Carto stand-in: answers by which table the SQL names. */
function fakeClient(answers: {
  li?: unknown[][]
  owners?: unknown[][]
  sales?: unknown[][]
  fail?: 'li' | 'owners' | 'sales'
}): CartoClient & { sqls: string[] } {
  const queues = {
    li: [...(answers.li ?? [[]])],
    owners: [...(answers.owners ?? [[]])],
    sales: [...(answers.sales ?? [[]])],
  }
  const sqls: string[] = []
  let requests = 0
  return {
    sqls,
    get requests() {
      return requests
    },
    async query<T>(sqlText: string): Promise<T[]> {
      requests++
      sqls.push(sqlText)
      const kind: keyof typeof queues = sqlText.includes('business_licenses')
        ? 'li'
        : sqlText.includes('sale_date >=')
          ? 'sales'
          : 'owners'
      if (answers.fail === kind) throw new Error(`${kind} is down`)
      return (queues[kind].shift() ?? []) as T[]
    },
  }
}

function ownerRows(n: number, start = 0): ReturnType<typeof opaRow>[] {
  const rows: ReturnType<typeof opaRow>[] = []
  for (let i = start; i < start + n; i++) {
    const street = `${100 + i} OWNER ST`
    for (let p = 0; p < 3; p++) {
      rows.push(
        opaRow({
          parcel_number: `${i}-${p}`,
          location: `${p + 1} RENTAL ST`,
          zip_code: p === 0 ? '19143' : '19146',
          owner_1: `OWNER${i} PAT`,
          mailing_street: street,
          key_street: street,
          key_zip: '19143',
          owner_property_count: 3,
          sale_date: '2015-01-01T00:00:00Z',
        }),
      )
    }
  }
  return rows
}

describe('discover', () => {
  let db: Db
  beforeEach(async () => {
    db = await createTestDb()
    setDefaultDb(db)
  })

  it('creates leads from licenses, owners and sales, with properties, score and persona', async () => {
    const client = fakeClient({
      li: [[liRow()]],
      owners: [ownerRows(2)],
      sales: [
        [
          opaRow({
            parcel_number: '0-0',
            owner_1: 'OWNER0 PAT',
            mailing_street: '100 OWNER ST',
            key_street: '100 OWNER ST',
            key_zip: '19143',
            sale_date: '2026-09-20T04:00:00Z',
            sale_price: 250000,
            owner_property_count: null,
          }),
          opaRow({
            parcel_number: 'NEWBUYER',
            owner_1: 'BUYER NEW',
            mailing_street: '9 FRESH ST',
            mailing_zip: '19104',
            key_street: '9 FRESH ST',
            key_zip: '19104',
            sale_date: '2026-10-01T04:00:00Z',
            sale_price: 400000,
            owner_property_count: null,
          }),
        ],
      ],
    })
    const result = await discover({}, { db, client, now: NOW })
    expect(result.created).toBe(4) // licensee + 2 owners + new buyer
    expect(result.merged).toBe(1) // the sale of parcel 0-0 merged into the owner at 100 OWNER ST
    expect(result.skipped).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.requests).toBe(3)
    expect(result.by_source).toEqual({
      li: { created: 1, merged: 0, skipped: 0 },
      opa: { created: 2, merged: 0, skipped: 0 },
      sales: { created: 1, merged: 1, skipped: 0 },
    })
    // Only validated zips and integers reach the SQL.
    for (const q of client.sqls)
      expect(q).toContain("'19104','19121','19122','19139','19143','19146','19125'")

    const all = await db.select().from(leads)
    expect(all).toHaveLength(4)
    const owner0 = all.find((l) => l.dedupe_key === '100 OWNER ST|19143')!
    expect(owner0).toMatchObject({
      source: 'opa',
      full_name: 'Pat Owner0',
      persona: 'maya',
      property_count: 3,
      status: 'new',
      owner_kind: 'person',
    })
    expect(owner0.trigger).toMatchObject({ type: 'recent_sale', date: '2026-09-20' })
    // 3 props +40, all zips in target +25, trigger +20, single family 0, local +5
    expect(owner0.icp_score).toBe(90)
    const props = await db.select().from(properties).where(eq(properties.lead_id, owner0.id))
    expect(props).toHaveLength(3)
    expect(props.map((p) => p.opa_account).sort()).toEqual(['0-0', '0-1', '0-2'])
    // the merged sale filled the sale fields on the parcel we already had
    expect(props.find((p) => p.opa_account === '0-0')?.sale_date).toBe('2015-01-01')

    const licensee = all.find((l) => l.source === 'li')!
    expect(licensee).toMatchObject({
      company: 'Roy Bakal Investments LLC',
      full_name: 'Eyal Takizade',
      owner_kind: 'person',
      persona: 'maya',
      property_count: 1,
    })
    expect(licensee.trigger).toMatchObject({ type: 'new_license', date: '2026-10-06' })
    expect(licensee.unsubscribe_token).toHaveLength(32)

    const log = await db.select().from(activityLog)
    expect(log.some((e) => e.event === 'discover' && e.level === 'info')).toBe(true)
  })

  it('a second run merges everything and creates nothing', async () => {
    const make = () => fakeClient({ li: [[liRow()]], owners: [ownerRows(2)] })
    await discover({}, { db, client: make(), now: NOW })
    const again = await discover({}, { db, client: make(), now: NOW })
    expect(again).toMatchObject({ created: 0, merged: 3, skipped: 0 })
    expect(await db.select().from(leads)).toHaveLength(3)
    expect(await db.select().from(properties)).toHaveLength(7)
  })

  it('respects max_new_leads_per_day and the limit in the body', async () => {
    await updateSettings({ max_new_leads_per_day: 3 }, db)
    const client = fakeClient({ owners: [ownerRows(50), ownerRows(50, 50)] })
    const first = await discover({}, { db, client, now: NOW })
    expect(first.created).toBe(3)
    expect(first.budget).toBe(3)
    // Stops paging once the budget is gone: only the first owner page was asked for.
    expect(client.sqls.filter((q) => q.includes('JOIN owners'))).toHaveLength(1)
    expect(first.skipped).toBe(47)

    const second = await discover(
      {},
      { db, client: fakeClient({ owners: [ownerRows(5, 500)] }), now: NOW },
    )
    expect(second.created).toBe(0)
    expect(second.budget).toBe(0)
    // The owners source is not even asked when there is no budget.
    expect(second.requests).toBe(2)

    await updateSettings({ max_new_leads_per_day: 100 }, db)
    const limited = await discover(
      { limit: 2 },
      { db, client: fakeClient({ owners: [ownerRows(5, 600)] }), now: NOW },
    )
    expect(limited.created).toBe(2)
    expect(limited.budget).toBe(2)
  })

  it('uses the zips from the body when given and only valid ones', async () => {
    const client = fakeClient({})
    const r = await discover({ zips: ['19104', '19120'] }, { db, client, now: NOW })
    expect(r.zips).toEqual(['19104', '19120'])
    expect(client.sqls[0]).toContain("IN ('19104','19120')")
  })

  it('one source failing does not stop the others and is logged', async () => {
    const client = fakeClient({ fail: 'li', owners: [ownerRows(1)] })
    const r = await discover({}, { db, client, now: NOW })
    expect(r.created).toBe(1)
    expect(r.errors).toEqual(['Rental licenses: li is down'])
    const log = await db.select().from(activityLog)
    expect(log.some((e) => e.event === 'discover.li.failed' && e.level === 'warn')).toBe(true)
    expect(log.some((e) => e.event === 'discover' && e.level === 'warn')).toBe(true)
  })

  it('does nothing without target zips', async () => {
    await updateSettings({ target_zips: [] }, db)
    const client = fakeClient({})
    const r = await discover({}, { db, client, now: NOW })
    expect(r.requests).toBe(0)
    expect(r.errors[0]).toMatch(/No target zips/)
  })
})
