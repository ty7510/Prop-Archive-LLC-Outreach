// Put one candidate into the leads table: create it, merge it into the owner we already have,
// or skip it. The only place sources write leads and properties. Owned by the sources builder.
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Settings } from '../../shared/settings.ts'
import { getDb, type Db } from '../db/client.ts'
import { leads, properties, type Lead, type Property } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import {
  dedupeKeyFor,
  isUsableCandidate,
  mergeIntoLead,
  normaliseCandidate,
  type LeadCandidate,
  type NormalisedCandidate,
  type PropertyCandidate,
} from './merge.ts'
import { personaFor, scoreLead } from './score.ts'

export type UpsertOutcome = 'created' | 'merged' | 'skipped'

export interface UpsertResult {
  outcome: UpsertOutcome
  lead_id: string | null
  /** Why a row was skipped, in plain words. */
  reason?: string
}

export interface UpsertOptions {
  settings: Pick<Settings, 'target_zips'>
  db?: Db
  now?: Date
  /** When false, only merges happen; a brand-new owner is skipped (daily cap reached). */
  allowCreate?: boolean
}

export function newUnsubscribeToken(): string {
  return randomBytes(16).toString('hex')
}

/** Find the lead this candidate belongs to: by dedupe key first, then by email. */
export async function findExistingLead(
  c: NormalisedCandidate,
  db: Db = getDb(),
): Promise<Lead | null> {
  if (c.dedupe_key) {
    const [byKey] = await db.select().from(leads).where(eq(leads.dedupe_key, c.dedupe_key)).limit(1)
    if (byKey) return byKey
  }
  if (c.email) {
    const [byEmail] = await db.select().from(leads).where(eq(leads.email, c.email)).limit(1)
    if (byEmail) return byEmail
  }
  return null
}

const sameProperty = (a: Property, b: PropertyCandidate): boolean => {
  if (a.opa_account && b.opa_account) return a.opa_account === b.opa_account
  if (a.license_num && b.license_num) return a.license_num === b.license_num
  return Boolean(
    a.address && b.address && a.address === b.address && (a.zip ?? '') === (b.zip ?? ''),
  )
}

/** Add the candidate's properties to a lead, filling in blanks on ones we already have. */
export async function upsertProperties(
  leadId: string,
  incoming: PropertyCandidate[],
  db: Db = getDb(),
): Promise<{ added: number; updated: number; all: Property[] }> {
  const existing = await db.select().from(properties).where(eq(properties.lead_id, leadId))
  let added = 0
  let updated = 0
  for (const p of incoming) {
    const match = existing.find((e) => sameProperty(e, p))
    if (!match) {
      const row: Property = {
        id: newId(),
        lead_id: leadId,
        address: p.address ?? null,
        zip: p.zip ?? null,
        category: p.category ?? null,
        units: p.units ?? null,
        sale_date: p.sale_date ?? null,
        sale_price: p.sale_price ?? null,
        market_value: p.market_value ?? null,
        opa_account: p.opa_account ?? null,
        license_num: p.license_num ?? null,
        license_issue_date: p.license_issue_date ?? null,
        license_expiry: p.license_expiry ?? null,
        source: p.source ?? 'opa',
        raw: p.raw ?? null,
      }
      await db.insert(properties).values(row)
      existing.push(row)
      added++
      continue
    }
    const patch: Partial<Property> = {}
    for (const f of [
      'category',
      'units',
      'sale_date',
      'sale_price',
      'market_value',
      'opa_account',
      'license_num',
      'license_issue_date',
      'license_expiry',
    ] as const) {
      const next = p[f]
      if ((match[f] === null || match[f] === undefined) && next !== null && next !== undefined) {
        ;(patch as Record<string, unknown>)[f] = next
      }
    }
    if (Object.keys(patch).length > 0) {
      await db
        .update(properties)
        .set(patch)
        .where(and(eq(properties.id, match.id), eq(properties.lead_id, leadId)))
      Object.assign(match, patch)
      updated++
    }
  }
  return { added, updated, all: existing }
}

/** Score and persona for a lead given its properties. */
export function scoreFor(
  lead: Pick<
    Lead,
    'property_count' | 'zips' | 'trigger' | 'mailing_city' | 'mailing_state' | 'mailing_zip'
  >,
  props: { category?: string | null }[],
  settings: Pick<Settings, 'target_zips'>,
  now = new Date(),
): { icp_score: number; persona: Lead['persona'] } {
  return {
    icp_score: scoreLead(
      {
        property_count: lead.property_count,
        zips: lead.zips,
        trigger: lead.trigger,
        categories: props.map((p) => p.category),
        mailing_city: lead.mailing_city,
        mailing_state: lead.mailing_state,
        mailing_zip: lead.mailing_zip,
      },
      settings,
      now,
    ),
    persona: personaFor(lead.property_count),
  }
}

/**
 * When a lead keyed by email (or nothing) has just learned a mailing address, its key becomes the
 * street|zip one, so a later public-record candidate for the same owner merges instead of making a
 * second lead. Returns the new key, or null when nothing should change (including when another
 * lead already holds that key).
 */
async function betterDedupeKey(
  existing: Lead,
  merged: Pick<Lead, 'mailing_street' | 'mailing_zip' | 'email'>,
  db: Db,
): Promise<string | null> {
  const current = existing.dedupe_key
  if (current && current.includes('|')) return null
  const next = dedupeKeyFor(merged)
  if (!next || !next.includes('|') || next === current) return null
  const [taken] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.dedupe_key, next))
    .limit(1)
  return taken ? null : next
}

/** Create, merge or skip one candidate. Never throws for a bad candidate; it reports 'skipped'. */
export async function upsertCandidate(
  candidate: LeadCandidate,
  opts: UpsertOptions,
): Promise<UpsertResult> {
  const db = opts.db ?? getDb()
  const now = opts.now ?? new Date()
  const c = normaliseCandidate(candidate)
  if (!isUsableCandidate(c)) {
    return { outcome: 'skipped', lead_id: null, reason: 'no name, company or email to go on' }
  }

  const existing = await findExistingLead(c, db)
  if (existing) {
    const patch = mergeIntoLead(existing, c)
    const propsResult = await upsertProperties(existing.id, c.properties, db)
    // The property list may now be longer than any count a source reported.
    const propertyCount = Math.max(
      patch.property_count ?? existing.property_count,
      propsResult.all.length,
    )
    if (propertyCount !== existing.property_count) patch.property_count = propertyCount
    const unitsFromProps = propsResult.all.reduce((s, p) => s + (p.units ?? 0), 0)
    if (unitsFromProps > (patch.unit_count ?? existing.unit_count))
      patch.unit_count = unitsFromProps

    const merged = { ...existing, ...patch }
    const score = scoreFor(merged, propsResult.all, opts.settings, now)
    const dedupeKey = await betterDedupeKey(existing, merged, db)
    const changed =
      Object.keys(patch).length > 0 ||
      propsResult.added > 0 ||
      propsResult.updated > 0 ||
      dedupeKey !== null ||
      score.icp_score !== existing.icp_score ||
      score.persona !== existing.persona
    if (changed) {
      await db
        .update(leads)
        .set({
          ...patch,
          ...score,
          ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
          updated_at: now.toISOString(),
        })
        .where(eq(leads.id, existing.id))
    }
    return { outcome: 'merged', lead_id: existing.id }
  }

  if (opts.allowCreate === false) {
    return { outcome: 'skipped', lead_id: null, reason: 'daily limit for new leads reached' }
  }

  const id = newId()
  const at = now.toISOString()
  const score = scoreFor(
    {
      property_count: c.property_count,
      zips: c.zips,
      trigger: c.trigger,
      mailing_city: c.mailing_city,
      mailing_state: c.mailing_state,
      mailing_zip: c.mailing_zip,
    },
    c.properties,
    opts.settings,
    now,
  )
  await db.insert(leads).values({
    id,
    created_at: at,
    updated_at: at,
    source: c.source,
    status: 'new',
    persona: score.persona,
    icp_score: score.icp_score,
    owner_kind: c.owner_kind,
    full_name: c.full_name,
    first_name: c.first_name,
    last_name: c.last_name,
    company: c.company,
    email: c.email,
    phone: c.phone,
    linkedin_url: c.linkedin_url ?? null,
    instagram_url: c.instagram_url ?? null,
    website: c.website ?? null,
    mailing_street: c.mailing_street,
    mailing_city: c.mailing_city,
    mailing_state: c.mailing_state,
    mailing_zip: c.mailing_zip,
    mailing_verified: false,
    property_count: c.property_count,
    unit_count: c.unit_count,
    zips: c.zips,
    trigger: c.trigger,
    tags: c.tags,
    notes: c.notes ?? null,
    unsubscribe_token: newUnsubscribeToken(),
    dedupe_key: c.dedupe_key,
  })
  if (c.properties.length > 0) await upsertProperties(id, c.properties, db)
  return { outcome: 'created', lead_id: id }
}
