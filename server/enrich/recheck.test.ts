import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '../db/client.ts'
import { leads } from '../db/schema.ts'
import { listActivity } from '../lib/activity.ts'
import { CHECK_VERSION, type ResearchRaw } from './providers/claudeResearch.ts'
import { pickRecheck, recheckStored } from './recheck.ts'
import { insertLead, insertProperty } from './testing.ts'

let db: Db
const now = () => new Date('2026-10-19T12:00:00.000Z')

beforeEach(async () => {
  db = await createTestDb()
})

const SITE = 'https://sunrisephilly.com/contact'
const PROFILE = 'https://www.linkedin.com/in/john-smith-4a1b'

/** A stored answer from before version 2: the old name check threw both contacts away. */
function oldAnswer(): ResearchRaw {
  const contacts = [
    {
      field: 'email' as const,
      value: 'john@sunrisephilly.com',
      role: 'owner' as const,
      source_url: SITE,
      quote: 'Email us',
      tie_quote: 'John Smith, owner. Our rentals: 1022 Pine St',
    },
    {
      field: 'linkedin_url' as const,
      value: PROFILE,
      role: 'owner' as const,
      source_url: PROFILE,
      quote: 'John Smith - Owner - Sunrise',
      tie_quote: null,
    },
  ]
  return {
    full_name: null,
    company: null,
    contacts,
    mailing_street: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    property_count: null,
    unit_count: null,
    property_details: [],
    confidence: 0.6,
    sources: [SITE],
    checked: contacts.map((c) => ({
      ...c,
      verdict: 'rejected' as const,
      reason: 'nothing ties the source to this owner',
      page: 'unreachable' as const,
    })),
  }
}

describe('checking stored research again', () => {
  it('saves contacts an older check threw away, with no new research call', async () => {
    const lead = await insertLead(db, {
      status: 'enriched',
      full_name: 'Smith John A',
      first_name: 'Smith',
      last_name: 'John A',
      enrichment: { claude_research: { fetched_at: '2026-10-15T00:00:00Z', data: oldAnswer() } },
    })
    await insertProperty(db, lead.id, { address: '1022 PINE ST' })
    // The email sits in a mailto: link the old page reader dropped.
    const pages: Record<string, string> = {
      [SITE]:
        'Email us john@sunrisephilly.com John Smith, owner. Our rentals: 1022 Pine St, Philadelphia',
    }
    const opened: string[] = []
    const result = await recheckStored(10, {
      db,
      now,
      pageFetcher: async (u) => {
        opened.push(u)
        return pages[u] ?? null
      },
    })
    expect(result).toEqual({ checked: 1, improved: 1 })
    expect(opened).toEqual([SITE]) // LinkedIn is a login wall: never opened

    const [row] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(row!.email).toBe('john@sunrisephilly.com')
    expect(row!.linkedin_url).toBe(PROFILE)
    const data = row!.enrichment.claude_research!.data as ResearchRaw
    expect(data.check_version).toBe(CHECK_VERSION)
    expect(data.checked.map((c) => c.verdict)).toEqual(['verified', 'likely'])
    const log = (await listActivity(20, db)).filter((a) => a.event === 'enrich.recheck')
    expect(log).toHaveLength(1)

    // Done once: the next tick picks nobody.
    expect(await pickRecheck(10, db)).toEqual([])
  })

  it('only stamps answers with no contacts, and leaves leads being enriched alone', async () => {
    const empty = { ...oldAnswer(), contacts: [], checked: [] }
    const a = await insertLead(db, {
      status: 'enriched',
      full_name: 'Edwin Yoo',
      enrichment: { claude_research: { fetched_at: '2026-10-15T00:00:00Z', data: empty } },
    })
    const busy = await insertLead(db, {
      status: 'enriching',
      full_name: 'Busy Person',
      enrichment: { claude_research: { fetched_at: '2026-10-15T00:00:00Z', data: oldAnswer() } },
    })
    await insertLead(db, { status: 'new', full_name: 'Not Researched' })
    expect(await pickRecheck(10, db)).toEqual([a.id])
    const result = await recheckStored(10, {
      db,
      now,
      pageFetcher: async () => {
        throw new Error('must not open pages')
      },
    })
    expect(result).toEqual({ checked: 1, improved: 0 })
    const [row] = await db.select().from(leads).where(eq(leads.id, a.id))
    expect((row!.enrichment.claude_research!.data as ResearchRaw).check_version).toBe(CHECK_VERSION)
    const [still] = await db.select().from(leads).where(eq(leads.id, busy.id))
    expect((still!.enrichment.claude_research!.data as ResearchRaw).check_version).toBeUndefined()
  })
})
