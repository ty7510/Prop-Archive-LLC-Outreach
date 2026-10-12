import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '../db/client.ts'
import { leads, properties, providerUsage } from '../db/schema.ts'
import { listActivity } from '../lib/activity.ts'
import { updateSettings } from '../lib/settings.ts'
import { enrichLeads, pickBatch, type OrchestratorDeps } from './orchestrator.ts'
import { fakeProvider, insertLead, insertProperty, testEnv } from './testing.ts'

let db: Db
const now = () => new Date('2026-10-11T12:00:00.000Z')

async function getLead(id: string) {
  const rows = await db.select().from(leads).where(eq(leads.id, id))
  return rows[0]!
}

beforeEach(async () => {
  db = await createTestDb()
})

describe('pickBatch', () => {
  it('picks new, high enough, wanted persona, contactable, oldest first', async () => {
    await updateSettings({ min_icp_score: 50, personas: ['maya', 'ray'] }, db)
    const old = await insertLead(db, { created_at: '2026-10-01T00:00:00Z', icp_score: 60 })
    const newer = await insertLead(db, { created_at: '2026-10-02T00:00:00Z', icp_score: 90 })
    await insertLead(db, { icp_score: 40 }) // too low
    await insertLead(db, { icp_score: 90, persona: 'denise' }) // persona off
    await insertLead(db, { icp_score: 90, persona: 'unknown' })
    await insertLead(db, { icp_score: 90, do_not_contact: true })
    await insertLead(db, { icp_score: 90, status: 'enriched' })
    expect(await pickBatch(10, { db })).toEqual([old.id, newer.id])
    expect(await pickBatch(1, { db })).toEqual([old.id])
    await updateSettings({ personas: [] }, db)
    expect(await pickBatch(10, { db })).toEqual([])
  })
})

describe('enrichLeads', () => {
  it('runs providers in settings order, stores raw payloads, recomputes channels, sets enriched', async () => {
    await updateSettings(
      { enrichment: { providers: ['pdl', 'li_license'], monthly_credit_cap: { pdl: 50 } } },
      db,
    )
    const lead = await insertLead(db, { company: 'Chestnut Holdings LLC', owner_kind: 'llc' })
    const order: string[] = []
    const li = fakeProvider('li_license', (l) => {
      order.push(`li:${l.status}`)
      return { full_name: 'Maya Lopez', unit_count: 5, owner_kind: 'person', raw: { rows: 2 } }
    })
    const pdl = fakeProvider('pdl', () => {
      order.push('pdl')
      return { email: 'maya@chestnut.co', email_status: 'unknown', raw: { likelihood: 8 } }
    })
    const deps: OrchestratorDeps = {
      db,
      env: testEnv({ PDL_API_KEY: 'k' }),
      providers: { li_license: li, pdl },
      now,
    }

    const result = await enrichLeads([lead.id], deps)
    expect(result).toEqual({ enriched: 1, failed: 0, skipped: 0 })
    expect(order).toEqual(['pdl', 'li:enriching'])

    const after = await getLead(lead.id)
    expect(after.status).toBe('enriched')
    expect(after.email).toBe('maya@chestnut.co')
    expect(after.full_name).toBe('Maya Lopez')
    expect(after.first_name).toBe('Maya')
    expect(after.owner_kind).toBe('person')
    expect(after.unit_count).toBe(5)
    expect(after.channels).toEqual({
      email: true,
      mail: false,
      linkedin: false,
      instagram: false,
      call: false,
    })
    expect(after.enrichment.pdl).toEqual({
      fetched_at: now().toISOString(),
      data: { likelihood: 8 },
    })
    expect(after.enrichment.li_license?.data).toEqual({ rows: 2 })
    expect(after.updated_at).toBe(now().toISOString())

    const usage = await db.select().from(providerUsage)
    expect(usage.map((u) => [u.provider, u.credits]).sort()).toEqual([
      ['li_license', 0],
      ['pdl', 1],
    ])
  })

  it('keeps trying every provider until the lead is complete', async () => {
    await updateSettings({ enrichment: { providers: ['claude_research', 'hunter', 'apollo'] } }, db)
    const lead = await insertLead(db, {
      full_name: 'Ray Torres',
      first_name: 'Ray',
      last_name: 'Torres',
    })
    const research = fakeProvider('claude_research', {
      email: 'ray@torrespg.com',
      linkedin_url: 'https://linkedin.com/in/ray',
    })
    const hunter = fakeProvider('hunter', { email: 'other@x.com', email_status: 'valid' })
    const apollo = fakeProvider('apollo', { phone: '2155550100' })
    const env = testEnv({ ANTHROPIC_API_KEY: 'a', HUNTER_API_KEY: 'h', APOLLO_API_KEY: 'p' })
    await enrichLeads([lead.id], {
      db,
      env,
      providers: { claude_research: research, hunter, apollo },
      now,
    })
    expect(research.calls).toHaveLength(1)
    expect(hunter.calls).toHaveLength(1)
    expect(apollo.calls).toHaveLength(1)
    const after = await getLead(lead.id)
    expect(after.phone).toBe('2155550100')
    expect(after.channels.linkedin).toBe(true)
  })

  it('stops once every wanted field is filled', async () => {
    await updateSettings({ enrichment: { providers: ['pdl', 'apollo'] } }, db)
    const a = await insertLead(db, { full_name: 'A B' })
    const env = testEnv({ PDL_API_KEY: 'k', APOLLO_API_KEY: 'k' })
    const apollo = fakeProvider('apollo', { linkedin_url: 'https://linkedin.com/in/x' })
    const pdlFull = fakeProvider('pdl', {
      email: 'a@b.co',
      phone: '2155550100',
      linkedin_url: 'https://linkedin.com/in/a',
      instagram_url: 'https://instagram.com/a',
      facebook_url: 'https://facebook.com/a',
      website: 'https://a.co',
      mailing_street: '1 Main St',
      unit_count: 4,
    })
    await enrichLeads([a.id], { db, env, providers: { pdl: pdlFull, apollo }, now })
    expect(apollo.calls).toHaveLength(0)
  })

  it('respects monthly credit caps and logs the cap once per batch', async () => {
    await updateSettings(
      { enrichment: { providers: ['hunter', 'pdl'], monthly_credit_cap: { hunter: 1, pdl: 50 } } },
      db,
    )
    const l1 = await insertLead(db, { full_name: 'A B' })
    const l2 = await insertLead(db, { full_name: 'C D' })
    const l3 = await insertLead(db, { full_name: 'E F' })
    const hunter = fakeProvider('hunter', { email: 'h@x.co', email_status: 'valid' })
    const pdl = fakeProvider('pdl', { linkedin_url: 'https://linkedin.com/in/p' })
    const env = testEnv({ HUNTER_API_KEY: 'h', PDL_API_KEY: 'p' })
    const result = await enrichLeads([l1.id, l2.id, l3.id], {
      db,
      env,
      providers: { hunter, pdl },
      now,
    })
    expect(result).toEqual({ enriched: 3, failed: 0, skipped: 0 })
    expect(hunter.calls).toHaveLength(1)
    expect(pdl.calls).toHaveLength(3)
    expect((await getLead(l2.id)).email).toBeNull()
    const caps = (await listActivity(100, db)).filter((a) => a.event === 'enrich.cap_reached')
    expect(caps).toHaveLength(1)
    expect(caps[0]?.detail).toMatchObject({ provider: 'hunter', used: 1, cap: 1, month: '2026-10' })
  })

  it('counts credits_used reported by the provider, and last month does not count', async () => {
    await updateSettings(
      { enrichment: { providers: ['hunter'], monthly_credit_cap: { hunter: 3 } } },
      db,
    )
    await db.insert(providerUsage).values({
      id: 'old',
      provider: 'hunter',
      lead_id: null,
      credits: 100,
      at: '2026-09-15T00:00:00.000Z',
    })
    const l1 = await insertLead(db, { full_name: 'A B' })
    const l2 = await insertLead(db, { full_name: 'C D' })
    const hunter = fakeProvider('hunter', { email: 'h@x.co', credits_used: 2 }, { costPerCall: 2 })
    await enrichLeads([l1.id, l2.id], {
      db,
      env: testEnv({ HUNTER_API_KEY: 'h' }),
      providers: { hunter },
      now,
    })
    // 2 credits for the first lead; 2 more would exceed 3, so the second lead is skipped.
    expect(hunter.calls).toHaveLength(1)
    const rows = await db.select().from(providerUsage)
    expect(rows.filter((r) => r.id !== 'old').map((r) => r.credits)).toEqual([2])
  })

  it('never overwrites a valid email with an unverified one', async () => {
    await updateSettings({ enrichment: { providers: ['pdl'] } }, db)
    const lead = await insertLead(db, {
      full_name: 'A B',
      email: 'verified@real.co',
      email_status: 'valid',
    })
    const pdl = fakeProvider('pdl', {
      email: 'guess@other.co',
      email_status: 'unknown',
      phone: '2155550100',
    })
    await enrichLeads([lead.id], {
      db,
      env: testEnv({ PDL_API_KEY: 'k' }),
      providers: { pdl },
      now,
    })
    const after = await getLead(lead.id)
    expect(after.email).toBe('verified@real.co')
    expect(after.email_status).toBe('valid')
    expect(after.phone).toBe('2155550100')
  })

  it('a failing provider is logged and the rest still run; all failing puts the lead back to new', async () => {
    await updateSettings({ enrichment: { providers: ['pdl', 'apollo'] } }, db)
    const env = testEnv({ PDL_API_KEY: 'k', APOLLO_API_KEY: 'k' })
    const ok = await insertLead(db, { full_name: 'A B' })
    const bad = await insertLead(db, { full_name: 'C D' })
    const boom = fakeProvider('pdl', new Error('pdl: HTTP 500'))
    const apollo = fakeProvider('apollo', { linkedin_url: 'https://linkedin.com/in/x' })
    const r1 = await enrichLeads([ok.id], { db, env, providers: { pdl: boom, apollo }, now })
    expect(r1).toEqual({ enriched: 1, failed: 0, skipped: 0 })
    expect((await getLead(ok.id)).linkedin_url).toBe('https://linkedin.com/in/x')
    expect((await getLead(ok.id)).status).toBe('enriched')

    const boom2 = fakeProvider('apollo', new Error('apollo: HTTP 429'))
    const r2 = await enrichLeads([bad.id], {
      db,
      env,
      providers: { pdl: boom, apollo: boom2 },
      now,
    })
    expect(r2).toEqual({ enriched: 0, failed: 1, skipped: 0 })
    expect((await getLead(bad.id)).status).toBe('new')
    const errors = (await listActivity(100, db)).filter((a) => a.event === 'enrich.provider_error')
    expect(errors).toHaveLength(3)
    expect(errors.some((e) => (e.detail as { error: string }).error === 'pdl: HTTP 500')).toBe(true)
  })

  it('skips unknown ids and do_not_contact leads; optional unconfigured providers stay quiet', async () => {
    await updateSettings({ enrichment: { providers: ['hunter', 'li_license'] } }, db)
    const dnc = await insertLead(db, { do_not_contact: true, full_name: 'A B' })
    const a = await insertLead(db, { full_name: 'A B' })
    const b = await insertLead(db, { full_name: 'C D' })
    const hunter = fakeProvider('hunter', { email: 'x@y.co' }, { configured: false })
    const li = fakeProvider('li_license', { company: 'X LLC' })
    const result = await enrichLeads(['nope', dnc.id, a.id, b.id, a.id], {
      db,
      env: testEnv(),
      providers: { hunter, li_license: li },
      now,
    })
    expect(result).toEqual({ enriched: 2, failed: 0, skipped: 2 })
    expect(hunter.calls).toHaveLength(0)
    expect((await getLead(dnc.id)).status).toBe('new')
    const notConfigured = (await listActivity(100, db)).filter(
      (x) => x.event === 'enrich.provider_not_configured',
    )
    // Hunter is an optional paid add-on: skipped quietly, nothing in the activity log.
    expect(notConfigured).toHaveLength(0)
  })

  it('skips providers that do not apply without spending credits', async () => {
    await updateSettings({ enrichment: { providers: ['hunter'] } }, db)
    const lead = await insertLead(db, { full_name: 'A B' })
    const hunter = fakeProvider('hunter', { email: 'x@y.co' }, { applies: false })
    await enrichLeads([lead.id], {
      db,
      env: testEnv({ HUNTER_API_KEY: 'h' }),
      providers: { hunter },
      now,
    })
    expect(hunter.calls).toHaveLength(0)
    expect(await db.select().from(providerUsage)).toHaveLength(0)
    expect((await getLead(lead.id)).status).toBe('enriched')
  })

  it('leaves the status alone for leads already in outreach, but still fills fields', async () => {
    await updateSettings({ enrichment: { providers: ['pdl'] } }, db)
    const lead = await insertLead(db, { full_name: 'A B', status: 'enrolled' })
    const pdl = fakeProvider('pdl', { phone: '2155550100' })
    await enrichLeads([lead.id], {
      db,
      env: testEnv({ PDL_API_KEY: 'k' }),
      providers: { pdl },
      now,
    })
    const after = await getLead(lead.id)
    expect(after.status).toBe('enrolled')
    expect(after.phone).toBe('2155550100')
    expect(after.channels.call).toBe(true)
  })

  it('applies property updates from li_license', async () => {
    await updateSettings({ enrichment: { providers: ['li_license'] } }, db)
    const lead = await insertLead(db, { company: 'X LLC' })
    const p1 = await insertProperty(db, lead.id, { opa_account: '111', units: null })
    await insertProperty(db, lead.id, { opa_account: '222', units: 2, license_num: 'keep' })
    const li = fakeProvider('li_license', {
      unit_count: 7,
      property_updates: [
        { opa_account: '111', units: 3, license_num: 'L1', license_expiry: '2027-01-01' },
        { opa_account: '222', units: 4, license_num: 'L2' },
        { opa_account: '999', units: 1 },
      ],
    })
    await enrichLeads([lead.id], { db, env: testEnv(), providers: { li_license: li }, now })
    const props = await db.select().from(properties).where(eq(properties.lead_id, lead.id))
    const first = props.find((p) => p.id === p1)!
    expect(first.units).toBe(3)
    expect(first.license_num).toBe('L1')
    expect(first.license_expiry).toBe('2027-01-01')
    const second = props.find((p) => p.opa_account === '222')!
    expect(second.units).toBe(4)
    expect(second.license_num).toBe('keep')
    expect((await getLead(lead.id)).unit_count).toBe(7)
  })

  it('an empty id list does nothing', async () => {
    expect(await enrichLeads([], { db })).toEqual({ enriched: 0, failed: 0, skipped: 0 })
    expect(await listActivity(10, db)).toHaveLength(0)
  })
})
