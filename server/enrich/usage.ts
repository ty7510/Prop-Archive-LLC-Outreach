// Monthly credit caps: count provider_usage rows for this calendar month (settings.send_window.tz).
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { EnrichProviderId, MonthlyCreditCap, Settings } from '../../shared/settings.ts'
import { ENRICH_PROVIDER_IDS } from '../../shared/settings.ts'
import { getDb, type Db } from '../db/client.ts'
import { providerUsage } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { monthKeyInTz, zonedParts, zonedTimeToUtc } from '../lib/time.ts'

export interface MonthRange {
  key: string
  startIso: string
  endIso: string
}

/** The UTC bounds of the calendar month that contains `now` in `tz`. */
export function monthRange(now: Date, tz: string): MonthRange {
  const p = zonedParts(now, tz)
  const start = zonedTimeToUtc(tz, p.year, p.month, 1)
  const next =
    p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 }
  const end = zonedTimeToUtc(tz, next.year, next.month, 1)
  return { key: monthKeyInTz(now, tz), startIso: start.toISOString(), endIso: end.toISOString() }
}

export interface ProviderUsageSummary {
  provider: EnrichProviderId
  /** Credits consumed this month. */
  used: number
  /** Calls made this month (free providers show up here with used 0). */
  calls: number
  /** null for providers without a cap (li_license). */
  cap: number | null
}

export function capFor(caps: MonthlyCreditCap, provider: EnrichProviderId): number | null {
  if (provider in caps) return caps[provider as keyof MonthlyCreditCap]
  return null
}

export async function creditsUsed(
  provider: EnrichProviderId,
  range: MonthRange,
  db: Db = getDb(),
): Promise<{ used: number; calls: number }> {
  const rows = await db
    .select({
      used: sql<number>`coalesce(sum(${providerUsage.credits}), 0)`,
      calls: sql<number>`count(*)`,
    })
    .from(providerUsage)
    .where(
      and(
        eq(providerUsage.provider, provider),
        gte(providerUsage.at, range.startIso),
        lt(providerUsage.at, range.endIso),
      ),
    )
  const row = rows[0]
  return { used: Number(row?.used ?? 0), calls: Number(row?.calls ?? 0) }
}

/** True when one more call of `cost` credits would go over the cap. No cap means never. */
export function wouldExceedCap(used: number, cost: number, cap: number | null): boolean {
  if (cap === null) return false
  return used + cost > cap
}

export async function recordUsage(
  provider: EnrichProviderId,
  credits: number,
  leadId: string | null,
  at: Date,
  db: Db = getDb(),
): Promise<void> {
  await db.insert(providerUsage).values({
    id: newId(),
    provider,
    lead_id: leadId,
    credits: Math.max(0, Math.round(credits)),
    at: at.toISOString(),
  })
}

export interface UsageReport {
  month: string
  tz: string
  providers: ProviderUsageSummary[]
}

export async function usageReport(
  settings: Settings,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<UsageReport> {
  const tz = settings.send_window.tz
  const range = monthRange(now, tz)
  const providers: ProviderUsageSummary[] = []
  for (const provider of ENRICH_PROVIDER_IDS) {
    const { used, calls } = await creditsUsed(provider, range, db)
    providers.push({
      provider,
      used,
      calls,
      cap: capFor(settings.enrichment.monthly_credit_cap, provider),
    })
  }
  return { month: range.key, tz, providers }
}
