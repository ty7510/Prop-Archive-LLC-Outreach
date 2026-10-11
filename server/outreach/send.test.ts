import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityLog, enrollments, leads, messages } from '../db/schema.ts'
import { enrollLead, stopLead } from './enroll.ts'
import { sendDue } from './send.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

const ADDRESS = '123 Main St, Philadelphia, PA 19146'

describe('sendDue', () => {
  it('does nothing outside the send window', async () => {
    const { db, deps } = await setup({ now: () => new Date('2026-10-13T23:30:00.000Z') }) // 19:30 EDT
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 0 })
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('dry run writes dry_run rows, never calls the mailer, and advances the enrollment', async () => {
    const { db, deps, outbox } = await setup()
    await setSettings(db, { physical_address: ADDRESS })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)

    const r = await sendDue(deps)
    expect(r).toEqual({ sent: 0, dryRun: 1, queued: 0, skipped: 0 })
    expect(outbox).toHaveLength(0)
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'dry_run',
      channel: 'email',
      to_address: lead.email,
      subject: 'Hi Lead',
    })
    expect(rows[0]!.idempotency_key).toMatch(/:0$/)
    expect(rows[0]!.body).toContain('No more emails: https://outreach.test/u/')
    expect(rows[0]!.body).toContain(ADDRESS)

    const [enr] = await db.select().from(enrollments)
    expect(enr!.current_step).toBe(1)
    expect(enr!.status).toBe('active')
    expect(enr!.next_send_at).toBe('2026-10-16T14:00:00.000Z') // +3 days, Friday 10:00
    // Dry run does not pretend the lead was contacted.
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.last_contacted_at).toBeNull()
    expect(l!.status).toBe('enrolled')
  })

  it('live mode sends once, with CAN-SPAM headers, and running twice never sends twice', async () => {
    const { db, deps, outbox } = await setup()
    await setSettings(db, { live_mode: true, physical_address: ADDRESS, email_provider: 'smtp' })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)

    const first = await sendDue(deps)
    expect(first).toEqual({ sent: 1, dryRun: 0, queued: 0, skipped: 0 })
    expect(outbox).toHaveLength(1)
    const mail = outbox[0]!
    expect(mail.to).toBe(lead.email)
    expect(mail.from).toBe('Theo at Prop Archive <theo@proparchive.biz>')
    expect(mail.headers?.['List-Unsubscribe']).toContain(
      `https://outreach.test/u/${lead.unsubscribe_token}`,
    )
    expect(mail.headers?.['List-Unsubscribe']).toContain('mailto:')
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(mail.text).toContain(ADDRESS)
    expect(mail.html).toContain('<a href=')

    // Second run: step 1 is no longer due (3 days out), and step 0 is already recorded.
    const second = await sendDue(deps)
    expect(second).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 0 })
    expect(outbox).toHaveLength(1)

    // Force the enrollment back to step 0 as if the advance never happened (crash after send).
    const [enr] = await db.select().from(enrollments)
    await db
      .update(enrollments)
      .set({ current_step: 0, next_send_at: '2026-10-13T13:00:00.000Z' })
      .where(eq(enrollments.id, enr!.id))
    const third = await sendDue(deps)
    expect(third.sent).toBe(0)
    expect(outbox).toHaveLength(1) // idempotency key held: no second email
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'sent',
      provider: 'smtp',
      provider_message_id: '<1@test.local>',
    })
    const [after] = await db.select().from(enrollments)
    expect(after!.current_step).toBe(1)

    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.status).toBe('contacted')
    expect(l!.last_contacted_at).not.toBeNull()
  })

  it('refuses live email when the physical address is empty: message stays queued, error logged', async () => {
    const { db, deps, outbox } = await setup()
    await setSettings(db, { live_mode: true, physical_address: '' })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)

    const r = await sendDue(deps)
    expect(r).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 1 })
    expect(outbox).toHaveLength(0)
    const [msg] = await db.select().from(messages)
    expect(msg!.status).toBe('queued')
    const [enr] = await db.select().from(enrollments)
    expect(enr!.current_step).toBe(0)
    const log = await db.select().from(activityLog)
    expect(log.some((l) => l.level === 'error' && l.event === 'email_refused_no_address')).toBe(
      true,
    )

    // Once the address is in, the same queued row is sent (still one row, one email).
    await setSettings(db, { physical_address: ADDRESS })
    const r2 = await sendDue(deps)
    expect(r2.sent).toBe(1)
    expect(outbox).toHaveLength(1)
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('human channels become ready_for_human even in dry run and call the webhook once', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const { db, deps } = await setup({
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return new Response('ok', { status: 200 })
      },
    })
    await setSettings(db, { human_queue_webhook_url: 'https://hooks.test/in' })
    const lead = await insertLead(db)
    const li = await insertSequence(db, { channel: 'linkedin', name: 'LI' }, [
      { delay_days: 0, body: 'Connect {{first_name}}' },
    ])
    const call = await insertSequence(db, { channel: 'call', name: 'Call' }, [
      { delay_days: 0, body: 'Script for {{full_name}}' },
    ])
    await enrollLead(deps, lead.id, li.sequence.id)
    await enrollLead(deps, lead.id, call.sequence.id)

    const r = await sendDue(deps)
    expect(r).toEqual({ sent: 0, dryRun: 0, queued: 2, skipped: 0 })
    const rows = await db.select().from(messages)
    expect(rows.map((m) => [m.channel, m.status, m.to_address]).sort()).toEqual([
      ['call', 'ready_for_human', lead.phone],
      ['linkedin', 'ready_for_human', lead.linkedin_url],
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://hooks.test/in')
    expect(calls.map((c) => (c.body as { channel: string }).channel).sort()).toEqual([
      'call',
      'linkedin',
    ])

    // One-step sequences are done after the first step.
    const enrs = await db.select().from(enrollments)
    expect(enrs.every((e) => e.status === 'done')).toBe(true)

    // A second run adds nothing and does not call the webhook again.
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 0 })
    expect(calls).toHaveLength(2)
  })

  it('print mail becomes ready_for_human with a postal address', async () => {
    const { db, deps } = await setup()
    await setSettings(db, { channels: { mail: true }, mail_provider: 'print' })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db, { channel: 'mail' }, [
      { delay_days: 0, body: 'Postcard for {{first_name}} in {{neighborhood}}' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 1, skipped: 0 })
    const [msg] = await db.select().from(messages)
    expect(msg!.status).toBe('ready_for_human')
    expect(JSON.parse(msg!.to_address!)).toMatchObject({
      street: lead.mailing_street,
      zip: '19146',
    })
    expect(msg!.body).toBe('Postcard for Lead in Point Breeze/Graduate Hospital')
  })

  it('enforces the daily cap per channel', async () => {
    const { db, deps } = await setup()
    await setSettings(db, { daily_caps: { email: 2 } })
    const { sequence } = await insertSequence(db)
    for (let i = 0; i < 4; i++) {
      const lead = await insertLead(db)
      await enrollLead(deps, lead.id, sequence.id)
    }
    const r = await sendDue(deps)
    expect(r.dryRun).toBe(2)
    expect(r.skipped).toBe(2)
    // Next run the same day: cap already used up.
    expect((await sendDue(deps)).dryRun).toBe(0)
  })

  it('skips and stops leads that became blocked (do_not_contact, suppression, replied)', async () => {
    const { db, deps } = await setup()
    const { sequence } = await insertSequence(db)
    const a = await insertLead(db)
    const b = await insertLead(db)
    await enrollLead(deps, a.id, sequence.id)
    await enrollLead(deps, b.id, sequence.id)
    await db.update(leads).set({ do_not_contact: true }).where(eq(leads.id, a.id))
    await db.update(leads).set({ status: 'replied' }).where(eq(leads.id, b.id))
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 2 })
    const enrs = await db.select().from(enrollments)
    expect(enrs.map((e) => e.status).sort()).toEqual(['stopped_manual', 'stopped_replied'])
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('skips channels turned off in settings without touching the enrollment', async () => {
    const { db, deps } = await setup()
    await setSettings(db, { channels: { linkedin: false } })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db, { channel: 'linkedin' }, [
      { delay_days: 0, body: 'x' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 1 })
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('active')
  })

  it('stopLead ends enrollments with the right status', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    expect(await stopLead(deps, lead.id, 'bounced')).toBe(1)
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_bounced')
    expect(enr!.next_send_at).toBeNull()
    expect(await stopLead(deps, lead.id, 'manual')).toBe(0)
  })
})
