// Suppression list helpers: add, and check whether a lead is blocked (spec section 1).
import { and, eq, inArray } from 'drizzle-orm'
import type { SuppressionKind } from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { suppression, type Lead } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { normaliseEmail, normalisePhone, normaliseStreet, normaliseZip5 } from '../lib/text.ts'
import { nowIso } from '../lib/time.ts'

export function addressKey(
  street: string | null | undefined,
  zip: string | null | undefined,
): string {
  const s = normaliseStreet(street)
  const z = normaliseZip5(zip)
  return s ? `${s}|${z}` : ''
}

/** Insert one suppression row. Duplicates are ignored. Returns true when a row was added. */
export async function addSuppression(
  db: Db,
  kind: SuppressionKind,
  rawValue: string | null | undefined,
  reason: string,
): Promise<boolean> {
  const value = normaliseValue(kind, rawValue)
  if (!value) return false
  const existing = await db
    .select({ id: suppression.id })
    .from(suppression)
    .where(and(eq(suppression.kind, kind), eq(suppression.value, value)))
    .limit(1)
  if (existing.length > 0) return false
  await db.insert(suppression).values({ id: newId(), kind, value, reason, at: nowIso() })
  return true
}

export function normaliseValue(kind: SuppressionKind, raw: string | null | undefined): string {
  if (!raw) return ''
  switch (kind) {
    case 'email':
      return normaliseEmail(raw)
    case 'domain':
      return raw.trim().toLowerCase().replace(/^@/, '')
    case 'phone':
      return normalisePhone(raw)
    case 'address': {
      // Accept "street|zip" or a bare street; normalise the same way suppressionHits does.
      const [street, zip] = raw.split('|')
      return addressKey(street, zip)
    }
  }
}

/** The suppression kinds a lead's data matches, if any. Empty means not suppressed. */
export async function suppressionHits(
  db: Db,
  lead: Pick<Lead, 'email' | 'phone' | 'mailing_street' | 'mailing_zip'>,
): Promise<SuppressionKind[]> {
  const checks: Array<{ kind: SuppressionKind; value: string }> = []
  const email = normaliseEmail(lead.email)
  if (email) {
    checks.push({ kind: 'email', value: email })
    const domain = email.split('@')[1] ?? ''
    if (domain) checks.push({ kind: 'domain', value: domain })
  }
  const phone = normalisePhone(lead.phone)
  if (phone) checks.push({ kind: 'phone', value: phone })
  const addr = addressKey(lead.mailing_street, lead.mailing_zip)
  if (addr) checks.push({ kind: 'address', value: addr })
  if (checks.length === 0) return []

  const rows = await db
    .select({ kind: suppression.kind, value: suppression.value })
    .from(suppression)
    .where(
      inArray(
        suppression.value,
        checks.map((c) => c.value),
      ),
    )
  const hits = new Set<SuppressionKind>()
  for (const r of rows) {
    if (checks.some((c) => c.kind === r.kind && c.value === r.value)) hits.add(r.kind)
  }
  return [...hits]
}

export async function isSuppressed(
  db: Db,
  lead: Pick<Lead, 'email' | 'phone' | 'mailing_street' | 'mailing_zip'>,
): Promise<boolean> {
  return (await suppressionHits(db, lead)).length > 0
}
