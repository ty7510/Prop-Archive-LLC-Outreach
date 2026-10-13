import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityLog, enrollments, messages } from '../db/schema.ts'
import { enrollEligible, enrollLead } from './enroll.ts'
import { samePersonLeadIds } from './recipients.ts'
import { sendDue } from './send.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

const ADDRESS = '123 Main St, Philadelphia, PA 19146'
const TUESDAY = new Date('2026-10-13T14:00:00.000Z')
const FRIDAY = new Date('2026-10-16T14:00:00.000Z') // 3 days on
const DECEMBER = new Date('2026-12-15T15:00:00.000Z') // 63 days on, a Tuesday 10:00 in New York

function clock(start: Date): { now: () => Date; set: (d: Date) => void } {
  let at = start
  return { now: () => at, set: (d) => (at = d) }
}

describe('samePersonLeadIds', () => {
  it('finds the other lead rows of one person: same email or same mailing street and zip', async () => {
    const { db } = await setup()
    const potter = await insertLead(db, {
      company: 'First Few Units LLC',
      email: 'Potter@Example.com',
      mailing_street: '4253 Regent Sq',
      mailing_zip: '19104',
    })
    const secondLlc = await insertLead(db, {
      company: 'Second Few Units LLC',
      email: null,
      mailing_street: '4253 REGENT SQ ',
      mailing_zip: '19104-2211',
    })
    const sameEmail = await insertLead(db, {
      company: 'Fifth Few Units LLC',
      email: 'potter@example.com',
      mailing_street: 'PO Box 9',
      mailing_zip: '19103',
    })
    const neighbour = await insertLead(db, {
      mailing_street: '4255 Regent Sq',
      mailing_zip: '19104',
    })
    const sameStreetOtherZip = await insertLead(db, {
      mailing_street: '4253 Regent Sq',
      mailing_zip: '19146',
    })

    const ids = await samePersonLeadIds(db, potter)
    expect(ids.sort()).toEqual([potter.id, secondLlc.id, sameEmail.id].sort())
    expect(ids).not.toContain(neighbour.id)
    expect(ids).not.toContain(sameStreetOtherZip.id)
  })

  it('a lead with no email and no address is only itself', async () => {
    const { db } = await setup()
    const bare = await insertLead(db, { email: null, mailing_street: null, mailing_zip: null })
    await insertLead(db, { email: null, mailing_street: null, mailing_zip: null })
    expect(await samePersonLeadIds(db, bare)).toEqual([bare.id])
  })
})

describe('enrollEligible never puts one person in twice', () => {
  it('two LLCs at one mailing address: the first goes in, the second is left out and logged', async () => {
    const { db, deps } = await setup()
    const seq = await insertSequence(db, { name: 'Main', persona: 'ray' })
    await setSettings(db, { main_sequence_id: seq.sequence.id })
    const first = await insertLead(db, {
      company: 'First Few Units LLC',
      email: 'potter@example.com',
      mailing_street: '4253 Regent Sq',
      mailing_zip: '19104',
    })
    const second = await insertLead(db, {
      company: 'Second Few Units LLC',
      email: 'second@example.com',
      mailing_street: '4253 Regent Sq',
      mailing_zip: '19104',
    })
    const other = await insertLead(db)

    expect(await enrollEligible(deps)).toEqual({ enrolled: 2 })
    const rows = await db.select().from(enrollments)
    expect(rows.map((r) => r.lead_id).sort()).toEqual([first.id, other.id].sort())
    expect(rows.map((r) => r.lead_id)).not.toContain(second.id)
    const log = await db.select().from(activityLog)
    const skipped = log.find((l) => l.event === 'enroll_skipped_same_person')
    expect(skipped).toBeDefined()
    expect(skipped!.detail).toMatchObject({ count: 1 })

    // Next round: the second LLC still waits behind the first one's enrollment.
    expect(await enrollEligible(deps)).toEqual({ enrolled: 0 })
    expect(await db.select().from(enrollments)).toHaveLength(2)
  })

  it('a lead sharing an email with a lead enrolled earlier is left out', async () => {
    const { db, deps } = await setup()
    const seq = await insertSequence(db, { name: 'Main', persona: 'ray' })
    await setSettings(db, { main_sequence_id: seq.sequence.id })
    const earlier = await insertLead(db, { email: 'owner@example.com' })
    await enrollLead(deps, earlier.id, seq.sequence.id)
    await insertLead(db, { email: 'OWNER@example.com', mailing_street: '9 Other St' })
    expect(await enrollEligible(deps)).toEqual({ enrolled: 0 })
    expect(await db.select().from(enrollments)).toHaveLength(1)
  })
})

describe('sendDue paces one recipient, not one lead row', () => {
  it('no second email to the same address within the gap, even from another lead row', async () => {
    const t = clock(TUESDAY)
    const { db, deps, outbox } = await setup({ now: t.now })
    await setSettings(db, { live_mode: true, physical_address: ADDRESS })
    const { sequence } = await insertSequence(db, {}, [{ delay_days: 0, subject: 'Hi', body: 'x' }])
    const a = await insertLead(db, { email: 'owner@example.com' })
    const b = await insertLead(db, { email: 'Owner@Example.com', mailing_street: '9 Other St' })
    await enrollLead(deps, a.id, sequence.id)
    await enrollLead(deps, b.id, sequence.id)

    const first = await sendDue(deps)
    expect(first).toMatchObject({ sent: 1, skipped: 1 })
    expect(outbox).toHaveLength(1)
    expect(await db.select().from(messages)).toHaveLength(1) // the waiting one is not even claimed
    const log = await db.select().from(activityLog)
    expect(log.find((l) => l.event === 'send')?.detail).toMatchObject({
      waiting_for_recipient_gap: 1,
    })

    // Still too soon the same day.
    expect((await sendDue(deps)).sent).toBe(0)
    expect(outbox).toHaveLength(1)

    // Three days on the second one goes.
    t.set(FRIDAY)
    expect((await sendDue(deps)).sent).toBe(1)
    expect(outbox).toHaveLength(2)
    expect(outbox.map((m) => m.to.toLowerCase()).every((to) => to === 'owner@example.com')).toBe(
      true,
    )
  })

  it('two email steps with no delay between them still go days apart', async () => {
    const t = clock(TUESDAY)
    const { db, deps, outbox } = await setup({ now: t.now })
    await setSettings(db, { live_mode: true, physical_address: ADDRESS })
    const { sequence } = await insertSequence(db, {}, [
      { delay_days: 0, subject: 'Hi', body: 'x' },
      { delay_days: 0, subject: 'Again', body: 'y' },
    ])
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)

    expect((await sendDue(deps)).sent).toBe(1)
    expect((await sendDue(deps)).sent).toBe(0)
    expect(outbox).toHaveLength(1)
    t.set(FRIDAY)
    expect((await sendDue(deps)).sent).toBe(1)
    expect(outbox).toHaveLength(2)
  })

  it('a dry run paces like live, but dry-run rows never hold a real email back', async () => {
    const t = clock(TUESDAY)
    const { db, deps, outbox } = await setup({ now: t.now })
    await setSettings(db, { physical_address: ADDRESS })
    const { sequence } = await insertSequence(db, {}, [
      { delay_days: 0, subject: 'Hi', body: 'x' },
      { delay_days: 0, subject: 'Again', body: 'y' },
    ])
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, sequence.id)
    expect((await sendDue(deps)).dryRun).toBe(1)
    expect((await sendDue(deps)).dryRun).toBe(0) // step 2 waits for the gap in dry run too

    // Live mode on: the dry-run sequence starts over and the first real email goes at once.
    await setSettings(db, { live_mode: true })
    const [enr] = await db.select().from(enrollments)
    await db
      .update(enrollments)
      .set({ current_step: 0, next_send_at: t.now().toISOString(), run: enr!.run + 1 })
      .where(eq(enrollments.id, enr!.id))
    expect((await sendDue(deps)).sent).toBe(1)
    expect(outbox).toHaveLength(1)
  })

  it('one postcard per mailing address: a second LLC at the same address skips the mail step', async () => {
    const t = clock(TUESDAY)
    const { db, deps } = await setup({ now: t.now })
    await setSettings(db, { channels: { mail: true }, physical_address: ADDRESS })
    const { sequence } = await insertSequence(db, { channel: 'mail' }, [
      { delay_days: 0, body: 'Postcard' },
    ])
    const a = await insertLead(db, { mailing_street: '4253 Regent Sq', mailing_zip: '19104' })
    const b = await insertLead(db, {
      email: null,
      mailing_street: '4253 Regent Sq',
      mailing_zip: '19104',
    })
    await enrollLead(deps, a.id, sequence.id)
    await enrollLead(deps, b.id, sequence.id)

    const r = await sendDue(deps)
    expect(r).toMatchObject({ queued: 1, skipped: 1 })
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.lead_id).toBe(a.id)
    const [enrB] = await db.select().from(enrollments).where(eq(enrollments.lead_id, b.id))
    expect(enrB!.status).toBe('done') // the step was skipped, not left waiting
    const log = await db.select().from(activityLog)
    expect(log.find((l) => l.event === 'send_step_skipped')?.detail).toMatchObject({
      channel: 'mail',
      error: expect.stringContaining('postcard'),
    })

    // Sixty days on, the same address may get a postcard again.
    t.set(DECEMBER)
    await enrollLead(deps, b.id, sequence.id)
    expect((await sendDue(deps)).queued).toBe(1)
    expect(await db.select().from(messages)).toHaveLength(2)
  })
})
