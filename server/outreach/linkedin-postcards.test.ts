// 2026-10-16: the app sends no email. LinkedIn notes and postcards are Theo's daily list, he logs
// replies by hand, and he can paste a LinkedIn profile research did not find.
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { enrollments, events, leads, messages } from '../db/schema.ts'
import { enrollLead } from './enroll.ts'
import { recordOutcome } from './outcomes.ts'
import {
  actOnQueueItem,
  listQueue,
  normaliseLinkedInProfile,
  saveLinkedInProfile,
} from './queue.ts'
import { sequenceReadiness } from './readiness.ts'
import { EMAILS_OFF_ERROR, idempotencyKey, sendDue } from './send.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

// Like the main sequence: email, LinkedIn note, email, postcard, break-up email.
const MAIN_LIKE = [
  { delay_days: 0, channel: 'email' as const, subject: 'Hi {{first_name}}', body: 'Email one' },
  { delay_days: 2, channel: 'linkedin' as const, body: 'Hi {{first_name}}, glad to connect.' },
  { delay_days: 2, channel: 'email' as const, subject: 'Again', body: 'Email two' },
  { delay_days: 3, channel: 'mail' as const, body: 'Hi {{first_name}}, a postcard.' },
  { delay_days: 3, channel: 'email' as const, subject: 'Last', body: 'Break-up' },
]

async function emailsOffSetup() {
  const at = { now: TUESDAY_10AM }
  const fx = await setup({ now: () => at.now })
  await setSettings(fx.db, {
    channels: { email: false, linkedin: true, mail: true },
    daily_caps: { linkedin: 25, mail: 10 },
    physical_address: '1500 Market St, Philadelphia, PA 19102',
  })
  const { sequence } = await insertSequence(fx.db, { name: 'Main like' }, MAIN_LIKE)
  return { ...fx, at, sequence }
}

describe('emails off', () => {
  it('skips every email step, so the LinkedIn note and the postcard still come up', async () => {
    const { db, deps, at, sequence } = await emailsOffSetup()
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)

    await sendDue(deps) // email 1 skipped: the LinkedIn step is due now
    await sendDue(deps) // the next round (a minute later) puts the note up
    const out = () => db.select().from(messages).where(eq(messages.lead_id, lead.id))
    expect((await out()).filter((m) => m.channel === 'email')).toHaveLength(0)
    const note = (await out()).find((m) => m.channel === 'linkedin')!
    expect(note.status).toBe('ready_for_human')
    await actOnQueueItem(deps, note.id, 'done')

    // Days later: email 2 is skipped, never held, and the postcard follows on its own day.
    at.now = new Date(TUESDAY_10AM.getTime() + 3 * DAY)
    await sendDue(deps)
    expect((await db.select().from(enrollments))[0]!.current_step).toBe(3)
    at.now = new Date(TUESDAY_10AM.getTime() + 7 * DAY)
    await sendDue(deps)
    const card = (await out()).find((m) => m.channel === 'mail')
    expect(card?.status).toBe('ready_for_human')
    await actOnQueueItem(deps, card!.id, 'done')

    // The break-up email is skipped too, and the sequence ends with no email ever written.
    at.now = new Date(TUESDAY_10AM.getTime() + 21 * DAY)
    await sendDue(deps)
    expect((await db.select().from(enrollments))[0]!.status).toBe('done')
    expect((await out()).filter((m) => m.channel === 'email')).toHaveLength(0)
  })

  it('an email already queued before the switch is skipped, not sent', async () => {
    const { db, deps, sequence } = await emailsOffSetup()
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)
    const [enrollment] = await db.select().from(enrollments)
    await db.insert(messages).values({
      id: 'queued-email',
      lead_id: lead.id,
      enrollment_id: enrollment!.id,
      channel: 'email',
      direction: 'out',
      status: 'queued',
      idempotency_key: idempotencyKey(enrollment!.id, 0, 0),
      body: 'Email one',
      to_address: lead.email,
      created_at: TUESDAY_10AM.toISOString(),
    })
    await sendDue(deps)
    const [queued] = await db.select().from(messages).where(eq(messages.id, 'queued-email'))
    expect(queued).toMatchObject({ status: 'skipped', error: EMAILS_OFF_ERROR })
  })

  it('readiness stops asking for inboxes and reply reading', async () => {
    const { deps } = await emailsOffSetup()
    const keys = (await sequenceReadiness(deps)).map((i) => i.key)
    expect(keys).not.toContain('inbox')
    expect(keys).not.toContain('replies')
    expect(keys).toContain('research_cap')
  })
})

describe('they replied', () => {
  it('logs the reply, stops everything waiting, and leaves the "did anyone write back" list', async () => {
    const { db, deps, sequence } = await emailsOffSetup()
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)
    await sendDue(deps)
    const note = (await db.select().from(messages)).find((m) => m.channel === 'linkedin')!
    await actOnQueueItem(deps, note.id, 'done')
    expect((await listQueue(deps)).contacted_recently.map((i) => i.lead_id)).toEqual([lead.id])

    const after = await recordOutcome(deps, lead.id, 'replied', 'manual', {
      channel: 'linkedin',
      note: 'Wants a demo next week',
    })
    expect(after.status).toBe('replied')
    expect(after.last_replied_at).not.toBeNull()
    expect((await db.select().from(enrollments))[0]!.status).toBe('stopped_replied')
    const inbound = (await db.select().from(messages)).filter((m) => m.direction === 'in')
    expect(inbound).toEqual([
      expect.objectContaining({
        channel: 'linkedin',
        status: 'received',
        body: 'Wants a demo next week',
        provider: 'human',
      }),
    ])
    const reply = (await db.select().from(events)).find((e) => e.kind === 'reply')
    expect(reply?.detail).toMatchObject({ channel: 'linkedin', note: 'Wants a demo next week' })
    expect((await listQueue(deps)).contacted_recently).toHaveLength(0)
  })

  it('never turns a booked lead back into replied', async () => {
    const { db, deps } = await emailsOffSetup()
    const lead = await insertLead(db, { status: 'booked' })
    const after = await recordOutcome(deps, lead.id, 'replied', 'manual', { channel: 'call' })
    expect(after.status).toBe('booked')
  })
})

describe('pasting a LinkedIn profile', () => {
  it('reads the profile link however it was copied', () => {
    expect(normaliseLinkedInProfile('linkedin.com/in/jane-doe-123?utm=x')).toBe(
      'https://www.linkedin.com/in/jane-doe-123/',
    )
    expect(normaliseLinkedInProfile('https://www.linkedin.com/in/jane-doe-123/details/')).toBe(
      'https://www.linkedin.com/in/jane-doe-123/',
    )
    expect(normaliseLinkedInProfile('https://www.linkedin.com/company/acme')).toBeNull()
    expect(normaliseLinkedInProfile('https://example.com/in/jane')).toBeNull()
    expect(normaliseLinkedInProfile('not a link')).toBeNull()
  })

  it('lists people with no profile, and a pasted one brings their note up now', async () => {
    const { db, deps, sequence } = await emailsOffSetup()
    const lead = await insertLead(db, { linkedin_url: null })
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps) // email skipped
    await sendDue(deps) // the LinkedIn step: no profile, skipped
    expect((await listQueue(deps)).linkedin_wanted.map((p) => p.lead_id)).toEqual([lead.id])

    const result = await saveLinkedInProfile(deps, lead.id, 'linkedin.com/in/found-them')
    expect(result).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/found-them/',
      queued: true,
    })
    const [saved] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(saved!.channels.linkedin).toBe(true)
    const queue = await listQueue(deps)
    expect(queue.groups.linkedin?.map((i) => i.lead_id)).toEqual([lead.id])
    expect(queue.linkedin_wanted).toHaveLength(0)
  })

  it('refuses a link that is not a person profile', async () => {
    const { db, deps } = await emailsOffSetup()
    const lead = await insertLead(db, { linkedin_url: null })
    await expect(
      saveLinkedInProfile(deps, lead.id, 'https://www.linkedin.com/company/acme'),
    ).rejects.toThrow(/profile/)
  })
})
