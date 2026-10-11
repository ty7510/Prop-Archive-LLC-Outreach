// Merge a provider result onto a lead. Pure. Never overwrites a non-empty field with an empty one,
// never overwrites a valid email with an unverified one.
import type { EmailStatus } from '../../shared/types.ts'
import type { Lead } from '../db/schema.ts'
import { isLlc, normaliseEmail, normalisePhone, splitName, titleCase } from '../lib/text.ts'
import type { LeadContactFields, ProviderResult } from './types.ts'

const EMAIL_RANK: Record<EmailStatus, number> = { invalid: 0, unknown: 1, risky: 1, valid: 3 }

export function emailRank(status: EmailStatus | null | undefined): number {
  return EMAIL_RANK[status ?? 'unknown'] ?? 1
}

/**
 * Should `incoming` replace the lead's current email?
 * - empty current: yes
 * - current invalid: yes
 * - same address: only when the new status is better verified (an upgrade, never a downgrade)
 * - current valid: never replaced by a different address
 * - otherwise: only when incoming is strictly better verified
 */
export function shouldReplaceEmail(
  current: { email: string | null; email_status: EmailStatus },
  incoming: { email: string; email_status: EmailStatus },
): boolean {
  if (!current.email) return true
  if (current.email_status === 'invalid') return true
  if (current.email.toLowerCase() === incoming.email.toLowerCase()) {
    return emailRank(incoming.email_status) > emailRank(current.email_status)
  }
  if (current.email_status === 'valid') return false
  return emailRank(incoming.email_status) > emailRank(current.email_status)
}

type TextField = Exclude<
  keyof LeadContactFields,
  | 'email'
  | 'email_status'
  | 'phone'
  | 'phone_type'
  | 'mailing_verified'
  | 'unit_count'
  | 'owner_kind'
>

const TEXT_FIELDS: TextField[] = [
  'full_name',
  'first_name',
  'last_name',
  'company',
  'linkedin_url',
  'instagram_url',
  'website',
  'mailing_street',
  'mailing_city',
  'mailing_state',
  'mailing_zip',
]

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Returns the changed columns only (empty object when nothing new was learned). */
export function mergeProviderResult(
  lead: Lead,
  result: ProviderResult,
): Partial<LeadContactFields> {
  const patch: Partial<LeadContactFields> = {}

  for (const field of TEXT_FIELDS) {
    const incoming = str(result[field])
    if (!incoming) continue
    if (str(lead[field])) continue
    patch[field] = incoming
  }

  // Email: normalise, then apply the verified-beats-unverified rule.
  const incomingEmail = normaliseEmail(result.email ?? null)
  if (incomingEmail) {
    const incomingStatus: EmailStatus = result.email_status ?? 'unknown'
    const current = { email: lead.email, email_status: lead.email_status }
    if (shouldReplaceEmail(current, { email: incomingEmail, email_status: incomingStatus })) {
      patch.email = incomingEmail
      patch.email_status = incomingStatus
    }
  }

  // Phone: fill when empty; upgrade the type for the same number when we learn it.
  const incomingPhone = normalisePhone(result.phone ?? null)
  if (incomingPhone.length >= 10) {
    if (!lead.phone) {
      patch.phone = incomingPhone
      patch.phone_type = result.phone_type ?? 'unknown'
    } else if (
      normalisePhone(lead.phone) === incomingPhone &&
      lead.phone_type === 'unknown' &&
      result.phone_type &&
      result.phone_type !== 'unknown'
    ) {
      patch.phone_type = result.phone_type
    }
  }

  if (result.mailing_verified === true && !lead.mailing_verified) patch.mailing_verified = true

  if (
    typeof result.unit_count === 'number' &&
    Number.isFinite(result.unit_count) &&
    result.unit_count > (lead.unit_count ?? 0)
  ) {
    patch.unit_count = Math.round(result.unit_count)
  }

  // Names: derive the parts we are missing from the parts we have.
  const fullName = patch.full_name ?? lead.full_name ?? ''
  const firstName = patch.first_name ?? lead.first_name ?? ''
  const lastName = patch.last_name ?? lead.last_name ?? ''
  if (fullName && !firstName && !lastName && !isLlc(fullName)) {
    const parts = splitName(fullName)
    if (parts.first_name) patch.first_name = parts.first_name
    if (parts.last_name) patch.last_name = parts.last_name
  } else if (!fullName && (firstName || lastName)) {
    patch.full_name = titleCase(`${firstName} ${lastName}`.trim())
  }

  // A human behind an LLC turns owner_kind into 'person'. Never the other way round.
  if (
    result.owner_kind &&
    result.owner_kind !== 'unknown' &&
    lead.owner_kind !== result.owner_kind
  ) {
    if (
      lead.owner_kind === 'unknown' ||
      (lead.owner_kind === 'llc' && result.owner_kind === 'person')
    ) {
      patch.owner_kind = result.owner_kind
    }
  }

  return patch
}
