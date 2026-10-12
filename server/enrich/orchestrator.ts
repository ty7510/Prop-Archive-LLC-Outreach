// The enrichment orchestrator: runs providers in settings order, stops early when a lead has email
// and (linkedin or phone), respects monthly credit caps, stores raw payloads, recomputes channels,
// and moves status new -> enriching -> enriched. One provider failing never fails the batch.
import { and, asc, eq, gte, inArray } from 'drizzle-orm'
import type { EnrichProviderId, Settings } from '../../shared/settings.ts'
import type { EnrichResult, LeadEnrichment } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { leads, properties, type Lead, type Property } from '../db/schema.ts'
import { env as processEnv, type Env } from '../env.ts'
import { logActivity } from '../lib/activity.ts'
import { getSettings } from '../lib/settings.ts'
import { computeChannels, hasEnoughContact } from './channels.ts'
import { mergeProviderResult } from './merge.ts'
import { createProviders } from './providers/index.ts'
import type { EnrichContext, EnrichProvider, LeadContactFields, PropertyUpdate } from './types.ts'
import { capFor, creditsUsed, monthRange, recordUsage, wouldExceedCap } from './usage.ts'

/** Statuses the orchestrator is allowed to move. Anything further along (enrolled, replied...) stays. */
const MANAGED_STATUSES = new Set<Lead['status']>(['new', 'enriching', 'enriched'])

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
  }
}

/** Leads ready for enrichment: new, scored high enough, a wanted persona, contactable. Oldest first. */
export async function pickBatch(limit: number, deps: OrchestratorDeps = {}): Promise<string[]> {
  const db = deps.db ?? getDb()
  const settings = await getSettings(db)
  if (settings.personas.length === 0 || limit <= 0) return []
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.status, 'new'),
        eq(leads.do_not_contact, false),
        inArray(leads.persona, settings.personas),
        gte(leads.icp_score, settings.min_icp_score),
      ),
    )
    .orderBy(asc(leads.created_at), asc(leads.id))
    .limit(limit)
  return rows.map((r) => r.id)
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

    const cap = capFor(settings.enrichment.monthly_credit_cap, provider.id)
    if (cap !== null) {
      if (batch.capReached.has(provider.id)) continue
      const range = monthRange(now, settings.send_window.tz)
      const { used } = await creditsUsed(provider.id, range, db)
      if (wouldExceedCap(used, provider.costPerCall, cap)) {
        batch.capReached.add(provider.id)
        await logActivity(
          'warn',
          'enrich.cap_reached',
          { provider: provider.id, used, cap, month: range.key },
          null,
          db,
        )
        continue
      }
    }

    attempted++
    let result
    try {
      result = await provider.enrich(current, ctx)
    } catch (err) {
      errored++
      await log('warn', 'enrich.provider_error', {
        provider: provider.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    ran.push(provider.id)
    await recordUsage(provider.id, result.credits_used ?? provider.costPerCall, leadId, now, db)

    const patch = mergeProviderResult(current, result)
    for (const key of Object.keys(patch) as (keyof LeadContactFields)[]) learned.add(key)
    Object.assign(current, patch)
    enrichment[provider.id] = { fetched_at: now.toISOString(), data: result.raw ?? null }
    if (result.property_updates?.length) {
      await applyPropertyUpdates(db, leadId, result.property_updates, owned)
    }
  }

  const failed = attempted > 0 && errored === attempted
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
  })
  return failed ? 'failed' : 'enriched'
}

/** Enrich these leads one after another. Returns counts. Never throws for a provider problem. */
export async function enrichLeads(
  ids: string[],
  deps: OrchestratorDeps = {},
): Promise<EnrichResult> {
  const unique = [...new Set(ids.filter(Boolean))]
  const counts: EnrichResult = { enriched: 0, failed: 0, skipped: 0 }
  if (unique.length === 0) return counts
  const batch = await makeBatch(deps)
  for (const id of unique) {
    try {
      counts[await enrichOne(id, batch)]++
    } catch (err) {
      // A database hiccup on one lead must not stop the rest.
      counts.failed++
      await logActivity(
        'error',
        'enrich.lead_error',
        { error: err instanceof Error ? err.message : String(err) },
        id,
        batch.db,
      )
    }
  }
  await logActivity('info', 'enrich.batch', { requested: unique.length, ...counts }, null, batch.db)
  return counts
}
