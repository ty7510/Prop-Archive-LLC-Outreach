// The enrichment orchestrator: runs providers in settings order, stops once nothing is left to find,
// respects monthly credit caps, stores raw payloads, recomputes channels,
// and moves status new -> enriching -> enriched. One provider failing never fails the batch.
import { and, asc, eq, gte, inArray } from 'drizzle-orm'
import type { EnrichProviderId, Settings } from '../../shared/settings.ts'
import type { EnrichResult, LeadEnrichment, ResearchPaused } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { leads, properties, type Lead, type Property } from '../db/schema.ts'
import { env as processEnv, type Env } from '../env.ts'
import { errorDetail, logActivity } from '../lib/activity.ts'
import { getSettings } from '../lib/settings.ts'
import { computeChannels, hasEnoughContact } from './channels.ts'
import { mergeProviderResult } from './merge.ts'
import { researchOwed } from './pending.ts'
import { createProviders } from './providers/index.ts'
import type { EnrichContext, EnrichProvider, LeadContactFields, PropertyUpdate } from './types.ts'
import { capFor, creditsUsed, monthRange, recordUsage, wouldExceedCap } from './usage.ts'

/** Statuses the orchestrator is allowed to move. Anything further along (enrolled, replied...) stays. */
const MANAGED_STATUSES = new Set<Lead['status']>(['new', 'enriching', 'enriched'])

/** Leads researched at the same time. Web research takes minutes per lead; one at a time is too slow. */
export const ENRICH_CONCURRENCY = 4
/** Leads failing in a row on a database error: the connection is gone, so stop the batch. */
export const MAX_LEAD_ERRORS_IN_A_ROW = 3
/** A lead left "enriching" this long was cut off mid-run (a restart or a crash): pick it again. */
export const STALE_ENRICHING_MS = 30 * 60_000
/** After a provider fails on credits, its key or an outage, it is not asked again for this long. */
export const PROVIDER_DOWN_MS = 15 * 60_000

const downUntil = new Map<EnrichProviderId, number>()

/** For tests: forget that a provider was down. */
export function resetProviderDown(): void {
  downUntil.clear()
}

function isDown(id: EnrichProviderId, now: Date): boolean {
  const until = downUntil.get(id)
  return until !== undefined && now.getTime() < until
}

/**
 * Why a provider will keep failing for every lead, or null when the error was about this lead only.
 * Credits, the key and an outage are account-wide: asking again at once only fails again.
 */
export function providerDownReason(err: unknown): { reason: string; hint: string } | null {
  const d = errorDetail(err)
  const own = (err as { status?: unknown }).status
  const status = typeof own === 'number' ? own : Number(/^(\d{3})\b/.exec(d.error)?.[1] ?? NaN)
  if (status === 402 || /credit balance/i.test(`${d.error} ${d.cause ?? ''}`)) {
    return {
      reason: 'the Anthropic account is out of credits',
      hint: 'Add credits at console.anthropic.com under Plans and Billing. Leads wait for research; nothing is sent to them until it has looked.',
    }
  }
  if (status === 401 || status === 403) {
    return { reason: 'Claude refused the key', hint: 'Check the key in Replit Secrets.' }
  }
  if (status === 429) {
    return { reason: 'Claude rate limit reached', hint: 'Tried again in 15 minutes.' }
  }
  if (status >= 500) {
    return { reason: 'Claude could not be reached', hint: 'Tried again in 15 minutes.' }
  }
  return null
}

async function markDown(id: EnrichProviderId, err: unknown, batch: BatchState): Promise<void> {
  const why = providerDownReason(err)
  if (!why) return
  const now = batch.now()
  const wasDown = isDown(id, now)
  const until = new Date(now.getTime() + PROVIDER_DOWN_MS)
  downUntil.set(id, until.getTime())
  if (wasDown) return
  await logActivity(
    'error',
    'enrich.provider_down',
    { provider: id, ...why, retry_at: until.toISOString() },
    null,
    batch.db,
  )
}

/** Research is paused while the provider is down or its monthly cap is reached. */
/**
 * The paid lookup APIs. They look a person up by name, not by web search, so they still work when
 * Claude web research is paused (Theo, 2026-10-19: out of web searches). Each runs once per lead.
 */
const LOOKUP_APIS = new Set<EnrichProviderId>(['apollo', 'pdl', 'hunter'])

/** Lookup APIs that are on, have a key, and have credits left this month. */
async function lookupsWithRoom(
  settings: Settings,
  all: Partial<Record<EnrichProviderId, EnrichProvider>>,
  env: Env,
  db: Db,
  now: Date,
): Promise<EnrichProvider[]> {
  const out: EnrichProvider[] = []
  for (const id of settings.enrichment.providers) {
    const provider = all[id]
    if (!provider || !LOOKUP_APIS.has(id) || !provider.isConfigured(env)) continue
    const cap = capFor(settings.enrichment.monthly_credit_cap, id)
    if (cap !== null) {
      const { used } = await creditsUsed(id, monthRange(now, settings.send_window.tz), db)
      if (wouldExceedCap(used, provider.costPerCall, cap)) continue
    }
    out.push(provider)
  }
  return out
}

async function researchPaused(
  settings: Settings,
  provider: EnrichProvider,
  db: Db,
  now: Date,
): Promise<boolean> {
  if (isDown(provider.id, now)) return true
  const cap = capFor(settings.enrichment.monthly_credit_cap, provider.id)
  if (cap === null) return false
  const { used } = await creditsUsed(provider.id, monthRange(now, settings.send_window.tz), db)
  return wouldExceedCap(used, provider.costPerCall, cap)
}

/**
 * Why Claude web research is not running right now, or null when it can run (or is not in use).
 * The Enrich button shows this, so "Enriched 0" never comes with no reason.
 */
export async function researchPause(deps: OrchestratorDeps = {}): Promise<ResearchPaused | null> {
  const db = deps.db ?? getDb()
  const env = deps.env ?? processEnv
  const settings = await getSettings(db)
  const provider = { ...createProviders(), ...deps.providers }.claude_research
  if (!provider || !settings.enrichment.providers.includes('claude_research')) return null
  if (!provider.isConfigured(env)) return null
  const now = (deps.now ?? (() => new Date()))()
  if (isDown(provider.id, now)) return { reason: 'down', used: null, cap: null }
  const cap = capFor(settings.enrichment.monthly_credit_cap, provider.id)
  if (cap === null) return null
  const { used } = await creditsUsed(provider.id, monthRange(now, settings.send_window.tz), db)
  return wouldExceedCap(used, provider.costPerCall, cap) ? { reason: 'cap', used, cap } : null
}

export interface OrchestratorDeps {
  db?: Db
  env?: Env
  providers?: Partial<Record<EnrichProviderId, EnrichProvider>>
  now?: () => Date
}

export type LeadOutcome = 'enriched' | 'failed' | 'skipped'

interface BatchState {
  db: Db
  env: Env
  settings: Settings
  now: () => Date
  ordered: EnrichProvider[]
  /** Providers already reported this batch, so the log gets one line, not one per lead. */
  capReached: Set<EnrichProviderId>
  notConfigured: Set<EnrichProviderId>
  /** Credits held by calls in flight on parallel leads, so a cap is never passed. */
  reserved: Map<EnrichProviderId, number>
}

async function makeBatch(deps: OrchestratorDeps): Promise<BatchState> {
  const db = deps.db ?? getDb()
  const env = deps.env ?? processEnv
  const settings = await getSettings(db)
  const all = { ...createProviders(), ...deps.providers }
  const ordered = settings.enrichment.providers
    .map((id) => all[id])
    .filter((p): p is EnrichProvider => Boolean(p))
  return {
    db,
    env,
    settings,
    now: deps.now ?? (() => new Date()),
    ordered,
    capReached: new Set(),
    notConfigured: new Set(),
    reserved: new Map(),
  }
}

/**
 * Leads ready for enrichment, oldest first: scored high enough, a wanted persona, contactable, and
 * either never enriched, or enriched before Claude web research had its turn (its key was added
 * later) while contact fields are still missing. Without that second case, leads enriched before
 * the Claude key existed would never be researched. Only Claude counts here: it applies to every
 * lead, so a lead it has researched is never picked again (a provider that skips a lead would
 * otherwise bring it back every round).
 */
export async function pickBatch(limit: number, deps: OrchestratorDeps = {}): Promise<string[]> {
  const db = deps.db ?? getDb()
  const env = deps.env ?? processEnv
  const settings = await getSettings(db)
  if (settings.personas.length === 0 || limit <= 0) return []
  const all = { ...createProviders(), ...deps.providers }
  const researchProvider = all.claude_research
  const research =
    settings.enrichment.providers.includes('claude_research') &&
    Boolean(researchProvider?.isConfigured(env))
  const now = (deps.now ?? (() => new Date()))()
  // While research is down or over its monthly cap, the leads waiting for it are left alone:
  // picking them would only fail again, and they must not count as enriched without it.
  const paused =
    research && researchProvider ? await researchPaused(settings, researchProvider, db, now) : false
  // While research is paused, a waiting lead is still picked when a lookup API has not had its turn
  // on them yet, so emails and LinkedIn profiles keep coming in.
  const lookups = paused ? await lookupsWithRoom(settings, all, env, db, now) : []
  const ctx: EnrichContext = { env, settings, properties: [], now, log: async () => {} }
  const lookupOwed = (r: Lead) =>
    lookups.some((p) => !(r.enrichment ?? {})[p.id] && p.applies(r, ctx))
  const staleBefore = new Date(now.getTime() - STALE_ENRICHING_MS)
  const wanted = (r: Lead) => {
    const owed = research && researchOwed(r)
    if (owed && paused) return lookupOwed(r)
    return (
      r.status === 'new' ||
      (r.status === 'enriching' && new Date(r.updated_at) < staleBefore) ||
      owed
    )
  }
  // Read a page at a time until there are enough. Done leads are dropped after reading, so one
  // page of the oldest leads can be all done while newer leads wait behind it.
  const page = Math.min(limit * 20, 2000)
  const picked: string[] = []
  for (let offset = 0; picked.length < limit; offset += page) {
    const rows = await db
      .select()
      .from(leads)
      .where(
        and(
          inArray(leads.status, ['new', 'enriching', 'enriched', 'enrolled']),
          eq(leads.do_not_contact, false),
          inArray(leads.persona, settings.personas),
          gte(leads.icp_score, settings.min_icp_score),
        ),
      )
      .orderBy(asc(leads.created_at), asc(leads.id))
      .limit(page)
      .offset(offset)
    for (const r of rows) if (picked.length < limit && wanted(r)) picked.push(r.id)
    if (rows.length < page) break
  }
  return picked
}

async function applyPropertyUpdates(
  db: Db,
  leadId: string,
  updates: PropertyUpdate[],
  owned: Property[],
): Promise<void> {
  for (const u of updates) {
    const target = owned.find((p) => p.opa_account === u.opa_account)
    if (!target) continue
    const patch: Partial<Property> = {}
    if (typeof u.units === 'number' && u.units > 0 && u.units !== target.units)
      patch.units = u.units
    if (u.license_num && !target.license_num) patch.license_num = u.license_num
    if (u.license_issue_date && !target.license_issue_date) {
      patch.license_issue_date = u.license_issue_date
    }
    if (u.license_expiry && !target.license_expiry) patch.license_expiry = u.license_expiry
    if (Object.keys(patch).length === 0) continue
    await db
      .update(properties)
      .set(patch)
      .where(and(eq(properties.id, target.id), eq(properties.lead_id, leadId)))
    Object.assign(target, patch)
  }
}

async function enrichOne(leadId: string, batch: BatchState): Promise<LeadOutcome> {
  const { db, env, settings } = batch
  const rows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
  const lead = rows[0]
  if (!lead) return 'skipped'
  if (lead.do_not_contact) return 'skipped'

  const owned = await db.select().from(properties).where(eq(properties.lead_id, leadId))
  const manageStatus = MANAGED_STATUSES.has(lead.status)
  const startedAt = batch.now()
  const current: Lead = { ...lead }
  if (manageStatus && lead.status !== 'enriching') {
    await db
      .update(leads)
      .set({ status: 'enriching', updated_at: startedAt.toISOString() })
      .where(eq(leads.id, leadId))
    current.status = 'enriching'
  }

  const enrichment: LeadEnrichment = { ...(lead.enrichment ?? {}) }
  const learned = new Set<keyof LeadContactFields>()
  const ran: EnrichProviderId[] = []
  let attempted = 0
  let errored = 0
  // Research is what finds emails and profiles. Without its answer the lead stays "new": picked
  // again later, and never put into the sequence with nothing to reach them on.
  let researchFailed = false

  const log: EnrichContext['log'] = async (level, event, detail) => {
    await logActivity(level, event, detail, leadId, db)
  }

  for (const provider of batch.ordered) {
    if (hasEnoughContact(current)) break
    if (!provider.isConfigured(env)) {
      // Hunter, Apollo and People Data Labs are optional paid add-ons: skip them quietly.
      if (provider.id === 'claude_research' && !batch.notConfigured.has(provider.id)) {
        batch.notConfigured.add(provider.id)
        await logActivity(
          'info',
          'enrich.provider_not_configured',
          {
            provider: provider.id,
            hint: 'add CLAUDE_API_KEY in Replit Secrets, then Publish, to turn it on',
          },
          null,
          db,
        )
      }
      continue
    }
    const now = batch.now()
    const ctx: EnrichContext = { env, settings, properties: owned, now, log }
    if (!provider.applies(current, ctx)) continue
    // A lookup API answers the same thing twice: never pay for it again on this lead.
    if (LOOKUP_APIS.has(provider.id) && enrichment[provider.id]) continue
    if (isDown(provider.id, now)) {
      if (provider.id === 'claude_research') researchFailed = true
      continue
    }

    const cap = capFor(settings.enrichment.monthly_credit_cap, provider.id)
    if (cap !== null) {
      if (batch.capReached.has(provider.id)) continue
      const range = monthRange(now, settings.send_window.tz)
      const { used } = await creditsUsed(provider.id, range, db)
      const held = batch.reserved.get(provider.id) ?? 0
      if (wouldExceedCap(used + held, provider.costPerCall, cap)) {
        // Another lead may have reached it while this one was counting: one log line per batch.
        if (batch.capReached.has(provider.id)) continue
        batch.capReached.add(provider.id)
        await logActivity(
          'warn',
          'enrich.cap_reached',
          { provider: provider.id, used: used + held, cap, month: range.key },
          null,
          db,
        )
        continue
      }
    }

    attempted++
    const hold = cap !== null ? provider.costPerCall : 0
    batch.reserved.set(provider.id, (batch.reserved.get(provider.id) ?? 0) + hold)
    let result
    try {
      result = await provider.enrich(current, ctx)
      ran.push(provider.id)
      await recordUsage(provider.id, result.credits_used ?? provider.costPerCall, leadId, now, db)
    } catch (err) {
      errored++
      await log('warn', 'enrich.provider_error', { provider: provider.id, ...errorDetail(err) })
      await markDown(provider.id, err, batch)
      if (provider.id === 'claude_research') researchFailed = true
      continue
    } finally {
      batch.reserved.set(provider.id, (batch.reserved.get(provider.id) ?? 0) - hold)
    }

    const patch = mergeProviderResult(current, result)
    for (const key of Object.keys(patch) as (keyof LeadContactFields)[]) learned.add(key)
    Object.assign(current, patch)
    enrichment[provider.id] = { fetched_at: now.toISOString(), data: result.raw ?? null }
    if (result.property_updates?.length) {
      await applyPropertyUpdates(db, leadId, result.property_updates, owned)
    }
  }

  const failed = (attempted > 0 && errored === attempted) || researchFailed
  const channels = computeChannels(current)
  const finishedAt = batch.now()
  const update: Partial<Lead> = {
    enrichment,
    channels,
    updated_at: finishedAt.toISOString(),
  }
  for (const key of learned) {
    // Learned fields are copied from the working copy, which merge already validated.
    ;(update as Record<string, unknown>)[key] = current[key]
  }
  if (manageStatus) update.status = failed ? 'new' : 'enriched'
  await db.update(leads).set(update).where(eq(leads.id, leadId))

  await log(failed ? 'warn' : 'info', failed ? 'enrich.lead_failed' : 'enrich.lead', {
    providers: ran,
    learned: [...learned],
    channels,
    ...(researchFailed ? { waiting_for: 'claude_research' } : {}),
  })
  return failed ? 'failed' : 'enriched'
}

/**
 * Enrich these leads, ENRICH_CONCURRENCY at a time. Returns counts. Never throws for a provider
 * problem. When several leads in a row fail on the database (a restart closed the pool), the batch
 * stops instead of failing every remaining lead; they stay as they were and are picked next time.
 */
export async function enrichLeads(
  ids: string[],
  deps: OrchestratorDeps = {},
): Promise<EnrichResult> {
  const unique = [...new Set(ids.filter(Boolean))]
  const counts: EnrichResult = { enriched: 0, failed: 0, skipped: 0 }
  if (unique.length === 0) return counts
  const batch = await makeBatch(deps)
  const queue = [...unique]
  let errorsInARow = 0
  let aborted = false
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined && !aborted; id = queue.shift()) {
      try {
        counts[await enrichOne(id, batch)]++
        errorsInARow = 0
      } catch (err) {
        // A database hiccup on one lead must not stop the rest.
        counts.failed++
        errorsInARow++
        await logActivity('error', 'enrich.lead_error', errorDetail(err), id, batch.db)
        // Put it back so the next batch picks it (best effort: the database may be the problem).
        await batch.db
          .update(leads)
          .set({ status: 'new' })
          .where(and(eq(leads.id, id), eq(leads.status, 'enriching')))
          .catch(() => undefined)
        if (errorsInARow >= MAX_LEAD_ERRORS_IN_A_ROW) aborted = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, unique.length) }, worker))
  if (aborted) {
    await logActivity(
      'error',
      'enrich.batch_aborted',
      { reason: `${MAX_LEAD_ERRORS_IN_A_ROW} leads in a row failed`, left: queue.length },
      null,
      batch.db,
    )
  }
  await logActivity('info', 'enrich.batch', { requested: unique.length, ...counts }, null, batch.db)
  return counts
}
