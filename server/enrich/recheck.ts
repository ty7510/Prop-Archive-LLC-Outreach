// Check stored research answers again when the contact checks get better (CHECK_VERSION).
// No new research call: the stored answer already holds every contact with its source link and
// quotes, so this only opens the source pages again and re-runs verify.ts. Contacts an older
// check threw away by mistake reach the lead; nothing already on the lead is removed.
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getDb, type Db } from '../db/client.ts'
import { leads, properties, type Lead } from '../db/schema.ts'
import { errorDetail, logActivity } from '../lib/activity.ts'
import { computeChannels } from './channels.ts'
import { mergeProviderResult } from './merge.ts'
import { fetchPublicPage, type PageFetcher } from './pageCheck.ts'
import {
  CHECK_VERSION,
  mapResearchResult,
  ownerFacts,
  verifyContacts,
  type ResearchRaw,
} from './providers/claudeResearch.ts'
import type { LeadContactFields } from './types.ts'

export interface RecheckDeps {
  db?: Db
  pageFetcher?: PageFetcher
  now?: () => Date
}

export interface RecheckResult {
  checked: number
  /** Leads that got a contact field they did not have. */
  improved: number
}

/** Leads rechecked at the same time; each opens up to 12 pages at once. */
const RECHECK_CONCURRENCY = 3

function storedResearch(lead: Lead): ResearchRaw | null {
  const data = (lead.enrichment ?? {}).claude_research?.data
  return data && typeof data === 'object' ? (data as ResearchRaw) : null
}

/** A stored answer checked by an older version of the checks. */
export function needsRecheck(lead: Lead): boolean {
  const raw = storedResearch(lead)
  return raw !== null && (raw.check_version ?? 1) < CHECK_VERSION
}

/** Up to `limit` lead ids whose stored research was checked by an older version. */
export async function pickRecheck(limit: number, db: Db): Promise<string[]> {
  const page = 500
  const picked: string[] = []
  for (let offset = 0; picked.length < limit; offset += page) {
    const rows = await db
      .select()
      .from(leads)
      // A lead being enriched right now is left alone, so the two never write over each other.
      .where(
        and(
          eq(leads.do_not_contact, false),
          inArray(leads.status, ['new', 'enriched', 'enrolled', 'contacted']),
        ),
      )
      .orderBy(asc(leads.created_at), asc(leads.id))
      .limit(page)
      .offset(offset)
    for (const r of rows) if (picked.length < limit && needsRecheck(r)) picked.push(r.id)
    if (rows.length < page) break
  }
  return picked
}

async function recheckOne(leadId: string, deps: Required<RecheckDeps>): Promise<boolean> {
  const { db } = deps
  const rows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  const lead = rows[0]
  if (!lead || !needsRecheck(lead)) return false
  const raw = storedResearch(lead)!
  const enrichment = { ...(lead.enrichment ?? {}) }
  const entry = enrichment.claude_research!

  // Answers with no contacts (or from before contacts had proof) only get the new version stamp.
  if (!Array.isArray(raw.contacts) || raw.contacts.length === 0) {
    enrichment.claude_research = { ...entry, data: { ...raw, check_version: CHECK_VERSION } }
    await db.update(leads).set({ enrichment }).where(eq(leads.id, leadId))
    return false
  }

  const owned = await db.select().from(properties).where(eq(properties.lead_id, leadId))
  const rentals = owned.map((p) => p.address ?? '').filter(Boolean)
  const checked = await verifyContacts(raw, ownerFacts(lead, rentals), deps.pageFetcher)
  const result = mapResearchResult(raw, lead, 0, checked, raw.profile_titles)
  const current: Lead = { ...lead }
  const patch = mergeProviderResult(current, result)
  Object.assign(current, patch)
  enrichment.claude_research = { ...entry, data: result.raw ?? null }
  const update: Partial<Lead> = {
    ...patch,
    enrichment,
    channels: computeChannels(current),
    updated_at: deps.now().toISOString(),
  }
  await db.update(leads).set(update).where(eq(leads.id, leadId))

  const learned = Object.keys(patch) as (keyof LeadContactFields)[]
  const before = (raw.checked ?? []).filter((c) => c.verdict !== 'rejected').length
  const after = checked.filter((c) => c.verdict !== 'rejected').length
  if (learned.length > 0 || after !== before) {
    await logActivity(
      'info',
      'enrich.recheck',
      { learned, kept_before: before, kept_now: after },
      leadId,
      db,
    )
  }
  return learned.length > 0
}

/** Recheck up to `limit` leads. Never throws for one lead's problem. */
export async function recheckStored(limit: number, deps: RecheckDeps = {}): Promise<RecheckResult> {
  const full: Required<RecheckDeps> = {
    db: deps.db ?? getDb(),
    pageFetcher: deps.pageFetcher ?? fetchPublicPage,
    now: deps.now ?? (() => new Date()),
  }
  const ids = await pickRecheck(limit, full.db)
  let improved = 0
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!
      try {
        if (await recheckOne(id, full)) improved++
      } catch (err) {
        await logActivity('warn', 'enrich.recheck_error', errorDetail(err), id, full.db)
      }
    }
  }
  await Promise.all(Array.from({ length: RECHECK_CONCURRENCY }, worker))
  return { checked: ids.length, improved }
}
