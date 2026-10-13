// Everything the outreach module talks to from the outside, in one injectable bag.
// Production uses defaultDeps(); tests build a bag with fakes (no network, no real clock).
import Anthropic from '@anthropic-ai/sdk'
import type { SendingInbox } from '../../shared/settings.ts'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { lookup } from 'node:dns/promises'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { z } from 'zod'
import { getDb, type Db } from '../db/client.ts'
import { env, type Env } from '../env.ts'
import { createGmailApi, noGmail, type GmailApi } from './gmail.ts'

/** Spec section 2: the one model every Claude call uses. */
export const CLAUDE_MODEL = 'claude-opus-5-5'

/** A thin view of Claude: one plain sentence, or JSON matching a zod schema. null means "could not". */
export interface Llm {
  text(prompt: string, opts: { system?: string; maxTokens: number }): Promise<string | null>
  structured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    opts: { system?: string; maxTokens: number },
  ): Promise<T | null>
}

export interface OutgoingMail {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
  /** Our own Message-ID, so a resend of the same step is at least a visible duplicate. */
  messageId?: string
}

/** What we need from a nodemailer transport. */
export interface Mailer {
  sendMail(mail: OutgoingMail): Promise<{ messageId?: string }>
}

export interface ImapAddress {
  name?: string | undefined
  address?: string | undefined
}

export interface ImapEnvelope {
  date?: Date | string | undefined
  subject?: string | undefined
  messageId?: string | undefined
  inReplyTo?: string | undefined
  from?: ImapAddress[] | undefined
}

export interface ImapMessage {
  uid: number
  envelope?: ImapEnvelope | undefined
  source?: Buffer | undefined
  /** Set when the message was read through Gmail's API: its stable Gmail id. */
  gmailId?: string | undefined
}

/** What we need from an imapflow client. */
export interface ImapClient {
  connect(): Promise<void>
  mailboxOpen(path: string): Promise<unknown>
  search(
    query: { since?: Date | string | undefined },
    options?: { uid?: boolean | undefined },
  ): Promise<number[] | false | undefined | { all?: number[] | undefined }>
  fetchAll(
    range: string | number[],
    query: { uid?: boolean; envelope?: boolean; source?: boolean },
    options?: { uid?: boolean | undefined },
  ): Promise<ImapMessage[]>
  logout(): Promise<void>
}

export interface OutreachDeps {
  db: Db
  env: Env
  now: () => Date
  random: () => number
  fetch: typeof globalThis.fetch
  /** Public origin for links in messages, e.g. https://outreach.example.com (no trailing slash). */
  baseUrl: string
  /** null when SMTP_* is not set. */
  smtp: (() => Mailer) | null
  /** null when ANTHROPIC_API_KEY is not set. */
  llm: Llm | null
  /** null when IMAP_* is not set. */
  imap: (() => ImapClient) | null
  /**
   * A transport for one warmed inbox, connecting to `address` (the checked IP of smtp_host, see
   * resolveMailHost) while TLS still verifies the certificate against the server name.
   */
  smtpForInbox: (
    inbox: SendingInbox,
    address: string,
  ) => Mailer & { verify?: () => Promise<unknown> }
  /** An IMAP client for one warmed inbox at `address`, logging in with its SMTP user and password. */
  imapForInbox: (inbox: SendingInbox, address: string) => ImapClient
  /** Every address a host name resolves to, so inbox servers can be checked before we connect. */
  lookupHost: (host: string) => Promise<string[]>
  /** Gmail through Sign in with Google (Replit's Gmail connector). */
  gmail: GmailApi
}

/** Where links in emails point. PUBLIC_URL wins, then Replit's domain, then localhost. */
export function publicBaseUrl(e: NodeJS.ProcessEnv = process.env, port: number = env.PORT): string {
  const explicit = (e.PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  const replit = (e.REPLIT_DOMAINS ?? '').split(',')[0]?.trim()
  if (replit) return `https://${replit}`
  return `http://localhost:${port}`
}

export function anthropicLlm(apiKey: string, workspaceId?: string): Llm {
  // An organization-level key is refused without the anthropic-workspace-id header.
  const client = new Anthropic({
    apiKey,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  })
  return {
    async text(prompt, opts) {
      const res = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: opts.maxTokens,
        output_config: { effort: 'low' },
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: prompt }],
      })
      const block = res.content.find((b) => b.type === 'text')
      return block && block.type === 'text' ? block.text.trim() : null
    },
    async structured<T>(
      prompt: string,
      schema: z.ZodType<T>,
      opts: { system?: string; maxTokens: number },
    ): Promise<T | null> {
      const res = await client.messages.parse({
        model: CLAUDE_MODEL,
        max_tokens: opts.maxTokens,
        output_config: { effort: 'low', format: zodOutputFormat(schema) },
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: prompt }],
      })
      return (res.parsed_output as unknown as T | null | undefined) ?? null
    },
  }
}

export function smtpMailer(e: Env): Mailer {
  const port = e.SMTP_PORT ?? 587
  return nodemailer.createTransport({
    host: e.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
  })
}

export function inboxMailer(
  inbox: SendingInbox,
  address: string,
): Mailer & { verify: () => Promise<unknown> } {
  return nodemailer.createTransport({
    host: address,
    port: inbox.smtp_port,
    secure: inbox.smtp_port === 465,
    tls: { servername: inbox.smtp_host },
    auth: { user: inbox.smtp_user, pass: inbox.smtp_pass },
  })
}

export function inboxImap(inbox: SendingInbox, address: string): ImapClient {
  return new ImapFlow({
    host: address,
    servername: inbox.imap_host,
    port: inbox.imap_port,
    secure: inbox.imap_port === 993,
    tls: { servername: inbox.imap_host },
    auth: { user: inbox.smtp_user, pass: inbox.smtp_pass },
    logger: false,
  })
}

export function imapClient(e: Env): ImapClient {
  const port = e.IMAP_PORT ?? 993
  return new ImapFlow({
    host: e.IMAP_HOST,
    port,
    secure: port === 993,
    auth: { user: e.IMAP_USER ?? '', pass: e.IMAP_PASS ?? '' },
    logger: false,
  })
}

/** The production bag. `db` defaults to the app database. */
export function defaultDeps(db: Db = getDb(), e: Env = env): OutreachDeps {
  const hasSmtp = Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS)
  const hasImap = Boolean(e.IMAP_HOST && e.IMAP_USER && e.IMAP_PASS)
  return {
    db,
    env: e,
    now: () => new Date(),
    random: Math.random,
    fetch: (input, init) => globalThis.fetch(input, init),
    baseUrl: publicBaseUrl(process.env, e.PORT),
    smtp: hasSmtp ? () => smtpMailer(e) : null,
    llm: e.ANTHROPIC_API_KEY ? anthropicLlm(e.ANTHROPIC_API_KEY, e.ANTHROPIC_WORKSPACE_ID) : null,
    imap: hasImap ? () => imapClient(e) : null,
    smtpForInbox: inboxMailer,
    imapForInbox: inboxImap,
    lookupHost: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    gmail: productionGmail(),
  }
}

// One Gmail client for the process, so its token and account answer are shared by every caller.
let gmailClient: GmailApi | null = null
function productionGmail(): GmailApi {
  gmailClient ??= createGmailApi({
    fetch: (input, init) => globalThis.fetch(input, init),
    env: process.env,
  })
  return gmailClient
}

/** Build a deps bag for tests: in-memory db, fixed clock, no providers unless given. */
export function testDeps(db: Db, overrides: Partial<OutreachDeps> = {}): OutreachDeps {
  const base: OutreachDeps = {
    db,
    env,
    now: () => new Date('2026-10-13T14:00:00.000Z'), // a Tuesday, 10:00 in New York
    random: () => 0,
    fetch: async () => {
      throw new Error('fetch is not available in this test')
    },
    baseUrl: 'https://outreach.test',
    smtp: null,
    llm: null,
    imap: null,
    smtpForInbox: () => {
      throw new Error('inbox SMTP is not available in this test')
    },
    imapForInbox: () => {
      throw new Error('inbox IMAP is not available in this test')
    },
    // A public address, so inbox servers in tests pass the private-network check without DNS.
    lookupHost: async () => ['142.250.1.108'],
    gmail: noGmail,
  }
  return { ...base, ...overrides }
}
