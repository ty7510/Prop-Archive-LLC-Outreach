// Discover: pull new owners from the public records and upsert them, under the daily cap.
// Order: OPA owner groups (the 3-20 property ICP, which honours min_props..max_props) take up to
// OPA_BUDGET_SHARE of the day's budget, then new rental licenses (fresh landlords, usually one
// property) take what is left, then recent sales (mostly merges onto owners we already have).
// Each source fails on its own; one bad Carto answer never stops the others.
// Owned by the sources builder.
import { and, count, gte, inArray } from 'drizzle-orm'
import type { DiscoverResult } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { leads } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { getSettings } from '../lib/settings.ts'
import { startOfDayInTz } from '../lib/time.ts'
import { createCartoClient, type CartoClient } from './carto.ts'
import { buildNewLicensesSql, LI_PAGE_SIZE, liRowsToCandidates, type LiRow } from './li.ts'
import type { LeadCandidate } from './merge.ts'
import {
  buildOpaOwnersSql,
  buildRecentSalesSql,
  OPA_OWNERS_PAGE_SIZE,
  OPA_SALES_PAGE_SIZE,
  opaRowsToCandidates,
  type OpaRow,
} from './opa.ts'
import { NEW_LICENSE_WINDOW_DAYS, RECENT_SALE_WINDOW_DAYS } from './score.ts'
import { upsertCandidate } from './upsert.ts'

/** Safety rails so one run can never loop forever against Carto. */
export const MAX_OWNER_PAGES = 100
export const MAX_TRIGGER_PAGES = 10

/** The share of the daily budget the OPA owner pass may use, so new licenses still get a slice. */
export const OPA_BUDGET_SHARE = 0.8

export interface DiscoverOptions {
  zips?: string[]
  /** Hard cap on new leads this run, on top of the daily cap. */
  limit?: number
}

export interface DiscoverDeps {
  db?: Db
  client?: CartoClient
  now?: () => Date
}

export interface DiscoverSummary extends DiscoverResult {
  zips: string[]
  budget: number
  requests: number
  by_source: Record<'li' | 'opa' | 'sales', DiscoverResult>
  errors: string[]
}

const ZIP5 = /^\d{5}$/

/** Leads the sources created today (in the send window's zone). */
export async function newLeadsToday(db: Db, tz: string, now: Date): Promise<number> {
  const since = startOfDayInTz(now, tz).toISOString()
  const [row] = await db
    .select({ n: count() })
    .from(leads)
    .where(and(gte(leads.created_at, since), inArray(leads.source, ['opa', 'li'])))
  return row?.n ?? 0
}

/** Run every source once and upsert what comes back. Returns counts; never throws for a source error. */
export async function discover(
  opts: DiscoverOptions = {},
  deps: DiscoverDeps = {},
): Promise<DiscoverSummary> {
  const db = deps.db ?? getDb()
  const now = deps.now ?? (() => new Date())
  const client = deps.client ?? createCartoClient()
  const settings = await getSettings(db)

  const zips = (opts.zips && opts.zips.length > 0 ? opts.zips : settings.target_zips).filter((z) =>
    ZIP5.test(z),
  )
  const empty = (): DiscoverResult => ({ created: 0, merged: 0, skipped: 0 })
  const summary: DiscoverSummary = {
    ...empty(),
    zips,
    budget: 0,
    requests: 0,
    by_source: { li: empty(), opa: empty(), sales: empty() },
    errors: [],
  }
  if (zips.length === 0) {
    summary.errors.push('No target zips set. Add some in Settings.')
    await logActivity('warn', 'discover.no_zips', summary, null, db)
    return summary
  }

  const already = await newLeadsToday(db, settings.send_window.tz, now())
  const dailyLeft = Math.max(0, settings.max_new_leads_per_day - already)
  let budget = Math.min(dailyLeft, opts.limit ?? Number.POSITIVE_INFINITY)
  summary.budget = Number.isFinite(budget) ? budget : dailyLeft

  /** `reserve` keeps that many creations for the passes after this one. */
  const upsertAll = async (
    candidates: LeadCandidate[],
    into: DiscoverResult,
    reserve = 0,
  ): Promise<void> => {
    for (const c of candidates) {
      const r = await upsertCandidate(c, {
        db,
        settings,
        now: now(),
        allowCreate: budget > reserve,
      })
      into[r.outcome]++
      summary[r.outcome]++
      if (r.outcome === 'created') budget--
    }
  }

  const minProps = Math.max(0, settings.min_props)
  const maxProps = Math.max(minProps, settings.max_props)
  const opaReserve = Number.isFinite(budget) ? budget - Math.ceil(budget * OPA_BUDGET_SHARE) : 0

  // 1. OPA owner groups (the ICP), page by page, up to their share of the cap.
  try {
    for (let page = 0; page < MAX_OWNER_PAGES; page++) {
      if (budget <= opaReserve) break
      const rows = await client.query<OpaRow>(
        buildOpaOwnersSql(
          zips,
          minProps,
          maxProps,
          OPA_OWNERS_PAGE_SIZE,
          page * OPA_OWNERS_PAGE_SIZE,
        ),
      )
      if (rows.length === 0) break
      const candidates = opaRowsToCandidates(rows, now())
      await upsertAll(candidates, summary.by_source.opa, opaReserve)
      if (candidates.length < OPA_OWNERS_PAGE_SIZE) break
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.errors.push(`Property owners: ${message}`)
    await logActivity('warn', 'discover.opa.failed', { message }, null, db)
  }

  // 2. New rental licenses in the window, with whatever budget is left.
  try {
    for (let page = 0; page < MAX_TRIGGER_PAGES; page++) {
      const rows = await client.query<LiRow>(
        buildNewLicensesSql(zips, NEW_LICENSE_WINDOW_DAYS, LI_PAGE_SIZE, page * LI_PAGE_SIZE),
      )
      await upsertAll(liRowsToCandidates(rows), summary.by_source.li)
      if (rows.length < LI_PAGE_SIZE) break
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.errors.push(`Rental licenses: ${message}`)
    await logActivity('warn', 'discover.li.failed', { message }, null, db)
  }

  // 3. Recent sales: mostly adds the trigger to owners we already have.
  try {
    for (let page = 0; page < MAX_TRIGGER_PAGES; page++) {
      const rows = await client.query<OpaRow>(
        buildRecentSalesSql(
          zips,
          RECENT_SALE_WINDOW_DAYS,
          OPA_SALES_PAGE_SIZE,
          page * OPA_SALES_PAGE_SIZE,
        ),
      )
      await upsertAll(opaRowsToCandidates(rows, now()), summary.by_source.sales)
      if (rows.length < OPA_SALES_PAGE_SIZE) break
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.errors.push(`Recent sales: ${message}`)
    await logActivity('warn', 'discover.sales.failed', { message }, null, db)
  }

  summary.requests = client.requests
  await logActivity(
    summary.errors.length > 0 ? 'warn' : 'info',
    'discover',
    {
      created: summary.created,
      merged: summary.merged,
      skipped: summary.skipped,
      zips: summary.zips,
      budget: summary.budget,
      requests: summary.requests,
      by_source: summary.by_source,
      errors: summary.errors,
    },
    null,
    db,
  )
  return summary
}
