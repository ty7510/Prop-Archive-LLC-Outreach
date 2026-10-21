// 2026-10-16: people who sold off their rentals stay off the to-do list (Theo: "account for if they
// recently sold off their properties and dont show those people").
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { leads, messages, properties, type Lead } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import type { CartoClient } from '../sources/carto.ts'
import {
  buildParcelOwnersSql,
  checkOwnership,
  needsOwnershipCheck,
  ownershipRecord,
  type OpaOwnerRow,
} from './ownership.ts'
import { insertLead, setSettings, setup } from './testFixtures.ts'
import { fillTodo, listTodo, recheckOpenCards } from './todo.ts'
import { NO_NEW_LINKEDIN } from '../../shared/types.ts'

const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

/** A fake OPA: answers every query with these rows and counts the queries. */
function fakeOpa(rows: OpaOwnerRow[]): CartoClient & { sqls: string[] } {
  const sqls: string[] = []
  return {
    sqls,
    get requests() {
      return sqls.length
    },
    async query<T>(sqlText: string) {
      sqls.push(sqlText)
      return rows as T[]
    },
  }
}

const OWNER = {
  owner_1: 'SMITH DANA',
  owner_2: null,
  mailing_street: '10 HOME ST',
  mailing_zip: '19104',
}

/** A lead with these OPA parcels, each bought (by them) in 2015 at our import. */
async function leadWithParcels(
  db: Awaited<ReturnType<typeof setup>>['db'],
  parcels: string[],
  patch: Partial<Lead> = {},
): Promise<Lead> {
  const lead = await insertLead(db, { property_count: parcels.length, ...patch })
  for (const parcel of parcels) {
    await db.insert(properties).values({
      id: newId(),
      lead_id: lead.id,
      address: `${parcel.slice(-3)} Pine St`,
      sale_date: '2015-06-01',
      sale_price: 150_000,
      opa_account: parcel,
      source: 'opa',
      raw: {
        parcel_number: parcel,
        sale_date: '2015-06-01T00:00:00Z',
        sale_price: 150000,
        ...OWNER,
      },
    })
  }
  return lead
}

const stillTheirs = (parcel: string): OpaOwnerRow => ({
  parcel_number: parcel,
  sale_date: '2015-06-01T00:00:00Z',
  sale_price: 150000,
  ...OWNER,
})

const soldTo = (parcel: string, buyer: string, price = 320000): OpaOwnerRow => ({
  parcel_number: parcel,
  sale_date: '2026-08-20T00:00:00Z',
  sale_price: price,
  owner_1: buyer,
  owner_2: null,
  mailing_street: '99 OTHER RD',
  mailing_zip: '19103',
})

const P = ['881000001', '881000002', '881000003', '881000004']

async function ownSetup() {
  const fx = await setup({ now: () => TUESDAY_10AM })
  await setSettings(fx.db, {
    sequences_on: false,
    people_per_day: 5,
    min_props: 3,
    channels: { email: false, linkedin: true, mail: true, call: true },
  })
  return { ...fx, settings: await getSettings(fx.db) }
}

describe('who owns their parcels now', () => {
  it('sold everything: disqualified, the reason saved, and never on the list', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await leadWithParcels(db, P.slice(0, 3))
    const opa = fakeOpa(P.slice(0, 3).map((p) => soldTo(p, 'NEW OWNER LLC')))
    const r = await checkOwnership(deps, settings, lead, { client: opa })
    expect(r).toMatchObject({ status: 'sold_off', checked: 3, owned_now: 0 })
    expect(r.sold.map((s) => s.parcel)).toEqual(P.slice(0, 3))
    expect(r.sold[0]).toMatchObject({
      sale_date: '2026-08-20',
      sale_price: 320000,
      new_owner: 'NEW OWNER LLC',
    })
    expect(r.lead.status).toBe('disqualified')
    expect(ownershipRecord(r.lead)?.status).toBe('sold_off')
    expect(opa.sqls[0]).toContain("parcel_number IN ('881000001','881000002','881000003')")
    // Never on the list; with no one else to add, the fill says nobody new has a LinkedIn.
    expect(await fillTodo(deps)).toEqual({ added: 0, reason: NO_NEW_LINKEDIN })
  })

  it('sold some but still owns enough: stays, with the count lowered', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await leadWithParcels(db, P)
    const opa = fakeOpa([soldTo(P[0]!, 'JONES PAT'), ...P.slice(1).map(stillTheirs)])
    const r = await checkOwnership(deps, settings, lead, { client: opa })
    expect(r).toMatchObject({ status: 'owns', checked: 4, owned_now: 3 })
    expect(r.lead.status).toBe('enriched')
    expect(r.lead.property_count).toBe(3)
  })

  it('below the smallest owner Theo targets after selling: sold off', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await leadWithParcels(db, P)
    const opa = fakeOpa([soldTo(P[0]!, 'A'), soldTo(P[1]!, 'B'), ...P.slice(2).map(stillTheirs)])
    expect((await checkOwnership(deps, settings, lead, { client: opa })).status).toBe('sold_off')
  })

  it('moving houses into their own LLC at the same address is not selling', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await leadWithParcels(db, P.slice(0, 3))
    const opa = fakeOpa(
      P.slice(0, 3).map((p) => ({
        ...soldTo(p, 'SMITH HOLDINGS LLC', 1),
        mailing_street: OWNER.mailing_street,
        mailing_zip: OWNER.mailing_zip,
      })),
    )
    const r = await checkOwnership(deps, settings, lead, { client: opa })
    expect(r).toMatchObject({ status: 'owns', sold: [] })
  })

  it('a newer deed with the same owner, or a sale before we knew them, is not selling', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await leadWithParcels(db, P.slice(0, 3))
    const opa = fakeOpa([
      { ...stillTheirs(P[0]!), sale_date: '2026-09-01T00:00:00Z', sale_price: 1 },
      { ...soldTo(P[1]!, 'SOMEONE'), sale_date: '2014-01-01T00:00:00Z' },
      stillTheirs(P[2]!),
    ])
    expect((await checkOwnership(deps, settings, lead, { client: opa })).sold).toEqual([])
  })

  it('no parcel numbers: nothing to ask, nothing changes', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await insertLead(db)
    const opa = fakeOpa([])
    const r = await checkOwnership(deps, settings, lead, { client: opa })
    expect(r.status).toBe('unknown')
    expect(opa.sqls).toHaveLength(0)
    expect(needsOwnershipCheck(r.lead, TUESDAY_10AM)).toBe(false)
    expect(needsOwnershipCheck(r.lead, new Date(TUESDAY_10AM.getTime() + 15 * DAY))).toBe(true)
  })

  it('never disqualifies someone who already answered', async () => {
    const { db, deps, settings } = await ownSetup()
    const lead = await leadWithParcels(db, P.slice(0, 3), { status: 'replied' })
    const opa = fakeOpa(P.slice(0, 3).map((p) => soldTo(p, 'NEW OWNER LLC')))
    const r = await checkOwnership(deps, settings, lead, { client: opa })
    expect(r.status).toBe('sold_off')
    expect(r.lead.status).toBe('replied')
  })

  it('only nine-digit parcel numbers ever reach the SQL', () => {
    expect(() => buildParcelOwnersSql(["881000001') OR 1=1 --"])).toThrow(/bad parcel/)
    expect(() => buildParcelOwnersSql(['12345'])).toThrow(/bad parcel/)
    expect(() => buildParcelOwnersSql([])).toThrow()
    expect(buildParcelOwnersSql(['881000001', '881000001'])).toContain("IN ('881000001')")
  })
})

describe('people already on the list', () => {
  it('leave it when a later check finds they sold off', async () => {
    const { db, deps, settings } = await ownSetup()
    // On the list before this check existed (no record yet), with no parcels: added as usual.
    const lead = await leadWithParcels(db, [])
    await fillTodo(deps)
    expect((await listTodo(deps)).people).toHaveLength(1)
    // Their parcels turn up later, sold.
    await db.update(leads).set({ enrichment: {} }).where(eq(leads.id, lead.id))
    for (const parcel of P.slice(0, 3)) {
      await db.insert(properties).values({
        id: newId(),
        lead_id: lead.id,
        sale_date: '2015-06-01',
        opa_account: parcel,
        source: 'opa',
        raw: { parcel_number: parcel, ...OWNER },
      })
    }
    const opa = fakeOpa(P.slice(0, 3).map((p) => soldTo(p, 'NEW OWNER LLC')))
    const original = deps.fetch
    deps.fetch = (async () =>
      new Response(JSON.stringify({ rows: await opa.query('') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    try {
      expect(await recheckOpenCards(deps, settings)).toBe(1)
    } finally {
      deps.fetch = original
    }
    expect((await listTodo(deps)).people).toHaveLength(0)
    const waiting = await db.select().from(messages).where(eq(messages.lead_id, lead.id))
    expect(waiting.every((m) => m.status === 'skipped')).toBe(true)
    expect(waiting[0]!.error).toBe('stopped: sold their properties')
  })
})
