// Did they sell? (Theo, 2026-10-16: "account for if they recently sold off their properties and
// dont show those people".) Before someone goes on the to-do list, and again every two weeks while
// they wait on it, the app asks the city's property records (OPA, where the leads came from) who
// owns each of their parcels now.
//
// A parcel counts as sold only on clear evidence: OPA shows a sale dated after what we knew (our
// stored sale date, or the day the lead was added when we have none), and the owner changed. A
// transfer under NOMINAL_SALE_PRICE to an owner at the same mailing address (moving houses into
// their own LLC) is not a sale, and with no stored owner to compare a nominal or unpriced transfer
// is too weak to count. When what they still own falls below settings.min_props (the smallest
// owner Theo targets), they are marked disqualified and stay off the list. Someone who already
// answered (replied, booked, joined) is never touched.
import { eq, sql } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import type { LeadStatus } from '../../shared/types.ts'
import type { Db } from '../db/client.ts'
import { events, leads, properties, type Lead, type Property } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { createCartoClient, int, type CartoClient } from '../sources/carto.ts'
import { isoDate, NOMINAL_SALE_PRICE, OPA_TABLE } from '../sources/opa.ts'

export const OWNERSHIP_KEY = 'ownership_check'
export const OWNERSHIP_RECHECK_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_PER_QUERY = 200

/** Only these statuses may become disqualified: nobody who answered or opted out. */
const MAY_DISQUALIFY: readonly LeadStatus[] = [
  'new',
  'enriching',
  'enriched',
  'enrolled',
  'contacted',
]

export interface SoldParcel {
  parcel: string
  address: string | null
  sale_date: string | null
  sale_price: number | null
  new_owner: string | null
}

export interface OwnershipResult {
  status: 'owns' | 'sold_off' | 'unknown'
  /** Parcels OPA answered for. */
  checked: number
  owned_now: number
  sold: SoldParcel[]
  /** The lead as saved after the check. */
  lead: Lead
}

export interface OwnershipRecord {
  checked_at: string
  status: OwnershipResult['status']
  checked: number
  owned_now: number
  sold: SoldParcel[]
}

/** The OPA columns the check reads. */
export interface OpaOwnerRow {
  parcel_number: string | null
  location?: string | null
  owner_1: string | null
  owner_2: string | null
  sale_date: string | null
  sale_price: number | string | null
  mailing_street: string | null
  mailing_zip: string | null
}

/** An OPA parcel number: exactly nine digits once spaces and dashes are gone, or null. */
export function parcelNumber(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/[\s-]/g, '')
  return /^\d{9}$/.test(digits) ? digits : null
}

/** Who owns these parcels now. Only nine-digit parcel numbers go into the SQL. */
export function buildParcelOwnersSql(parcels: readonly string[]): string {
  if (parcels.length === 0 || parcels.length > MAX_PER_QUERY) {
    throw new Error(`buildParcelOwnersSql: between 1 and ${MAX_PER_QUERY} parcels`)
  }
  for (const p of parcels) {
    if (typeof p !== 'string' || !/^\d{9}$/.test(p)) {
      throw new Error(`buildParcelOwnersSql: bad parcel number ${String(p)}`)
    }
  }
  const list = [...new Set(parcels)].map((p) => `'${p}'`).join(',')
  return (
    'SELECT parcel_number, location, owner_1, owner_2, sale_date, sale_price, mailing_street, mailing_zip ' +
    `FROM ${OPA_TABLE} WHERE parcel_number IN (${list}) LIMIT ${int(parcels.length * 2, 'limit')}`
  )
}

const words = (s: string | null | undefined) =>
  (s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()

/** Both owner names, normalised and in a fixed order, so "SMITH JOHN" matches "Smith, John". */
function ownersKey(row: Partial<OpaOwnerRow>): string {
  return [words(row.owner_1), words(row.owner_2)].filter(Boolean).sort().join('|')
}

function mailKey(row: Partial<OpaOwnerRow>): string {
  const street = words(row.mailing_street)
  return street ? `${street}|${(row.mailing_zip ?? '').slice(0, 5)}` : ''
}

function price(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** The stored OPA row of a property, when it came from OPA. */
function storedOpa(p: Property): Partial<OpaOwnerRow> | null {
  if (p.source !== 'opa' || !p.raw || typeof p.raw !== 'object') return null
  return p.raw as Partial<OpaOwnerRow>
}

/** The parcels that clearly changed hands since we learned they owned them. Pure. */
export function soldParcels(
  stored: Property[],
  current: OpaOwnerRow[],
  leadCreatedAt: string,
): SoldParcel[] {
  const byParcel = new Map<string, OpaOwnerRow>()
  for (const row of current) {
    const parcel = parcelNumber(row.parcel_number)
    if (parcel) byParcel.set(parcel, row)
  }
  const sold: SoldParcel[] = []
  const seen = new Set<string>()
  for (const p of stored) {
    const parcel = parcelNumber(p.opa_account)
    if (!parcel || seen.has(parcel)) continue
    seen.add(parcel)
    const now = byParcel.get(parcel)
    if (!now) continue // OPA no longer answers for it: no evidence either way
    const known = (p.sale_date ?? '').slice(0, 10) || leadCreatedAt.slice(0, 10)
    const saleDay = isoDate(now.sale_date)
    if (!saleDay || saleDay <= known) continue // no sale after what we knew
    const before = storedOpa(p)
    const ownersBefore = before ? ownersKey(before) : ''
    const ownersNow = ownersKey(now)
    if (ownersBefore && ownersBefore === ownersNow) continue // same owner, a newer deed
    const amount = price(now.sale_price)
    const nominal = amount === null || amount < NOMINAL_SALE_PRICE
    if (nominal) {
      // A family or LLC transfer. Still theirs when it went to the same mailing address, and
      // without a stored owner to compare it is too weak to call a sale.
      if (!before || !ownersBefore) continue
      const mailBefore = mailKey(before)
      if (mailBefore && mailBefore === mailKey(now)) continue
    }
    sold.push({
      parcel,
      address: p.address ?? now.location ?? null,
      sale_date: saleDay,
      sale_price: amount,
      new_owner: [now.owner_1, now.owner_2].filter(Boolean).join(' & ') || null,
    })
  }
  return sold
}

export function ownershipRecord(lead: Pick<Lead, 'enrichment'>): OwnershipRecord | null {
  const data = lead.enrichment?.[OWNERSHIP_KEY]?.data as Partial<OwnershipRecord> | undefined
  if (!data || typeof data !== 'object' || typeof data.checked_at !== 'string') return null
  return {
    checked_at: data.checked_at,
    status: data.status === 'sold_off' || data.status === 'owns' ? data.status : 'unknown',
    checked: typeof data.checked === 'number' ? data.checked : 0,
    owned_now: typeof data.owned_now === 'number' ? data.owned_now : 0,
    sold: Array.isArray(data.sold) ? data.sold : [],
  }
}

/** No check yet, or the last one is more than OWNERSHIP_RECHECK_DAYS old. */
export function needsOwnershipCheck(lead: Pick<Lead, 'enrichment'>, now: Date): boolean {
  const record = ownershipRecord(lead)
  if (!record) return true
  const at = Date.parse(record.checked_at)
  return !Number.isFinite(at) || now.getTime() - at > OWNERSHIP_RECHECK_DAYS * DAY_MS
}

/**
 * Ask OPA who owns this lead's parcels now, save what was found on the lead, and mark them
 * disqualified when they sold off. Carto errors reach the caller, which carries on without it.
 */
export async function checkOwnership(
  deps: { db: Db; now: () => Date; fetch: typeof globalThis.fetch },
  settings: Pick<Settings, 'min_props'>,
  lead: Lead,
  opts: { client?: CartoClient } = {},
): Promise<OwnershipResult> {
  const now = deps.now().toISOString()
  const stored = await deps.db.select().from(properties).where(eq(properties.lead_id, lead.id))
  const parcels = [
    ...new Set(stored.map((p) => parcelNumber(p.opa_account)).filter(Boolean)),
  ] as string[]

  let current: OpaOwnerRow[] = []
  if (parcels.length > 0) {
    const client = opts.client ?? createCartoClient({ fetch: deps.fetch })
    for (let i = 0; i < parcels.length; i += MAX_PER_QUERY) {
      current = current.concat(
        await client.query<OpaOwnerRow>(buildParcelOwnersSql(parcels.slice(i, i + MAX_PER_QUERY))),
      )
    }
  }
  const answered = new Set(current.map((r) => parcelNumber(r.parcel_number)).filter(Boolean))
  const checked = parcels.filter((p) => answered.has(p)).length
  const sold = soldParcels(stored, current, lead.created_at)
  const ownedNow = checked - sold.length
  const remaining = Math.max(ownedNow, lead.property_count - sold.length)
  const status: OwnershipResult['status'] =
    checked === 0
      ? 'unknown'
      : sold.length > 0 && (ownedNow === 0 || remaining < settings.min_props)
        ? 'sold_off'
        : 'owns'

  const record: OwnershipRecord = { checked_at: now, status, checked, owned_now: ownedNow, sold }
  const patch = JSON.stringify({ [OWNERSHIP_KEY]: { fetched_at: now, data: record } })
  const disqualify = status === 'sold_off' && MAY_DISQUALIFY.includes(lead.status)
  const fewer = status === 'owns' && sold.length > 0
  const saved = await deps.db
    .update(leads)
    .set({
      enrichment: sql`coalesce(${leads.enrichment}, '{}'::jsonb) || ${patch}::jsonb`,
      updated_at: now,
      ...(disqualify ? { status: 'disqualified' as const } : {}),
      ...(fewer
        ? { property_count: Math.max(ownedNow, lead.property_count - sold.length, 0) }
        : {}),
    })
    .where(eq(leads.id, lead.id))
    .returning()

  if (disqualify) {
    await deps.db.insert(events).values({
      id: newId(),
      lead_id: lead.id,
      kind: 'status_change',
      detail: {
        from: lead.status,
        to: 'disqualified',
        why: 'sold their properties',
        sold: sold.map((s) => s.parcel),
      },
      at: now,
    })
    await logActivity(
      'info',
      'sold_properties',
      { sold: sold.length, owned_now: ownedNow, min_props: settings.min_props },
      lead.id,
      deps.db,
    )
  }
  return { status, checked, owned_now: ownedNow, sold, lead: saved[0] ?? lead }
}
