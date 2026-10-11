import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { enrollments, events, leads, messages, suppression } from '../db/schema.ts'
import type { ImapClient, ImapMessage, Llm } from './deps.ts'
import { enrollLead } from './enroll.ts'
import { sendDue } from './send.ts'
import {
  classifyByKeywords,
  classifyReply,
  matchLead,
  nextLeadStatus,
  parseRawMail,
  stripQuoted,
  syncReplies,
} from './replies.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

describe('classifyByKeywords', () => {
  it('sorts the obvious cases', () => {
    expect(classifyByKeywords('Re: hi', 'Please unsubscribe me')).toBe('unsubscribe')
    expect(classifyByKeywords('Re: hi', 'STOP')).toBe('unsubscribe')
    expect(classifyByKeywords('Re: hi', 'remove me from your list')).toBe('unsubscribe')
    expect(
      classifyByKeywords('Undeliverable: hi', 'Delivery has failed', 'mailer-daemon@x.com'),
    ).toBe('bounce')
    expect(classifyByKeywords('Re: hi', 'The address could not be delivered to')).toBe('bounce')
    expect(classifyByKeywords('Re: hi', 'Sure, happy to book a demo next week')).toBe('interested')
    expect(classifyByKeywords('Re: hi', 'Can you give me a call tomorrow?')).toBe('interested')
    expect(classifyByKeywords('Re: hi', 'Not interested, thanks')).toBe('not_interested')
    expect(classifyByKeywords('Re: hi', 'Not right now, maybe circle back next quarter')).toBe(
      'not_now',
    )
    expect(classifyByKeywords('Re: hi', 'Great, booked for Tuesday')).toBe('booked')
    expect(classifyByKeywords('Out of office', 'I am away until Monday')).toBe('other')
  })

  it('bounce wins over anything else in the body', () => {
    expect(classifyByKeywords('Delivery Status Notification (Failure)', 'book a demo')).toBe(
      'bounce',
    )
  })
})

describe('classifyReply with a model', () => {
  it('uses the model answer and falls back to keywords when it fails or is missing', async () => {
    const llm: Llm = {
      text: async () => null,
      structured: async () => ({ classification: 'not_now' }) as never,
    }
    expect(await classifyReply(llm, 'Re', 'Sure, book a demo')).toBe('not_now')
    const broken: Llm = {
      text: async () => null,
      structured: async () => {
        throw new Error('down')
      },
    }
    expect(await classifyReply(broken, 'Re', 'Sure, book a demo')).toBe('interested')
    expect(await classifyReply(null, 'Re', 'Sure, book a demo')).toBe('interested')
    // Bounces never go to the model.
    let called = 0
    const counting: Llm = {
      text: async () => null,
      structured: async () => {
        called++
        return null
      },
    }
    expect(await classifyReply(counting, 'Undeliverable', 'x', 'mailer-daemon@m')).toBe('bounce')
    expect(called).toBe(0)
  })
})

const RAW = [
  'From: "Ray Example" <ray@example.com>',
  'To: theo@proparchive.biz',
  'Subject: Re: Hi Ray',
  'Message-ID: <reply-1@example.com>',
  'In-Reply-To: <1@test.local>',
  'References: <0@test.local> <1@test.local>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Sure, happy to book a demo.',
  '',
  'On Tue, Oct 13, 2026 at 10:00 AM Theo <theo@proparchive.biz> wrote:',
  '> Hello Ray.',
  '> No more emails: https://outreach.test/u/x',
].join('\r\n')

describe('parseRawMail', () => {
  it('reads headers, strips the quoted history, finds the thread ids', () => {
    const m = parseRawMail(Buffer.from(RAW))
    expect(m.from).toBe('ray@example.com')
    expect(m.fromName).toBe('Ray Example')
    expect(m.subject).toBe('Re: Hi Ray')
    expect(m.messageId).toBe('<reply-1@example.com>')
    expect(m.inReplyTo).toBe('<1@test.local>')
    expect(m.references).toEqual(['<0@test.local>', '<1@test.local>'])
    expect(m.text).toBe('Sure, happy to book a demo.')
  })

  it('picks the text/plain part of a multipart mail and decodes quoted-printable', () => {
    const raw = [
      'From: a@b.co',
      'Subject: Re',
      'Content-Type: multipart/alternative; boundary="XYZ"',
      '',
      '--XYZ',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Please remove me =3D now',
      '--XYZ',
      'Content-Type: text/html',
      '',
      '<p>Please remove me</p>',
      '--XYZ--',
    ].join('\r\n')
    const m = parseRawMail(raw)
    expect(m.text).toBe('Please remove me = now')
    expect(m.from).toBe('a@b.co')
  })

  it('stripQuoted keeps the first part', () => {
    expect(stripQuoted('yes\n\n-- \nsig')).toBe('yes')
    expect(stripQuoted('yes\n> quoted')).toBe('yes')
  })
})

function fakeImap(mails: ImapMessage[], log: string[] = []): () => ImapClient {
  return () => ({
    async connect() {
      log.push('connect')
    },
    async mailboxOpen(path: string) {
      log.push(`open ${path}`)
      return {}
    },
    async search() {
      return mails.map((m) => m.uid)
    },
    async fetchAll() {
      return mails
    },
    async logout() {
      log.push('logout')
    },
  })
}

describe('syncReplies', () => {
  it('returns 0 and touches nothing without IMAP keys', async () => {
    const { deps } = await setup()
    expect(await syncReplies(deps)).toEqual({ received: 0 })
  })

  it('matches by thread id, records the reply, stops outreach, notifies Theo, and is idempotent', async () => {
    const log: string[] = []
    const mails: ImapMessage[] = [{ uid: 7, source: Buffer.from(RAW) }]
    const { db, deps, outbox } = await setup({ imap: fakeImap(mails, log) })
    await setSettings(db, {
      live_mode: true,
      physical_address: '1 Main St, Philadelphia, PA 19146',
    })
    const lead = await insertLead(db, { email: 'ray@example.com', full_name: 'Ray Example' })
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    expect((await sendDue(deps)).sent).toBe(1) // provider_message_id becomes <1@test.local>
    expect(outbox).toHaveLength(1)

    const r = await syncReplies(deps)
    expect(r).toEqual({ received: 1 })
    expect(log).toEqual(['connect', 'open INBOX', 'logout'])

    const inbound = (await db.select().from(messages)).filter((m) => m.direction === 'in')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({
      status: 'received',
      classification: 'interested',
      lead_id: lead.id,
      body: 'Sure, happy to book a demo.',
      idempotency_key: 'in:<reply-1@example.com>',
    })
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_replied')
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.status).toBe('replied')
    expect(l!.last_replied_at).not.toBeNull()
    expect((await db.select().from(events)).some((e) => e.kind === 'reply')).toBe(true)

    // Owner notification: one more mail in the outbox, to the owner, with the snippet.
    expect(outbox).toHaveLength(2)
    expect(outbox[1]!.to).toBe('theo@proparchive.biz')
    expect(outbox[1]!.subject).toMatch(/^Reply from Ray Example: /)
    expect(outbox[1]!.text).toContain('Sure, happy to book a demo.')

    // Same mail again: nothing new.
    expect(await syncReplies(deps)).toEqual({ received: 0 })
    expect(outbox).toHaveLength(2)
  })

  it('matches by From address, adds suppression on unsubscribe and bounce, no owner mail for a bounce', async () => {
    const unsub = [
      'From: lead@one.com',
      'Subject: Re: Hi',
      'Message-ID: <u1@one.com>',
      '',
      'Please unsubscribe me.',
    ].join('\r\n')
    const bounce = [
      'From: Mail Delivery System <mailer-daemon@mx.test>',
      'Subject: Undeliverable: Hi',
      'Message-ID: <b1@mx.test>',
      'In-Reply-To: <bounced-id>',
      '',
      'Delivery has failed to these recipients.',
    ].join('\r\n')
    const stranger = [
      'From: nobody@nowhere.test',
      'Subject: hello',
      'Message-ID: <s@n>',
      '',
      'hi',
    ].join('\r\n')
    const { db, deps, outbox } = await setup({
      imap: fakeImap([
        { uid: 1, source: Buffer.from(unsub) },
        { uid: 2, source: Buffer.from(bounce) },
        { uid: 3, source: Buffer.from(stranger) },
      ]),
    })
    await setSettings(db, { physical_address: '1 Main St' })
    const one = await insertLead(db, {
      email: 'lead@one.com',
      last_contacted_at: '2026-10-12T15:00:00.000Z',
    })
    const two = await insertLead(db, {
      email: 'lead@two.com',
      last_contacted_at: '2026-10-12T15:00:00.000Z',
    })
    await db.insert(messages).values({
      id: 'm-two',
      lead_id: two.id,
      channel: 'email',
      direction: 'out',
      status: 'sent',
      idempotency_key: 'x:0',
      body: 'x',
      provider_message_id: '<bounced-id>',
      created_at: '2026-10-12T15:00:00.000Z',
    })

    expect(await syncReplies(deps)).toEqual({ received: 2 })
    const sups = await db.select().from(suppression)
    expect(sups.map((s) => [s.kind, s.value]).sort()).toEqual([
      ['email', 'lead@one.com'],
      ['email', 'lead@two.com'],
    ])
    const [l1] = await db.select().from(leads).where(eq(leads.id, one.id))
    const [l2] = await db.select().from(leads).where(eq(leads.id, two.id))
    expect(l1!.status).toBe('unsubscribed')
    expect(l2!.status).toBe('bounced')
    expect(l2!.email_status).toBe('invalid')
    // Owner was told about the unsubscribe only, not the bounce.
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.subject).toMatch(/^Reply from Lead/)
  })

  it('matchLead ignores mails from nobody we contacted', async () => {
    const { db } = await setup()
    await insertLead(db, { email: 'never@contacted.com' }) // last_contacted_at null
    const m = parseRawMail('From: never@contacted.com\r\nSubject: x\r\n\r\nhi')
    expect(await matchLead(db, m)).toBeNull()
  })
})

describe('replies that must not undo a result', () => {
  it('a routine reply from a booked lead keeps the booked status and still notifies Theo', async () => {
    const raw = [
      'From: Jane Owner <jane@one.com>',
      'Subject: Re: Hi',
      'Message-ID: <j1@one.com>',
      '',
      'Looking forward to it.',
    ].join('\r\n')
    const { db, deps, outbox } = await setup({
      imap: fakeImap([{ uid: 1, source: Buffer.from(raw) }]),
    })
    await setSettings(db, { physical_address: '1 Main St' })
    const jane = await insertLead(db, {
      email: 'jane@one.com',
      status: 'booked',
      last_contacted_at: '2026-10-12T15:00:00.000Z',
    })
    expect(await syncReplies(deps)).toEqual({ received: 1 })
    const [l] = await db.select().from(leads).where(eq(leads.id, jane.id))
    expect(l!.status).toBe('booked')
    expect(l!.last_replied_at).not.toBeNull()
    expect((await db.select().from(events)).some((e) => e.kind === 'reply')).toBe(true)
    // The notice to Theo is plain mail to himself: no unsubscribe headers pointing nowhere.
    expect(outbox).toHaveLength(1)
    expect(outbox[0]!.to).toBe('theo@proparchive.biz')
    expect(outbox[0]!.headers).toBeUndefined()
  })

  it('nextLeadStatus keeps final statuses except for an unsubscribe or a bounce', () => {
    expect(nextLeadStatus('booked', 'interested')).toBeNull()
    expect(nextLeadStatus('joined', 'other')).toBeNull()
    expect(nextLeadStatus('not_interested', 'not_now')).toBeNull()
    expect(nextLeadStatus('booked', 'unsubscribe')).toBe('unsubscribed')
    expect(nextLeadStatus('booked', 'bounce')).toBe('bounced')
    expect(nextLeadStatus('contacted', 'interested')).toBe('replied')
    expect(nextLeadStatus('contacted', 'booked')).toBe('booked')
  })
})

describe('bounces without a thread id', () => {
  it('a mailer-daemon report is matched by the dead address inside it, then suppressed', async () => {
    const dsn = [
      'From: Mail Delivery System <MAILER-DAEMON@mx.example.net>',
      'To: theo@proparchive.biz',
      'Subject: Undelivered Mail Returned to Sender',
      'Message-ID: <dsn-1@mx.example.net>',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain',
      '',
      'This is the mail system at host mx.example.net.',
      '',
      '<dead@two.com>: host mail.two.com said: 550 5.1.1 User unknown',
      '--B1',
      'Content-Type: message/delivery-status',
      '',
      'Final-Recipient: rfc822; dead@two.com',
      'Action: failed',
      'Status: 5.1.1',
      '--B1--',
    ].join('\r\n')
    const { db, deps, outbox } = await setup({
      imap: fakeImap([{ uid: 9, source: Buffer.from(dsn) }]),
    })
    const two = await insertLead(db, {
      email: 'dead@two.com',
      last_contacted_at: '2026-10-12T15:00:00.000Z',
    })
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, two.id, sequence.id)

    const parsed = parseRawMail(dsn)
    expect(parsed.inReplyTo).toBeNull()
    expect(parsed.allAddresses).toContain('dead@two.com')
    expect(await matchLead(db, parsed, new Set(['theo@proparchive.biz']))).toMatchObject({
      id: two.id,
    })

    expect(await syncReplies(deps)).toEqual({ received: 1 })
    const [l] = await db.select().from(leads).where(eq(leads.id, two.id))
    expect(l!.status).toBe('bounced')
    expect(l!.email_status).toBe('invalid')
    expect((await db.select().from(suppression)).map((s) => s.value)).toEqual(['dead@two.com'])
    const [enr] = await db.select().from(enrollments)
    expect(enr!.status).toBe('stopped_bounced')
    expect(outbox).toHaveLength(0) // no owner mail for a bounce
  })

  it('a bounce that only quotes our own message id is matched through it', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db, { last_contacted_at: '2026-10-12T15:00:00.000Z' })
    await db.insert(messages).values({
      id: 'm-out',
      lead_id: lead.id,
      channel: 'email',
      direction: 'out',
      status: 'sent',
      idempotency_key: 'k-out',
      body: 'hi',
      provider_message_id: '<our-id@outreach.test>',
      created_at: deps.now().toISOString(),
    })
    const raw = [
      'From: postmaster@elsewhere.test',
      'Subject: Delivery Status Notification (Failure)',
      'Message-ID: <n1@elsewhere.test>',
      '',
      'The original message had Message-ID: <our-id@outreach.test>',
    ].join('\r\n')
    expect(await matchLead(db, parseRawMail(raw))).toMatchObject({ id: lead.id })
    // A normal mail from a stranger quoting an id is still nobody: only bounces look inside.
    const plain = raw
      .replace('postmaster@elsewhere.test', 'someone@elsewhere.test')
      .replace('Delivery Status Notification (Failure)', 'hello')
    expect(await matchLead(db, parseRawMail(plain))).toBeNull()
  })
})

describe('a From-only match', () => {
  it('never marks a lead booked when the reply is outside our thread', async () => {
    const llm: Llm = {
      text: async () => null,
      structured: async () => ({ classification: 'booked' }) as never,
    }
    const raw = [
      'From: Owner <owner@spoof.com>',
      'To: theo@proparchive.biz',
      'Subject: booked',
      'Message-ID: <spoof-1@spoof.com>',
      '',
      'Booked for Tuesday.',
    ].join('\r\n')
    const { db, deps } = await setup({
      llm,
      imap: fakeImap([{ uid: 3, source: Buffer.from(raw) }]),
    })
    const lead = await insertLead(db, {
      email: 'owner@spoof.com',
      last_contacted_at: '2026-10-12T15:00:00.000Z',
    })
    expect(await syncReplies(deps)).toEqual({ received: 1 })
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.status).toBe('replied')
  })
})
