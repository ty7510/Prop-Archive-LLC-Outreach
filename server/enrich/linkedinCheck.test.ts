import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '../db/client.ts'
import { events, leads, messages } from '../db/schema.ts'
import { listActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { TODO_KEY_PREFIX } from '../outreach/todo.ts'
import { checkSavedLinkedIn, TODO_PREFIX } from './linkedinCheck.ts'
import { insertLead } from './testing.ts'

let db: Db
const now = () => new Date('2026-10-20T12:00:00.000Z')

beforeEach(async () => {
  db = await createTestDb()
})

const john = { full_name: 'John Smith', first_name: 'John', last_name: 'Smith' }

async function getLead(id: string) {
  return (await db.select().from(leads).where(eq(leads.id, id)))[0]!
}

async function waitingNote(leadId: string, to: string) {
  const id = newId()
  await db.insert(messages).values({
    id,
    lead_id: leadId,
    channel: 'linkedin',
    status: 'ready_for_human',
    idempotency_key: `${TODO_PREFIX}${leadId}:linkedin`,
    body: 'Hi John',
    to_address: to,
    raw: { found_by_app: true },
    created_at: now().toISOString(),
  })
  return id
}

describe('checking saved LinkedIn links', () => {
  it('uses the to-do list prefix', () => {
    expect(TODO_PREFIX).toBe(TODO_KEY_PREFIX)
  })

  it("takes off a profile a lookup matched to someone else's name, and off their card", async () => {
    const url = 'https://www.linkedin.com/in/jdoe77'
    const lead = await insertLead(db, {
      ...john,
      linkedin_url: url,
      channels: { email: false, mail: false, linkedin: true, instagram: false, call: false },
      enrichment: {
        apollo: {
          fetched_at: '2026-10-19T00:00:00.000Z',
          data: { person: { name: 'Jane Doe', linkedin_url: url } },
        },
      },
    })
    const card = await waitingNote(lead.id, url)

    expect(await checkSavedLinkedIn(50, { db, now })).toEqual({ checked: 1, removed: 1 })

    const after = await getLead(lead.id)
    expect(after.linkedin_url).toBeNull()
    expect(after.channels.linkedin).toBe(false)
    const finder = (after.enrichment as Record<string, { data: { rejected: string[] } }>)
      .linkedin_find!.data
    expect(finder.rejected).toEqual(['https://www.linkedin.com/in/jdoe77/'])
    const msg = (await db.select().from(messages).where(eq(messages.id, card)))[0]!
    expect(msg.to_address).toBeNull()
    expect(msg.status).toBe('ready_for_human') // the note stays; only the wrong profile goes
    const log = (await listActivity(50, db)).find(
      (a) => a.event === 'linkedin_profile_name_mismatch',
    )
    expect(log?.detail).toMatchObject({ url, profile_names: ['Jane Doe'] })

    // Checked once: the next round has nothing to do.
    expect(await checkSavedLinkedIn(50, { db, now })).toEqual({ checked: 0, removed: 0 })
  })

  it('keeps a profile whose name is theirs', async () => {
    const url = 'https://www.linkedin.com/in/jsmith'
    const lead = await insertLead(db, {
      ...john,
      linkedin_url: url,
      enrichment: {
        linkedin_find: {
          fetched_at: '2026-10-19T00:00:00.000Z',
          data: { url, title: 'John Smith - Landlord - Philadelphia | LinkedIn', rejected: [] },
        },
      },
    })
    expect(await checkSavedLinkedIn(50, { db, now })).toEqual({ checked: 1, removed: 0 })
    expect((await getLead(lead.id)).linkedin_url).toBe(url)
  })

  it('takes off an old research profile whose quote names someone else', async () => {
    const url = 'https://www.linkedin.com/in/mary-smith-1a'
    const lead = await insertLead(db, {
      ...john,
      linkedin_url: url,
      enrichment: {
        claude_research: {
          fetched_at: '2026-10-19T00:00:00.000Z',
          data: {
            contacts: [],
            checked: [
              {
                field: 'linkedin_url',
                value: url,
                role: 'owner',
                source_url: url,
                quote: 'Mary Smith - Realtor - Philadelphia',
                tie_quote: null,
                verdict: 'likely',
                reason: 'x',
                page: 'unreachable',
              },
            ],
          },
        },
      },
    })
    expect(await checkSavedLinkedIn(50, { db, now })).toEqual({ checked: 1, removed: 1 })
    expect((await getLead(lead.id)).linkedin_url).toBeNull()
  })

  it('never touches a link Theo pasted or imported', async () => {
    const pasted = await insertLead(db, {
      ...john,
      linkedin_url: 'https://www.linkedin.com/in/abc',
    })
    // Research also had a different person at this link, but Theo pasted it himself.
    const hand = await insertLead(db, {
      ...john,
      linkedin_url: 'https://www.linkedin.com/in/xyz',
      enrichment: {
        apollo: {
          fetched_at: '2026-10-19T00:00:00.000Z',
          data: { person: { name: 'Jane Doe', linkedin_url: 'https://www.linkedin.com/in/xyz' } },
        },
      },
    })
    await db.insert(events).values({
      id: newId(),
      lead_id: hand.id,
      kind: 'note',
      detail: { linkedin_url: 'https://www.linkedin.com/in/xyz/', by: 'hand' },
      at: now().toISOString(),
    })
    expect(await checkSavedLinkedIn(50, { db, now })).toEqual({ checked: 2, removed: 0 })
    expect((await getLead(pasted.id)).linkedin_url).toBe('https://www.linkedin.com/in/abc')
    expect((await getLead(hand.id)).linkedin_url).toBe('https://www.linkedin.com/in/xyz')
  })
})
