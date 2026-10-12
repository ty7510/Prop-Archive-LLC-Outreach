// Fixtures for the enrich tests. No vitest imports here so the server build can include it harmlessly.
import type { Db } from '../db/client.ts'
import { leads, properties, type Lead, type NewProperty } from '../db/schema.ts'
import { parseEnv, type Env } from '../env.ts'
import { newId } from '../lib/ids.ts'
import type { EnrichContext, EnrichProvider, ProviderResult } from './types.ts'
import type { Settings } from '../../shared/settings.ts'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'

export function makeLead(partial: Partial<Lead> = {}): Lead {
  const now = '2026-10-11T12:00:00.000Z'
  return {
    id: newId(),
    created_at: now,
    updated_at: now,
    source: 'opa',
    status: 'new',
    persona: 'maya',
    icp_score: 70,
    owner_kind: 'unknown',
    full_name: null,
    first_name: null,
    last_name: null,
    company: null,
    email: null,
    email_status: 'unknown',
    phone: null,
    phone_type: 'unknown',
    linkedin_url: null,
    instagram_url: null,
    facebook_url: null,
    website: null,
    mailing_street: null,
    mailing_city: null,
    mailing_state: null,
    mailing_zip: null,
    mailing_verified: false,
    property_count: 4,
    unit_count: 0,
    zips: ['19104'],
    trigger: { type: 'none' },
    channels: { email: false, mail: false, linkedin: false, instagram: false, call: false },
    enrichment: {},
    tags: [],
    notes: null,
    do_not_contact: false,
    unsubscribe_token: newId(),
    last_contacted_at: null,
    last_replied_at: null,
    next_action_at: null,
    dedupe_key: null,
    ...partial,
  }
}

export async function insertLead(db: Db, partial: Partial<Lead> = {}): Promise<Lead> {
  const lead = makeLead(partial)
  await db.insert(leads).values(lead)
  return lead
}

export async function insertProperty(
  db: Db,
  leadId: string,
  partial: Partial<NewProperty> = {},
): Promise<string> {
  const id = newId()
  await db.insert(properties).values({ id, lead_id: leadId, source: 'opa', ...partial })
  return id
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ NODE_ENV: 'test', APP_PASSWORD: 'x', ...overrides })
}

export function makeContext(partial: Partial<EnrichContext> = {}): EnrichContext {
  return {
    env: testEnv(),
    settings: DEFAULT_SETTINGS as Settings,
    properties: [],
    now: new Date('2026-10-11T12:00:00.000Z'),
    log: async () => {},
    ...partial,
  }
}

/** A provider that answers with a fixed result (or throws), and remembers how often it ran. */
export function fakeProvider(
  id: EnrichProvider['id'],
  answer: Partial<ProviderResult> | Error | ((lead: Lead) => Partial<ProviderResult>),
  opts: { costPerCall?: number; configured?: boolean; applies?: boolean } = {},
): EnrichProvider & { calls: Lead[] } {
  const calls: Lead[] = []
  return {
    id,
    calls,
    costPerCall: opts.costPerCall ?? (id === 'li_license' ? 0 : 1),
    isConfigured: () => opts.configured ?? true,
    applies: () => opts.applies ?? true,
    async enrich(lead) {
      calls.push({ ...lead })
      if (answer instanceof Error) throw answer
      const partial = typeof answer === 'function' ? answer(lead) : answer
      return { raw: { from: id }, confidence: 0.5, ...partial }
    },
  }
}

/** A fetch stand-in that answers each call from a queue of { status, body } (last one repeats). */
export function queuedFetch(
  answers: { status: number; body?: unknown; text?: string }[],
): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let i = 0
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const a = answers[Math.min(i, answers.length - 1)]
    i++
    if (!a) throw new Error('no answer queued')
    const text = a.text ?? (a.body === undefined ? '' : JSON.stringify(a.body))
    return new Response(text, { status: a.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch & { calls: typeof calls }
  fn.calls = calls
  return fn
}

/** A fetch that never answers until the abort signal fires (simulates a hung provider). */
export function hangingFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      )
    })) as typeof fetch
}
