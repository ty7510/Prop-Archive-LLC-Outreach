import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { SendingInbox } from '../../shared/settings.ts'
import { enrollments, messages, sequenceSteps, sequences } from '../db/schema.ts'
import { getSettings } from '../lib/settings.ts'
import { seed, ensureMainSequence, MAIN_SEQUENCE_NAME } from '../seed/index.ts'
import type { OutgoingMail } from './deps.ts'
import { enrollEligible, enrollLead } from './enroll.ts'
import { actOnQueueItem } from './queue.ts'
import { sendDue } from './send.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

const ADDRESS = '123 Main St, Philadelphia, PA 19146'
const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')

function inbox(email: string, patch: Partial<SendingInbox> = {}): SendingInbox {
  return {
    id: email,
    from_name: 'Theo Young',
    email,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_user: email,
    smtp_pass: 'app-password',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    daily_limit: 30,
    active: true,
    ...patch,
  }
}

const MIXED_STEPS = [
  {
    delay_days: 0,
    channel: 'email' as const,
    subject: 'Hi {{first_name}}',
    body: 'Email {{demo_link}}',
  },
  { delay_days: 3, channel: 'linkedin' as const, body: 'Hi {{first_name}}, note.' },
  { delay_days: 5, channel: 'mail' as const, body: 'Hi {{first_name}}, card. {{demo_link}}' },
]

/** A fixture whose warmed inboxes record what each one sent. */
async function inboxSetup(at: { now: Date }) {
  const sent: { from: string; address: string; mail: OutgoingMail }[] = []
  const fx = await setup({
    now: () => at.now,
    smtpForInbox: (i, address) => ({
      async sendMail(mail) {
        sent.push({ from: i.email, address, mail })
        return { messageId: `<${sent.length}@inbox.test>` }
      },
    }),
  })
  return { ...fx, sent }
}

describe('a sequence that changes channel step by step', () => {
  it('emails from a warmed inbox, then queues a LinkedIn task, then a postcard', async () => {
    const at = { now: TUESDAY_10AM }
    const { db, deps, sent } = await inboxSetup(at)
    await setSettings(db, {
      live_mode: true,
      physical_address: ADDRESS,
      mail_provider: 'print',
      channels: { email: true, linkedin: true, mail: true },
      sending_inboxes: [inbox('theo@warm-one.com')],
    })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db, { name: 'Mixed' }, MIXED_STEPS)
    await enrollLead(deps, lead.id, sequence.id)

    expect(await sendDue(deps)).toMatchObject({ sent: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.from).toBe('theo@warm-one.com')
    expect(sent[0]!.address).toBe('142.250.1.108') // the checked address, not a fresh lookup
    expect(sent[0]!.mail.from).toBe('Theo Young <theo@warm-one.com>')
    expect(sent[0]!.mail.replyTo).toBe('theo@warm-one.com')
    const [email] = await db.select().from(messages)
    expect(email).toMatchObject({
      channel: 'email',
      status: 'sent',
      provider: 'smtp:theo@warm-one.com',
    })

    at.now = new Date('2026-10-16T16:00:00.000Z') // Friday, after the 3 day gap
    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
    const task = (await db.select().from(messages)).find((m) => m.channel === 'linkedin')
    expect(task).toMatchObject({ status: 'ready_for_human', to_address: lead.linkedin_url })

    // The postcard does not wait for the LinkedIn task: his tasks never hold up another channel.
    at.now = new Date('2026-10-23T16:00:00.000Z')
    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
    const card = (await db.select().from(messages)).find((m) => m.channel === 'mail')
    expect(card).toMatchObject({ status: 'ready_for_human' })
    expect(card!.to_address).toContain('Philadelphia')
    expect(sent).toHaveLength(1) // only the email went through SMTP
  })

  it('a LinkedIn message still waits for the open connection note before it', async () => {
    const at = { now: TUESDAY_10AM }
    const { db, deps } = await inboxSetup(at)
    await setSettings(db, { channels: { email: true, linkedin: true, mail: true } })
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db, { name: 'Two notes' }, [
      { delay_days: 0, channel: 'linkedin' as const, body: 'Hi {{first_name}}, note.' },
      { delay_days: 1, channel: 'linkedin' as const, body: 'Thanks for connecting.' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
    at.now = new Date('2026-10-16T16:00:00.000Z')
    expect(await sendDue(deps)).toMatchObject({ queued: 0 })
    const note = (await db.select().from(messages))[0]!
    await actOnQueueItem(deps, note.id, 'done')
    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
  })

  it('a lead with no email skips the email step and gets the LinkedIn task right away', async () => {
    const at = { now: TUESDAY_10AM }
    const { db, deps, sent } = await inboxSetup(at)
    await setSettings(db, { physical_address: ADDRESS, sending_inboxes: [inbox('a@warm.com')] })
    const lead = await insertLead(db, {
      email: null,
      channels: { email: false, mail: true, linkedin: true, instagram: false, call: true },
    })
    const { sequence } = await insertSequence(db, { name: 'Mixed' }, MIXED_STEPS)
    await enrollLead(deps, lead.id, sequence.id)

    expect(await sendDue(deps)).toMatchObject({ skipped: 1 })
    const [enr] = await db.select().from(enrollments)
    expect(enr).toMatchObject({ status: 'active', current_step: 1 })
    expect(enr!.next_send_at).toBe(TUESDAY_10AM.toISOString()) // no 3 day wait after a skip

    expect(await sendDue(deps)).toMatchObject({ queued: 1 })
    const rows = await db.select().from(messages)
    expect(rows.map((m) => m.channel)).toEqual(['linkedin'])
    expect(sent).toHaveLength(0)
  })

  it('skips the LinkedIn step when research found no profile, and keeps the schedule', async () => {
    const at = { now: TUESDAY_10AM }
    const { db, deps } = await inboxSetup(at)
    await setSettings(db, { channels: { email: true, linkedin: true, mail: true } })
    const lead = await insertLead(db, { linkedin_url: null })
    const { sequence } = await insertSequence(db, { name: 'Mixed' }, MIXED_STEPS)
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toMatchObject({ dryRun: 1 }) // the email

    at.now = new Date('2026-10-16T16:00:00.000Z') // the LinkedIn step comes due
    expect(await sendDue(deps)).toMatchObject({ queued: 0, skipped: 1 })
    const [enr] = await db.select().from(enrollments)
    expect(enr!.current_step).toBe(2)
    // The postcard keeps its own 5 day wait instead of jumping forward.
    expect(new Date(enr!.next_send_at!).getTime()).toBeGreaterThan(
      new Date('2026-10-20T00:00:00.000Z').getTime(),
    )
    const rows = await db.select().from(messages)
    expect(rows.map((m) => m.channel)).toEqual(['email'])
  })

  it('clears old LinkedIn tasks that have no profile to open', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db)
    const task = {
      lead_id: lead.id,
      channel: 'linkedin' as const,
      direction: 'out' as const,
      status: 'ready_for_human' as const,
      body: 'note',
      created_at: TUESDAY_10AM.toISOString(),
    }
    await db.insert(messages).values([
      { ...task, id: 'm1', idempotency_key: 'k1', to_address: null },
      { ...task, id: 'm2', idempotency_key: 'k2', to_address: 'https://www.linkedin.com/in/x' },
    ])
    await sendDue(deps)
    const rows = await db.select().from(messages)
    expect(rows.find((m) => m.id === 'm1')!.status).toBe('skipped')
    expect(rows.find((m) => m.id === 'm2')!.status).toBe('ready_for_human')
  })

  it('ends the enrollment when no later step can reach the lead either', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db, { email: null, mailing_street: null, mailing_zip: null })
    const { sequence } = await insertSequence(db, { name: 'Email then mail' }, [
      MIXED_STEPS[0]!,
      MIXED_STEPS[2]!,
    ])
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_manual')
  })
})

describe('warmed inbox rotation', () => {
  it('takes turns between inboxes and never passes one inbox daily limit', async () => {
    const at = { now: TUESDAY_10AM }
    const { db, deps, sent } = await inboxSetup(at)
    await setSettings(db, {
      live_mode: true,
      physical_address: ADDRESS,
      sending_inboxes: [
        inbox('one@warm.com', { daily_limit: 1 }),
        inbox('two@warm.com', { daily_limit: 1 }),
        inbox('off@warm.com', { active: false }),
        inbox('nopass@warm.com', { smtp_pass: '' }),
      ],
    })
    const { sequence } = await insertSequence(db, { name: 'Mixed' }, MIXED_STEPS)
    for (let i = 0; i < 3; i++) {
      const lead = await insertLead(db)
      await enrollLead(deps, lead.id, sequence.id)
    }

    const r = await sendDue(deps)
    expect(r).toMatchObject({ sent: 2, skipped: 1 })
    expect(sent.map((s) => s.from).sort()).toEqual(['one@warm.com', 'two@warm.com'])
    // The third email waits for tomorrow, untouched (no attempt claimed).
    const waiting = (await db.select().from(messages)).filter((m) => m.status === 'queued')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.attempts).toBe(0)

    at.now = new Date('2026-10-14T14:00:00.000Z') // Wednesday
    expect(await sendDue(deps)).toMatchObject({ sent: 1 })
    expect(sent).toHaveLength(3)
  })
})

describe('the main sequence', () => {
  it('switches a seeded database over once: main on, the rest off, channels set', async () => {
    const { db } = await setup()
    await seed(db)
    const first = await ensureMainSequence(db)
    expect(first.switched).toBe(true)
    const all = await db.select().from(sequences)
    expect(all.filter((s) => s.active).map((s) => s.name)).toEqual([MAIN_SEQUENCE_NAME])
    const settings = await getSettings(db)
    expect(settings.main_sequence_id).toBe(first.id)
    expect(settings.channels).toEqual({
      email: true,
      linkedin: true,
      mail: true,
      instagram: false,
      call: false,
    })

    // Theo switches an old one back on: later boots leave it alone.
    const other = all.find((s) => s.name !== MAIN_SEQUENCE_NAME)!
    await db.update(sequences).set({ active: true }).where(eq(sequences.id, other.id))
    expect((await ensureMainSequence(db)).switched).toBe(false)
    const [still] = await db.select().from(sequences).where(eq(sequences.id, other.id))
    expect(still!.active).toBe(true)
  })

  it('upgrades the old main sequence in place: same id, new steps, leads keep their step', async () => {
    const { db, deps } = await setup()
    const { sequence: old } = await insertSequence(
      db,
      { name: 'Email, LinkedIn, then mail' },
      MIXED_STEPS,
    )
    const lead = await insertLead(db)
    await enrollLead(deps, lead.id, old.id)
    await db.update(enrollments).set({ current_step: 1 })
    const main = await ensureMainSequence(db)
    expect(main).toMatchObject({ id: old.id, upgraded: true, created: false })
    const [row] = await db.select().from(sequences).where(eq(sequences.id, old.id))
    expect(row!.name).toBe(MAIN_SEQUENCE_NAME)
    const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.sequence_id, old.id))
    expect(steps.sort((a, b) => a.step_index - b.step_index).map((s) => s.channel)).toEqual([
      'email',
      'linkedin',
      'email',
      'mail',
      'email',
    ])
    const [enr] = await db.select().from(enrollments)
    expect(enr).toMatchObject({ sequence_id: old.id, current_step: 1, status: 'active' })
    // Only once: a second boot changes nothing.
    expect((await ensureMainSequence(db)).upgraded).toBe(false)
    expect(await db.select().from(sequences)).toHaveLength(1)
  })

  it('puts new leads into the main sequence, also leads with no email', async () => {
    const { db, deps } = await setup()
    await seed(db)
    const main = await ensureMainSequence(db)
    const withEmail = await insertLead(db)
    const noEmail = await insertLead(db, {
      email: null,
      channels: { email: false, mail: true, linkedin: false, instagram: false, call: false },
    })
    expect(await enrollEligible(deps)).toEqual({ enrolled: 2 })
    const rows = await db.select().from(enrollments)
    expect(rows.map((r) => r.sequence_id)).toEqual([main.id, main.id])
    expect(rows.map((r) => r.lead_id).sort()).toEqual([withEmail.id, noEmail.id].sort())
  })
})
