// Gmail through "Sign in with Google": Replit's Gmail connector (google-mail) holds the OAuth
// connection to Theo's Google account, and this module asks it for a current access token, the way
// the main app's googleCalendar.ts does for Google Calendar. With it the app sends and reads mail
// through Gmail's REST API, so no app password is needed.
//
// The connector grants gmail.send, gmail.compose, gmail.readonly and gmail.labels, not the full
// https://mail.google.com/ scope SMTP and IMAP would need, so mail goes through the REST API:
// users.messages.send with the raw message, users.messages.list and get for replies.
//
// Never logs or returns a token. Errors carry the HTTP status and Google's reason only.

import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { ImapClient, ImapMessage, OutgoingMail } from './deps.ts'

/** The connector's name in Replit's connection API. */
export const GMAIL_CONNECTOR = 'google-mail'
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Where Theo connects it. Shown in every fix. Gmail signed in on his Replit account is not enough:
 * the connection has to be added to this app too (Replit calls that state not_added).
 */
export const CONNECT_STEPS =
  'In Replit, open this app, then All tools > Integrations > Gmail > Connect (if Gmail already shows on your Replit account it still has to be added to this app; or ask the Replit Agent in this app "Add the Gmail integration to this app")'

export type GoogleAccount =
  | { ok: true; email: string }
  | {
      ok: false
      reason: 'not_on_replit' | 'not_connected' | 'lookup_failed' | 'refused'
      detail: string
    }

export interface GmailSent {
  /** Gmail's id for the sent message. */
  id: string
  threadId: string | null
  /** The Message-ID header the message went out with, read back from Gmail when it can be. */
  messageId: string | null
}

/** What the outreach module needs from Gmail. Tests pass a fake. */
export interface GmailApi {
  /** The Google account the connector is signed in as, or why there is none. Cached briefly. */
  account(opts?: { fresh?: boolean }): Promise<GoogleAccount>
  /** Send one raw RFC 5322 message as the signed-in account. */
  send(raw: Buffer): Promise<GmailSent>
  /** Ids of INBOX messages received after `after`, newest first, at most `max`. */
  listInbox(after: Date, max: number): Promise<string[]>
  /** The full raw message. */
  getRaw(id: string): Promise<Buffer>
}

/** A Gmail answer. `code: 'EAUTH'` marks a refused sign-in, which send.ts treats like a refused password. */
export class GmailError extends Error {
  readonly status: number
  readonly reason: string
  readonly code: string | undefined
  constructor(message: string, status: number, reason: string, auth = false) {
    super(message)
    this.name = 'GmailError'
    this.status = status
    this.reason = reason
    this.code = auth ? 'EAUTH' : undefined
  }
}

/** True for an error that means Google refused the sign-in (not connected, revoked, no scope). */
export function isGmailAuthError(err: unknown): boolean {
  return err instanceof GmailError && err.code === 'EAUTH'
}

const DEADLINE_MS = 15_000
const TOKEN_EARLY_MS = 60_000
const TOKEN_DEFAULT_MS = 5 * 60_000
const ACCOUNT_MS = 60_000
const ACCOUNT_RETRY_MS = 15_000

export interface GmailOptions {
  fetch: typeof globalThis.fetch
  env: NodeJS.ProcessEnv
  now?: () => number
  timeoutMs?: number
}

type Rec = Record<string, unknown>
const asRec = (v: unknown): Rec | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** settings.expires_at as epoch ms: an ISO date, or epoch seconds or milliseconds. */
export function expiryOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+$/.test(v.trim())) return expiryOf(Number(v.trim()))
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** Base64url, as Gmail's raw field wants it. */
export function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Google's error reason from a JSON error body, e.g. insufficientPermissions or dailyLimitExceeded. */
function reasonOf(body: unknown): { reason: string; message: string } {
  const err = asRec(asRec(body)?.error)
  const first = asRec(Array.isArray(err?.errors) ? err.errors[0] : null)
  const details = Array.isArray(err?.details) ? err.details.map(asRec) : []
  const detailReason = details.map((d) => str(d?.reason)).find(Boolean)
  return {
    reason: str(first?.reason) ?? detailReason ?? str(err?.status) ?? 'unknown',
    message: (str(err?.message) ?? '').slice(0, 200),
  }
}

const SCOPE_RE = /insufficient|scope|permission_denied|forbidden|access_token_scope/i
const LIMIT_RE = /limit|quota|rate/i

export function createGmailApi(opts: GmailOptions): GmailApi {
  const now = opts.now ?? (() => Date.now())
  const timeoutMs = opts.timeoutMs ?? DEADLINE_MS
  let token: { value: string; until: number } | null = null
  let cached: { at: number; result: GoogleAccount } | null = null

  function identity(): { host: string; header: string } | null {
    const host = str(opts.env.REPLIT_CONNECTORS_HOSTNAME)
    const header = opts.env.REPL_IDENTITY
      ? `repl ${opts.env.REPL_IDENTITY}`
      : opts.env.WEB_REPL_RENEWAL
        ? `depl ${opts.env.WEB_REPL_RENEWAL}`
        : null
    return host && header ? { host, header } : null
  }

  /** A current access token from Replit's connector service, or why there is none. */
  async function getToken(
    force = false,
  ): Promise<{ ok: true; token: string } | Extract<GoogleAccount, { ok: false }>> {
    if (!force && token && now() < token.until) return { ok: true, token: token.value }
    const who = identity()
    if (!who) {
      return {
        ok: false,
        reason: 'not_on_replit',
        detail: 'Google sign-in only works on Replit (no connector service here)',
      }
    }
    const url = new URL(`https://${who.host}/api/v2/connection`)
    url.searchParams.set('include_secrets', 'true')
    url.searchParams.set('connector_names', GMAIL_CONNECTOR)
    let res: Response
    try {
      res = await opts.fetch(url, {
        headers: { Accept: 'application/json', X_REPLIT_TOKEN: who.header },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // Worded without "timeout": nothing was sent, so send.ts may try again later.
      return {
        ok: false,
        reason: 'lookup_failed',
        detail: "Replit's Gmail connection could not be reached, so nothing was sent",
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'lookup_failed',
        detail: `Replit's Gmail connection answered ${res.status}`,
      }
    }
    const body = asRec(await res.json().catch(() => null))
    const item = asRec(Array.isArray(body?.items) ? body.items[0] : null)
    const settings = asRec(item?.settings)
    const creds = asRec(asRec(settings?.oauth)?.credentials)
    const value = str(settings?.access_token) ?? str(creds?.access_token)
    if (!value) {
      token = null
      return { ok: false, reason: 'not_connected', detail: 'Gmail is not connected to this app' }
    }
    const expires = expiryOf(settings?.expires_at) ?? expiryOf(creds?.expires_at)
    token = {
      value,
      until: expires ? Math.max(now(), expires - TOKEN_EARLY_MS) : now() + TOKEN_DEFAULT_MS,
    }
    return { ok: true, token: value }
  }

  /** One Gmail call. A 401 gets a fresh token and one more try; refused sign-ins throw EAUTH. */
  async function gmail(path: string, init: RequestInit = {}): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await getToken(attempt > 0)
      if (!t.ok) {
        throw new GmailError(
          `${t.detail}. ${CONNECT_STEPS}.`,
          0,
          t.reason,
          t.reason !== 'lookup_failed',
        )
      }
      let res: Response
      try {
        res = await opts.fetch(`${GMAIL_API}${path}`, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${t.token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        // A send cut off mid-way may still have gone out: send.ts never retries "outcome unknown".
        if (init.method === 'POST')
          throw new Error(`Gmail send outcome unknown (${what})`, { cause: err })
        throw new Error(`Gmail did not answer (${what})`, { cause: err })
      }
      if (res.status === 401 && attempt === 0) {
        token = null
        continue
      }
      const body: unknown = await res.json().catch(() => null)
      if (res.ok) return body
      const { reason, message } = reasonOf(body)
      if (res.status === 401) {
        token = null
        throw new GmailError(
          `Google refused the sign-in (401 ${reason}). Reconnect Gmail: ${CONNECT_STEPS}.`,
          401,
          reason,
          true,
        )
      }
      if (res.status === 403 && !LIMIT_RE.test(reason) && SCOPE_RE.test(`${reason} ${message}`)) {
        throw new GmailError(
          `Google did not give this app permission (403 ${reason}). Reconnect Gmail and allow everything it asks: ${CONNECT_STEPS}.`,
          403,
          reason,
          true,
        )
      }
      throw new GmailError(
        `Gmail answered ${res.status} ${reason}${message ? `: ${message}` : ''}`,
        res.status,
        reason,
      )
    }
    throw new GmailError('Gmail refused the sign-in twice', 401, 'unauthorized', true)
  }

  return {
    async account({ fresh = false } = {}) {
      if (!fresh && cached) {
        const ttl =
          cached.result.ok || cached.result.reason !== 'lookup_failed'
            ? ACCOUNT_MS
            : ACCOUNT_RETRY_MS
        if (now() - cached.at < ttl) return cached.result
      }
      let result: GoogleAccount
      try {
        const profile = asRec(await gmail('/profile'))
        const email = str(profile?.emailAddress)
        result = email
          ? { ok: true, email: email.toLowerCase() }
          : {
              ok: false,
              reason: 'lookup_failed',
              detail: 'Gmail did not say which account this is',
            }
      } catch (err) {
        if (err instanceof GmailError && err.status === 0) {
          result = { ok: false, reason: err.reason as 'not_on_replit', detail: err.message }
        } else if (isGmailAuthError(err)) {
          result = { ok: false, reason: 'refused', detail: (err as Error).message }
        } else {
          result = {
            ok: false,
            reason: 'lookup_failed',
            detail: err instanceof Error ? err.message : String(err),
          }
        }
      }
      cached = { at: now(), result }
      return result
    },

    async send(raw) {
      const body = asRec(
        await gmail('/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: base64Url(raw) }),
        }),
      )
      const id = str(body?.id)
      if (!id)
        throw new GmailError('Gmail accepted the send but returned no message id', 200, 'no_id')
      // Read back the Message-ID it went out with: replies quote it, and that is how they match.
      let messageId: string | null = null
      try {
        const meta = asRec(
          await gmail(
            `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID`,
          ),
        )
        const headers = asRec(meta?.payload)?.headers
        if (Array.isArray(headers)) {
          for (const h of headers.map(asRec)) {
            if (str(h?.name)?.toLowerCase() === 'message-id') messageId = str(h?.value)
          }
        }
      } catch {
        // The email is out. Without the read-back, the Message-ID we set is the best we have.
      }
      return { id, threadId: str(body?.threadId), messageId }
    },

    async listInbox(after, max) {
      const ids: string[] = []
      let pageToken: string | null = null
      const q = `in:inbox after:${Math.floor(after.getTime() / 1000)}`
      do {
        const params = new URLSearchParams({
          q,
          maxResults: String(Math.min(100, max - ids.length)),
        })
        if (pageToken) params.set('pageToken', pageToken)
        const page = asRec(await gmail(`/messages?${params.toString()}`))
        const list = Array.isArray(page?.messages) ? page.messages : []
        for (const m of list) {
          const id = str(asRec(m)?.id)
          if (id) ids.push(id)
        }
        pageToken = str(page?.nextPageToken)
      } while (pageToken && ids.length < max)
      return ids.slice(0, max)
    },

    async getRaw(id) {
      const body = asRec(await gmail(`/messages/${encodeURIComponent(id)}?format=raw`))
      const raw = str(body?.raw)
      if (!raw)
        throw new GmailError('Gmail returned the message without its content', 200, 'no_raw')
      return fromBase64Url(raw)
    },
  }
}

/** Gmail is not reachable here (tests, local runs): every call says so. */
export const noGmail: GmailApi = {
  async account() {
    return { ok: false, reason: 'not_on_replit', detail: 'Google sign-in only works on Replit' }
  },
  async send() {
    throw new GmailError('Google sign-in only works on Replit', 0, 'not_on_replit', true)
  },
  async listInbox() {
    throw new GmailError('Google sign-in only works on Replit', 0, 'not_on_replit', true)
  },
  async getRaw() {
    throw new GmailError('Google sign-in only works on Replit', 0, 'not_on_replit', true)
  },
}

/** The full RFC 5322 message nodemailer would send over SMTP, for Gmail's raw field. */
export function compileMail(mail: OutgoingMail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, message) => {
      if (err) reject(err)
      else resolve(message)
    })
  })
}

/**
 * The inbox read through Gmail's API, in the shape reply sync already uses for IMAP. search()
 * answers positions 1..n (newest last, like IMAP UIDs), fetchAll() reads each one's raw message.
 * Each message carries its Gmail id, so a reply without a Message-ID is still recorded once.
 */
export function gmailInboxReader(api: GmailApi, max = 200): ImapClient {
  let ids: string[] = []
  return {
    async connect() {},
    async mailboxOpen() {
      return null
    },
    async search(query) {
      const since = query.since ? new Date(query.since) : new Date(0)
      // Gmail lists newest first; IMAP order is oldest first.
      ids = (await api.listInbox(since, max)).reverse()
      return ids.map((_, i) => i + 1)
    },
    async fetchAll(range) {
      const wanted = Array.isArray(range) ? range : ids.map((_, i) => i + 1)
      const out: ImapMessage[] = []
      for (const n of wanted) {
        const id = ids[n - 1]
        if (!id) continue
        out.push({ uid: n, source: await api.getRaw(id), gmailId: id })
      }
      return out
    },
    async logout() {},
  }
}
