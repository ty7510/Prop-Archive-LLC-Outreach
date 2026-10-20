// Check the LinkedIn links already on leads: the name on the profile must be the lead's name.
// Links saved before this check (2026-10-20) were often a namesake's or another person's profile.
// A link a source found whose name is not the lead's is taken off the lead and off their waiting
// to-do card, and remembered as rejected so the finder never picks it again, the same as Theo's
// "wrong person" button. Links Theo pasted or imported are his and are never touched.
import { and, eq, isNotNull, like, sql } from 'drizzle-orm'
import { getDb, type Db } from '../db/client.ts'
import { events, leads, messages, type Lead } from '../db/schema.ts'
import { errorDetail, logActivity } from '../lib/activity.ts'
import { newId } from '../lib/ids.ts'
import { computeChannels } from './channels.ts'
import { linkedInKey, linkedInNameMatches } from './linkedinName.ts'
import type { ResearchRaw } from './providers/claudeResearch.ts'

/** Bump when the name check changes, so every saved link is checked again. */
export const NAME_CHECK_VERSION = 1
/** Where the result is kept, in leads.enrichment. */
export const NAME_CHECK_KEY = 'linkedin_check'
/** The finder's record (linkedinFinder.ts FINDER_KEY): its rejected list is never picked again. */
const FINDER_KEY = 'linkedin_find'
/** To-do list messages (todo.ts TODO_KEY_PREFIX). */
export const TODO_PREFIX = 'todo:'

export interface NameCheckResult {
  checked: number
  /** Links taken off because the name on the profile was someone else's. */
  removed: number
}

type Enrichment = NonNullable<Lead['enrichment']>

function data(enrichment: Enrichment, key: string): Record<string, unknown> | null {
  const d = (enrichment as Record<string, { data?: unknown } | undefined>)[key]?.data
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function personName(p: Record<string, unknown> | null): string {
  if (!p) return ''
  return str(p.full_name) || str(p.name) || [str(p.first_name), str(p.last_name)].join(' ').trim()
}

/**
 * The names each source showed for this link. null when no source found it (Theo pasted it, or
 * it came in an import): then it is his and stays.
 */
export function sourceNamesFor(lead: Lead, key: string): string[][] | null {
  const enrichment = lead.enrichment ?? {}
  const found: string[][] = []
  const same = (v: unknown) => linkedInKey(str(v)) === key

  const research = data(enrichment, 'claude_research') as ResearchRaw | null
  if (research && Array.isArray(research.checked)) {
    const mine = research.checked.filter((c) => c.field === 'linkedin_url' && same(c.value))
    if (mine.length > 0) {
      found.push(
        research.profile_titles
          ? (research.profile_titles[key] ?? [])
          : mine.flatMap((c) => [str(c.quote), str(c.tie_quote)]).filter(Boolean),
      )
    }
  }
  const apollo = data(enrichment, 'apollo')?.person as Record<string, unknown> | undefined
  if (apollo && same(apollo.linkedin_url)) found.push([personName(apollo)].filter(Boolean))
  const pdl = data(enrichment, 'pdl')?.data as Record<string, unknown> | undefined
  if (pdl && same(pdl.linkedin_url)) found.push([personName(pdl)].filter(Boolean))
  const hunter = (data(enrichment, 'hunter')?.finder as { data?: Record<string, unknown> })?.data
  if (hunter && same(hunter.linkedin_url)) found.push([personName(hunter)].filter(Boolean))
  const finder = data(enrichment, FINDER_KEY)
  if (finder && same(finder.url)) found.push([str(finder.title)].filter(Boolean))

  return found.length > 0 ? found : null
}

/** Did Theo paste this link himself? */
async function pastedByHand(db: Db, leadId: string, key: string): Promise<boolean> {
  const rows = await db
    .select({ detail: events.detail })
    .from(events)
    .where(and(eq(events.lead_id, leadId), sql`${events.detail} ->> 'by' = 'hand'`))
  return rows.some((r) => {
    const d = (r.detail ?? {}) as Record<string, unknown>
    return d.wrong_person !== true && linkedInKey(str(d.linkedin_url)) === key
  })
}

function rejectedUrl(key: string): string {
  return `https://www.linkedin.com/${key}/`
}

async function checkOne(db: Db, lead: Lead, now: Date): Promise<boolean> {
  const url = str(lead.linkedin_url)
  const key = linkedInKey(url)
  const enrichment: Enrichment = { ...(lead.enrichment ?? {}) }
  const at = now.toISOString()
  const mark = (ok: boolean) => {
    ;(enrichment as Record<string, unknown>)[NAME_CHECK_KEY] = {
      fetched_at: at,
      data: { url, ok, version: NAME_CHECK_VERSION },
    }
  }

  const sources = key ? sourceNamesFor(lead, key) : null
  const keep =
    !key ||
    sources === null ||
    sources.some((names) => linkedInNameMatches(lead, url, names)) ||
    (await pastedByHand(db, lead.id, key))
  if (keep) {
    mark(true)
    await db.update(leads).set({ enrichment }).where(eq(leads.id, lead.id))
    return false
  }

  mark(false)
  const prior = data(enrichment, FINDER_KEY) ?? {}
  const rejected = Array.isArray(prior.rejected)
    ? prior.rejected.filter((r): r is string => typeof r === 'string')
    : []
  ;(enrichment as Record<string, unknown>)[FINDER_KEY] = {
    fetched_at: at,
    data: {
      ...prior,
      url: null,
      title: null,
      reason: 'the name on the LinkedIn profile is not their name',
      tried_at: str(prior.tried_at) || at,
      rejected: [...new Set([...rejected, rejectedUrl(key!)])],
    },
  }
  const cleared = await db
    .update(leads)
    .set({
      linkedin_url: null,
      channels: computeChannels({ ...lead, linkedin_url: null }),
      enrichment,
      updated_at: at,
    })
    // Only if the link is still the one checked (Theo may have pasted another meanwhile).
    .where(and(eq(leads.id, lead.id), eq(leads.linkedin_url, lead.linkedin_url!)))
    .returning({ id: leads.id })
  if (cleared.length === 0) return false

  // Their waiting LinkedIn note keeps its words but loses the wrong profile, like "wrong person".
  const waiting = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.lead_id, lead.id),
        eq(messages.status, 'ready_for_human'),
        eq(messages.channel, 'linkedin'),
        like(messages.idempotency_key, `${TODO_PREFIX}%`),
      ),
    )
  for (const m of waiting) {
    if (linkedInKey(m.to_address) !== key) continue
    const raw = (m.raw ?? {}) as Record<string, unknown>
    await db
      .update(messages)
      .set({ to_address: null, raw: { ...raw, found_by_app: false } })
      .where(and(eq(messages.id, m.id), eq(messages.status, 'ready_for_human')))
  }

  const profileNames = [...new Set(sources!.flat())].slice(0, 3)
  await db.insert(events).values({
    id: newId(),
    lead_id: lead.id,
    kind: 'note',
    detail: {
      linkedin_url: url,
      by: 'name_check',
      wrong_person: true,
      profile_names: profileNames,
    },
    at,
  })
  await logActivity(
    'info',
    'linkedin_profile_name_mismatch',
    { url, lead_name: lead.full_name ?? lead.company, profile_names: profileNames },
    lead.id,
    db,
  )
  return true
}

/** Check up to `limit` saved LinkedIn links not yet checked by this version. Never throws per lead. */
export async function checkSavedLinkedIn(
  limit: number,
  deps: { db?: Db; now?: () => Date } = {},
): Promise<NameCheckResult> {
  const db = deps.db ?? getDb()
  const now = deps.now ?? (() => new Date())
  const rows = await db
    .select()
    .from(leads)
    .where(
      and(
        isNotNull(leads.linkedin_url),
        sql`(coalesce(${leads.enrichment} -> ${NAME_CHECK_KEY} -> 'data' ->> 'url', '') <> ${leads.linkedin_url}
          or coalesce((${leads.enrichment} -> ${NAME_CHECK_KEY} -> 'data' ->> 'version')::int, 0) < ${NAME_CHECK_VERSION})`,
      ),
    )
    .limit(limit)
  let removed = 0
  for (const lead of rows) {
    try {
      if (await checkOne(db, lead, now())) removed++
    } catch (err) {
      await logActivity('warn', 'linkedin_check_error', errorDetail(err), lead.id, db)
    }
  }
  return { checked: rows.length, removed }
}
