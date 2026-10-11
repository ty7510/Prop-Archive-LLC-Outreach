// Direct mail through Lob (spec section 10). The print path lives in send.ts (ready_for_human).
import type { Settings } from '../../shared/settings.ts'
import type { Lead } from '../db/schema.ts'
import type { OutreachDeps } from './deps.ts'

/** Bodies longer than this go as letters, shorter ones as postcards. */
export const POSTCARD_MAX_CHARS = 350

export interface PostalAddress {
  name: string
  company?: string
  street: string
  city: string
  state: string
  zip: string
}

export function postalAddressFor(lead: Lead): PostalAddress | null {
  if (!lead.mailing_street) return null
  return {
    name: lead.full_name?.trim() || lead.company?.trim() || 'Property Owner',
    ...(lead.company && lead.full_name ? { company: lead.company } : {}),
    street: lead.mailing_street,
    city: lead.mailing_city ?? 'Philadelphia',
    state: lead.mailing_state ?? 'PA',
    zip: lead.mailing_zip ?? '',
  }
}

export interface LobResult {
  kind: 'postcard' | 'letter'
  id: string | null
}

function lobAddress(a: PostalAddress): Record<string, string> {
  return {
    name: a.name,
    ...(a.company ? { company: a.company } : {}),
    address_line1: a.street,
    address_city: a.city,
    address_state: a.state,
    address_zip: a.zip,
    address_country: 'US',
  }
}

/** Parse "street, city, ST zip" from the one-line physical_address setting. Best effort. */
export function senderAddress(settings: Settings): PostalAddress {
  const parts = settings.physical_address.split(',').map((p) => p.trim())
  const stateZip = /^([A-Za-z]{2})\s+(\d{5})/.exec(parts[2] ?? '')
  return {
    name: settings.owner_name,
    company: 'Prop Archive LLC',
    street: parts[0] ?? settings.physical_address,
    city: parts[1] ?? 'Philadelphia',
    state: stateZip?.[1]?.toUpperCase() ?? 'PA',
    zip: stateZip?.[2] ?? '',
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** POST a postcard or letter to Lob. Throws on a non-2xx answer. */
export async function sendViaLob(
  deps: OutreachDeps,
  settings: Settings,
  to: PostalAddress,
  body: string,
  idempotencyKey: string,
): Promise<LobResult> {
  const key = deps.env.LOB_API_KEY
  if (!key) throw new Error('No mail provider: add LOB_API_KEY in .env')
  const kind: LobResult['kind'] = body.length > POSTCARD_MAX_CHARS ? 'letter' : 'postcard'
  const html = `<html><body style="font-family:Georgia,serif;font-size:14px;white-space:pre-wrap;padding:0.5in">${escapeHtml(body)}</body></html>`
  const payload: Record<string, unknown> =
    kind === 'postcard'
      ? {
          description: 'Prop Archive outreach postcard',
          to: lobAddress(to),
          from: lobAddress(senderAddress(settings)),
          front: html,
          back: html,
          size: '4x6',
          use_type: 'marketing',
        }
      : {
          description: 'Prop Archive outreach letter',
          to: lobAddress(to),
          from: lobAddress(senderAddress(settings)),
          file: html,
          color: false,
          use_type: 'marketing',
        }
  const res = await deps.fetch(`https://api.lob.com/v1/${kind}s`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Lob ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string }
  return { kind, id: json.id ?? null }
}
