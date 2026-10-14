import { beforeEach, describe, expect, it } from 'vitest'
import type { SendingInbox } from '../../shared/settings.ts'
import { messages } from '../db/schema.ts'
import { listActivity } from '../lib/activity.ts'
import { enrollLead } from './enroll.ts'
import {
  base64Url,
  createGmailApi,
  gmailInboxReader,
  GmailError,
  CONNECT_STEPS,
  isGmailAuthError,
  type GmailApi,
  type GoogleAccount,
} from './gmail.ts'
import {
  canRead,
  canSend,
  googleSignedIn,
  isLoginRefused,
  noteLoginRefused,
  refreshGoogleAccount,
  resetGoogleAccount,
  resetLoginProblems,
  resetReplySyncProblems,
  testInbox,
} from './inboxes.ts'
import { syncReplies } from './replies.ts'
import { canRetry, sendDue } from './send.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'

beforeEach(() => {
  resetGoogleAccount()
  resetLoginProblems()
  resetReplySyncProblems()
})

const ADDRESS = '123 Main St, Philadelphia, PA 19146'
const TUESDAY_10AM = new Date('2026-10-13T14:00:00.000Z')
const ENV = { REPLIT_CONNECTORS_HOSTNAME: 'connectors.test', REPL_IDENTITY: 'id-token' }

function gmailInbox(patch: Partial<SendingInbox> = {}): SendingInbox {
  return {
    id: 'theo',
    from_name: 'Theo Young',
    email: 'theo@proparchive.biz',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_user: 'theo@proparchive.biz',
    smtp_pass: '',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    daily_limit: 30,
    active: true,
    ...patch,
  }
}

// ---------- the Gmail client against a fake Replit + Google ----------

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

function fakeFetch(answer: (call: Call, n: number) => { status: number; body?: unknown } | Error): {
  fetch: typeof globalThis.fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(call)
    const a = answer(call, calls.length)
    if (a instanceof Error) throw a
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const connection = (token = 'tok-1', expires_at?: string) => ({
  status: 200,
  body: { items: [{ settings: { access_token: token, ...(expires_at ? { expires_at } : {}) } }] },
})

describe('createGmailApi', () => {
  it('asks Replit for the google-mail token with the identity header, then calls Gmail with it', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.includes('connectors.test')
        ? connection()
        : { status: 200, body: { emailAddress: 'Theo@PropArchive.biz' } },
    )
    const api = createGmailApi({ fetch, env: ENV })
    expect(await api.account()).toEqual({ ok: true, email: 'theo@proparchive.biz' })
    expect(calls[0]!.url).toContain('connector_names=google-mail')
    expect(calls[0]!.headers.X_REPLIT_TOKEN).toBe('repl id-token')
    expect(calls[1]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile')
    expect(calls[1]!.headers.Authorization).toBe('Bearer tok-1')
  })

  it('in a published deployment uses the renewal token', async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.includes('connectors.test')
        ? connection()
        : { status: 200, body: { emailAddress: 'a@b.com' } },
    )
    const api = createGmailApi({
      fetch,
      env: { REPLIT_CONNECTORS_HOSTNAME: 'connectors.test', WEB_REPL_RENEWAL: 'renew' },
    })
    await api.account()
    expect(calls[0]!.headers.X_REPLIT_TOKEN).toBe('depl renew')
  })

  it('says not connected when Replit has no Gmail connection, and never calls Google', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { items: [] } }))
    const acct = await createGmailApi({ fetch, env: ENV }).account()
    expect(acct).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(calls).toHaveLength(1)
  })

  it('off Replit asks nothing at all', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 500 }))
    const acct = await createGmailApi({ fetch, env: {} }).account()
    expect(acct).toMatchObject({ ok: false, reason: 'not_on_replit' })
    expect(calls).toHaveLength(0)
  })

  it('sends the raw message base64url-encoded and reads back the Message-ID it went out with', async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.includes('connectors.test')) return connection()
      if (c.url.endsWith('/messages/send'))
        return { status: 200, body: { id: 'g1', threadId: 't1' } }
      return {
        status: 200,
        body: { payload: { headers: [{ name: 'Message-Id', value: '<real@mail.gmail.com>' }] } },
      }
    })
    const raw = Buffer.from('Subject: Hi\r\n\r\n???>>> body')
    const sent = await createGmailApi({ fetch, env: ENV }).send(raw)
    expect(sent).toEqual({ id: 'g1', threadId: 't1', messageId: '<real@mail.gmail.com>' })
    const post = calls.find((c) => c.method === 'POST')!
    expect(JSON.parse(post.body!)).toEqual({ raw: base64Url(raw) })
    expect(base64Url(raw)).not.toMatch(/[+/=]/)
  })

  it('gets a fresh token once after a 401, then works', async () => {
    let tokens = 0
    const { fetch } = fakeFetch((c) => {
      if (c.url.includes('connectors.test')) return connection(`tok-${++tokens}`)
      return c.headers.Authorization === 'Bearer tok-1'
        ? { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }
        : { status: 200, body: { emailAddress: 'theo@proparchive.biz' } }
    })
    expect(await createGmailApi({ fetch, env: ENV }).account()).toMatchObject({ ok: true })
    expect(tokens).toBe(2)
  })

  it('a missing permission is a refused sign-in (EAUTH), a rate limit is not', async () => {
    const scope = fakeFetch((c) =>
      c.url.includes('connectors.test')
        ? connection()
        : {
            status: 403,
            body: {
              error: {
                message: 'Request had insufficient authentication scopes.',
                errors: [{ reason: 'insufficientPermissions' }],
              },
            },
          },
    )
    const err = await createGmailApi({ fetch: scope.fetch, env: ENV })
      .send(Buffer.from('x'))
      .catch((e: unknown) => e)
    expect(isGmailAuthError(err)).toBe(true)
    expect(isLoginRefused(err)).toBe(true)

    const limit = fakeFetch((c) =>
      c.url.includes('connectors.test')
        ? connection()
        : { status: 429, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
    )
    const err2 = await createGmailApi({ fetch: limit.fetch, env: ENV })
      .send(Buffer.from('x'))
      .catch((e: unknown) => e)
    expect(err2).toBeInstanceOf(GmailError)
    expect(isGmailAuthError(err2)).toBe(false)
  })

  it('a send cut off mid-way is "outcome unknown" (never resent); Replit unreachable is safe to retry', async () => {
    const cut = fakeFetch((c) =>
      c.url.includes('connectors.test') ? connection() : new Error('socket hang up'),
    )
    const err = (await createGmailApi({ fetch: cut.fetch, env: ENV })
      .send(Buffer.from('x'))
      .catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/outcome unknown/)
    expect(canRetry({ status: 'failed', attempts: 1, error: err.message })).toBe(false)

    const down = fakeFetch(() =>
      Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }),
    )
    const err2 = (await createGmailApi({ fetch: down.fetch, env: ENV })
      .send(Buffer.from('x'))
      .catch((e: unknown) => e)) as Error
    expect(err2.message).toMatch(/nothing was sent/)
    expect(canRetry({ status: 'failed', attempts: 1, error: err2.message })).toBe(true)
  })

  it('a stored "Google refused the sign-in" error is retried like a refused password', () => {
    const error = `Google refused the sign-in (401 UNAUTHENTICATED). Reconnect Gmail: ${CONNECT_STEPS}.`
    expect(canRetry({ status: 'failed', attempts: 2, error })).toBe(true)
  })
})

describe('gmailInboxReader', () => {
  it('lists the inbox since a date and hands back raw messages oldest first, each with its Gmail id', async () => {
    const asked: Date[] = []
    const api: GmailApi = {
      account: async () => ({ ok: true, email: 'x@y.com' }),
      send: async () => ({ id: '', threadId: null, messageId: null }),
      listInbox: async (after) => {
        asked.push(after)
        return ['new', 'old'] // Gmail: newest first
      },
      getRaw: async (id) => Buffer.from(`raw-${id}`),
    }
    const reader = gmailInboxReader(api)
    const since = new Date('2026-10-01T00:00:00Z')
    const uids = await reader.search({ since }, { uid: true })
    expect(uids).toEqual([1, 2])
    const got = await reader.fetchAll(uids as number[], { source: true }, { uid: true })
    expect(got.map((m) => [m.gmailId, m.source!.toString()])).toEqual([
      ['old', 'raw-old'],
      ['new', 'raw-new'],
    ])
    expect(asked[0]!.toISOString()).toBe(since.toISOString())
  })
})

// ---------- the outreach app with a fake Gmail ----------

function fakeGmail(account: GoogleAccount, inbox: Buffer[] = []) {
  const sent: string[] = []
  const api: GmailApi = {
    account: async () => account,
    async send(raw) {
      if (!account.ok)
        throw new GmailError('Gmail is not connected to this app', 0, 'not_connected', true)
      sent.push(raw.toString())
      return {
        id: `g${sent.length}`,
        threadId: null,
        messageId: `<g${sent.length}@mail.gmail.com>`,
      }
    },
    listInbox: async () => inbox.map((_, i) => `m${i}`).reverse(),
    getRaw: async (id) => inbox[Number(id.slice(1))]!,
  }
  return { api, sent }
}

const ONE_EMAIL = [
  {
    delay_days: 0,
    channel: 'email' as const,
    subject: 'Hi {{first_name}}',
    body: 'Hello {{demo_link}}',
  },
]

describe('Sign in with Google', () => {
  it('an inbox counts as signed in only when the connected account is that very address', async () => {
    const theo = gmailInbox()
    expect(canSend(theo)).toBe(false) // no password, not connected
    await refreshGoogleAccount({ gmail: fakeGmail({ ok: true, email: 'someone@else.com' }).api })
    expect(googleSignedIn(theo)).toBe(false)
    await refreshGoogleAccount({
      gmail: fakeGmail({ ok: true, email: 'theo@proparchive.biz' }).api,
    })
    expect(googleSignedIn(theo)).toBe(true)
    expect(canSend(theo) && canRead(theo)).toBe(true)
    expect(googleSignedIn(gmailInbox({ smtp_host: 'smtp.office365.com' }))).toBe(false)
    // A failed lookup keeps the last answer instead of stopping everything for a minute.
    await refreshGoogleAccount({
      gmail: fakeGmail({ ok: false, reason: 'lookup_failed', detail: 'down' }).api,
    })
    expect(googleSignedIn(theo)).toBe(true)
  })

  it('sends the sequence email through Gmail with no app password, and keeps the real Message-ID', async () => {
    const gmail = fakeGmail({ ok: true, email: 'theo@proparchive.biz' })
    const fx = await setup({ now: () => TUESDAY_10AM, gmail: gmail.api })
    const { db, deps, outbox } = fx
    await setSettings(db, {
      live_mode: true,
      physical_address: ADDRESS,
      sending_inboxes: [gmailInbox()],
    })
    const lead = await insertLead(db, { email: 'ray@example.com', first_name: 'Ray' })
    const { sequence } = await insertSequence(db, { name: 'One' }, ONE_EMAIL)
    await enrollLead(deps, lead.id, sequence.id)

    expect(await sendDue(deps)).toMatchObject({ sent: 1 })
    expect(outbox).toHaveLength(0) // not the SMTP secrets
    expect(gmail.sent).toHaveLength(1)
    expect(gmail.sent[0]).toMatch(/^From: Theo Young <theo@proparchive\.biz>/m)
    expect(gmail.sent[0]).toMatch(/^To: ray@example\.com/m)
    expect(gmail.sent[0]).toMatch(/^Subject: Hi Ray/m)
    expect(gmail.sent[0]).toMatch(/^List-Unsubscribe:/m)
    const [row] = await db.select().from(messages)
    expect(row).toMatchObject({
      status: 'sent',
      provider: 'smtp:theo@proparchive.biz',
      provider_message_id: '<g1@mail.gmail.com>',
    })
  })

  it('a password Gmail refused earlier no longer blocks the inbox once Google sign-in is connected', async () => {
    const at = { now: TUESDAY_10AM }
    const gmail = fakeGmail({ ok: true, email: 'theo@proparchive.biz' })
    const fx = await setup({ now: () => at.now, gmail: gmail.api })
    const { db, deps } = fx
    const inbox = gmailInbox({ smtp_pass: 'wrongpassword15' })
    noteLoginRefused(inbox, at.now, '535-5.7.8 Username and Password not accepted') // before sign-in
    await setSettings(db, { live_mode: true, physical_address: ADDRESS, sending_inboxes: [inbox] })
    const lead = await insertLead(db, { email: 'ray@example.com' })
    const { sequence } = await insertSequence(db, { name: 'One' }, ONE_EMAIL)
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toMatchObject({ sent: 1 })
    expect(gmail.sent).toHaveLength(1)
  })

  it('a revoked Google sign-in holds the email without using an attempt and says how to reconnect', async () => {
    const fx = await setup({
      now: () => TUESDAY_10AM,
      gmail: {
        account: async () => ({ ok: true, email: 'theo@proparchive.biz' }),
        send: async () => {
          throw new GmailError(
            'Google refused the sign-in (401 UNAUTHENTICATED). Reconnect Gmail.',
            401,
            'x',
            true,
          )
        },
        listInbox: async () => [],
        getRaw: async () => Buffer.from(''),
      },
    })
    const { db, deps } = fx
    await setSettings(db, {
      live_mode: true,
      physical_address: ADDRESS,
      sending_inboxes: [gmailInbox()],
    })
    const lead = await insertLead(db, { email: 'ray@example.com' })
    const { sequence } = await insertSequence(db, { name: 'One' }, ONE_EMAIL)
    await enrollLead(deps, lead.id, sequence.id)
    expect(await sendDue(deps)).toMatchObject({ sent: 0 })
    const [row] = await db.select().from(messages)
    expect(row).toMatchObject({ status: 'failed', attempts: 0 })
    expect(canRetry(row!)).toBe(true)
    const refused = (await listActivity(50, deps.db)).find((a) => a.event === 'inbox_login_refused')
    expect((refused!.detail as { fix: string }).fix).toMatch(/Integrations > Gmail > Connect/)
  })

  it('reads replies through Gmail and stops the lead', async () => {
    const gmail = fakeGmail({ ok: true, email: 'theo@proparchive.biz' })
    const fx = await setup({ now: () => TUESDAY_10AM, gmail: gmail.api })
    const { db, deps } = fx
    await setSettings(db, {
      live_mode: true,
      physical_address: ADDRESS,
      sending_inboxes: [gmailInbox()],
    })
    const lead = await insertLead(db, { email: 'ray@example.com' })
    const { sequence } = await insertSequence(db, { name: 'One' }, ONE_EMAIL)
    await enrollLead(deps, lead.id, sequence.id)
    await sendDue(deps)

    const reply = [
      'From: "Ray Example" <ray@example.com>',
      'To: theo@proparchive.biz',
      'Subject: Re: Hi',
      'In-Reply-To: <g1@mail.gmail.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Sure, happy to book a demo.',
    ].join('\r\n')
    const reader = fakeGmail({ ok: true, email: 'theo@proparchive.biz' }, [Buffer.from(reply)])
    const deps2 = { ...deps, gmail: reader.api }
    expect(await syncReplies(deps2)).toEqual({ received: 1 })
    expect(await syncReplies(deps2)).toEqual({ received: 0 }) // once only, even without a Message-ID
    const inbound = (await db.select().from(messages)).filter((m) => m.direction === 'in')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({ lead_id: lead.id, idempotency_key: 'in:gmail:m0' })
  })

  it('Test on a Gmail inbox that is not signed in says where to connect Google', async () => {
    const { deps } = await setup({
      gmail: fakeGmail({ ok: false, reason: 'not_connected', detail: 'Gmail is not connected' })
        .api,
    })
    const r = await testInbox(deps, gmailInbox())
    expect(r.google).toBe(true)
    expect(r.smtp.ok).toBe(false)
    expect(r.smtp.message).toMatch(/All tools > Integrations > Gmail > Connect/)
    expect(r.smtp.message).toMatch(/theo@proparchive\.biz/)
  })

  it('Test on a Gmail inbox with a saved normal password points at Google, not app passwords', async () => {
    const { deps } = await setup({
      gmail: fakeGmail({ ok: false, reason: 'not_connected', detail: 'Gmail is not connected' })
        .api,
    })
    // 15 characters, like the password saved in production: never an app password.
    const r = await testInbox(deps, gmailInbox({ smtp_pass: 'NotAnAppPass15!' }))
    expect(r.google).toBe(true)
    expect(r.smtp.message).toMatch(/added to this app/)
    expect(r.imap.message).not.toMatch(/Use an app password/)
  })

  it('Test on a signed-in Gmail inbox sends one real email to itself and checks reading', async () => {
    const gmail = fakeGmail({ ok: true, email: 'theo@proparchive.biz' })
    const { deps } = await setup({ gmail: gmail.api })
    const r = await testInbox(deps, gmailInbox())
    expect(r).toMatchObject({ smtp: { ok: true }, imap: { ok: true }, google: true })
    expect(gmail.sent).toHaveLength(1)
    expect(gmail.sent[0]).toMatch(/^To: theo@proparchive\.biz/m)
  })
})
