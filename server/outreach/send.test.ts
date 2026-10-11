import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { activityLog, enrollments, leads, messages } from '../db/schema.ts'
import { enrollLead, restartDryRunEnrollments, stopLead } from './enroll.ts'
import { actOnQueueItem } from './queue.ts'
import {
  canRetry,
  idempotencyKey,
  MAX_SEND_ATTEMPTS,
  OUTCOME_UNKNOWN_ERROR,
  sendDue,
  signWebhookBody,
  webhookUrlProblem,
} from './send.ts'
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
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
    const { db, deps } = await setup({
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          headers: (init?.headers ?? {}) as Record<string, string>,
        })
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
    expect(calls[0]!.headers['x-outreach-signature']).toMatch(/^sha256=/)
    expect(calls[0]!.headers['x-outreach-secret']).toBeUndefined()
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

describe('sendDue: re-enrol, dry run to live, and at-most-once', () => {
  it('re-enrolling after a stop is a fresh run: step 1 really goes out again under a new key', async () => {
    const { db, deps, outbox } = await setup()
    await setSettings(db, { live_mode: true, physical_address: ADDRESS, email_provider: 'smtp' })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    expect((await sendDue(deps)).sent).toBe(1)
    await stopLead(deps, lead.id, 'manual')

    await enrollLead(deps, lead.id, sequence.id) // by hand, after the stop
    const [enr] = await db.select().from(enrollments)
    expect(enr!.run).toBe(1)
    expect(enr!.current_step).toBe(0)
    expect((await sendDue(deps)).sent).toBe(1)
    expect(outbox).toHaveLength(2)
    const rows = await db.select().from(messages)
    expect(rows.map((m) => m.idempotency_key).sort()).toEqual(
      [`${enr!.id}:0`, `${enr!.id}:r1:0`].sort(),
    )
    expect(rows.every((m) => m.status === 'sent')).toBe(true)
  })

  it('a sequence that only ever dry-ran starts over when Live mode is turned on', async () => {
    let t = new Date('2026-10-13T14:00:00.000Z')
    const { db, deps, outbox } = await setup({ now: () => t })
    await setSettings(db, { physical_address: ADDRESS })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    expect((await sendDue(deps)).dryRun).toBe(1)
    t = new Date('2026-10-16T15:00:00.000Z') // Friday 11:00, step 2 is due
    expect((await sendDue(deps)).dryRun).toBe(1)
    let [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('done')

    await setSettings(db, { live_mode: true })
    expect(await restartDryRunEnrollments(deps)).toBe(1)
    ;[enr] = await db.select().from(enrollments)
    expect(enr).toMatchObject({ status: 'active', current_step: 0, run: 1 })

    const r = await sendDue(deps)
    expect(r.sent).toBe(1)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.subject).toBe('Hi Lead') // step 1, not a silent walk past the dry-run rows
    expect(outbox[0]!.messageId).toMatch(/^<.+:r1:0@outreach\.test>$/)
    // Running it again on a live-sent enrollment changes nothing.
    expect(await restartDryRunEnrollments(deps)).toBe(0)
  })

  it('a row left in "sending" is never resent: it becomes failed with the outcome unknown', async () => {
    const { db, deps, outbox } = await setup()
    await setSettings(db, { live_mode: true, physical_address: ADDRESS })
    const lead = await insertLead(db)
    const { sequence, steps } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    const [enr] = await db.select().from(enrollments)
    await db.insert(messages).values({
      id: 'stuck',
      lead_id: lead.id,
      enrollment_id: enr!.id,
      step_id: steps[0]!.id,
      channel: 'email',
      status: 'sending',
      attempts: 1,
      idempotency_key: idempotencyKey(enr!.id, 0),
      body: 'x',
      created_at: deps.now().toISOString(),
    })

    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 1 })
    expect(outbox).toHaveLength(0)
    const [msg] = await db.select().from(messages)
    expect(msg!.status).toBe('failed')
    expect(msg!.error).toBe(OUTCOME_UNKNOWN_ERROR)
    const log = await db.select().from(activityLog)
    expect(log.some((l) => l.event === 'send_outcome_unknown')).toBe(true)
    // And it stays that way: no retry on the next tick either.
    expect((await sendDue(deps)).sent).toBe(0)
    expect(outbox).toHaveLength(0)
  })

  it('a failed send is retried once after a plain provider error and never after a timeout', async () => {
    let failWith: string | null = 'connect ECONNREFUSED 10.0.0.1:587'
    let calls = 0
    const { db, deps, outbox } = await setup({
      smtp: () => ({
        async sendMail(mail) {
          calls++
          if (failWith) throw new Error(failWith)
          outbox.push(mail)
          return { messageId: '<x@test.local>' }
        },
      }),
    })
    await setSettings(db, { live_mode: true, physical_address: ADDRESS })
    const a = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, a.id, sequence.id)

    expect((await sendDue(deps)).skipped).toBe(1)
    expect((await sendDue(deps)).skipped).toBe(1)
    expect((await sendDue(deps)).skipped).toBe(1) // third tick: no provider call any more
    expect(calls).toBe(MAX_SEND_ATTEMPTS)
    const [row] = await db.select().from(messages)
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_SEND_ATTEMPTS })
    expect(canRetry(row!)).toBe(false)

    failWith = 'Connection timed out'
    const b = await insertLead(db)
    await enrollLead(deps, b.id, sequence.id)
    const before = calls
    await sendDue(deps)
    expect(calls).toBe(before + 1)
    await sendDue(deps)
    expect(calls).toBe(before + 1) // a timeout may have delivered: nobody retries that
    const stuck = (await db.select().from(messages)).find((m) => m.lead_id === b.id)
    expect(stuck).toMatchObject({ status: 'failed', attempts: 1 })
    expect(outbox).toHaveLength(0)
  })

  it('a mail step for a lead with no mailing address is not queued and the enrollment ends', async () => {
    const { db, deps } = await setup()
    await setSettings(db, { channels: { mail: true }, mail_provider: 'print' })
    const lead = await insertLead(db, { mailing_street: null, mailing_zip: null })
    const { sequence } = await insertSequence(db, { channel: 'mail' }, [
      { delay_days: 0, body: 'Postcard' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 1 })
    expect(await db.select().from(messages)).toHaveLength(0) // no "To: null" card
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_manual')
    expect(enr!.next_send_at).toBeNull()
  })

  it('live Lob mail without a physical address is refused once per round and the rows stay queued', async () => {
    let lobCalls = 0
    const { db, deps } = await setup({
      fetch: async () => {
        lobCalls++
        return new Response('{"id":"psc_1"}', { status: 200 })
      },
    })
    deps.env = { ...deps.env, LOB_API_KEY: 'test-lob-key' }
    await setSettings(db, {
      live_mode: true,
      channels: { mail: true },
      mail_provider: 'lob',
      physical_address: '',
    })
    const { sequence } = await insertSequence(db, { channel: 'mail' }, [
      { delay_days: 0, body: 'Postcard' },
    ])
    for (let i = 0; i < 2; i++) await enrollLead(deps, (await insertLead(db)).id, sequence.id)
    expect(await sendDue(deps)).toEqual({ sent: 0, dryRun: 0, queued: 0, skipped: 2 })
    expect(lobCalls).toBe(0)
    const rows = await db.select().from(messages)
    expect(rows.map((m) => m.status)).toEqual(['queued', 'queued'])
    const log = await db.select().from(activityLog)
    expect(log.filter((l) => l.event === 'mail_refused_no_address')).toHaveLength(1)

    // With the address in, the same rows go to Lob.
    await setSettings(db, { physical_address: ADDRESS })
    expect((await sendDue(deps)).sent).toBe(2)
    expect(lobCalls).toBe(2)
  })

  it('the next human step waits while the last one sits in the queue, and queueing is not contact', async () => {
    let t = new Date('2026-10-13T14:00:00.000Z')
    const { db, deps } = await setup({ now: () => t })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db, { channel: 'linkedin' }, [
      { delay_days: 0, body: 'Connect {{first_name}}' },
      { delay_days: 3, body: 'Thanks for connecting {{first_name}}' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    expect((await sendDue(deps)).queued).toBe(1)
    let [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.last_contacted_at).toBeNull()
    expect(l!.status).toBe('enrolled')

    t = new Date('2026-10-16T15:00:00.000Z') // step 2 is due, but step 1 is still in the queue
    expect((await sendDue(deps)).queued).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(1)

    const [first] = await db.select().from(messages)
    await actOnQueueItem(deps, first!.id, 'done')
    ;[l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.last_contacted_at).not.toBeNull()
    expect((await sendDue(deps)).queued).toBe(1)
    expect(await db.select().from(messages)).toHaveLength(2)
  })

  it('the human queue webhook is signed, never carries the secret, and refuses unsafe URLs', () => {
    expect(signWebhookBody('s3cret', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(webhookUrlProblem('https://hooks.example.com/in')).toBeNull()
    expect(webhookUrlProblem('http://hooks.example.com/in')).toMatch(/https/)
    expect(webhookUrlProblem('https://localhost:5300/api/webhooks/outcome')).toMatch(/private/)
    expect(webhookUrlProblem('https://169.254.169.254/')).toMatch(/private/)
    expect(webhookUrlProblem('https://10.1.2.3/')).toMatch(/private/)
    expect(webhookUrlProblem('not a url')).toMatch(/valid/)
  })
})
