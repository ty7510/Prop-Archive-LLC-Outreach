// Today's numbers for the Go page, computed from the tables every time (nothing stored).
// "Today" is the calendar day in settings.send_window.tz, so the tiles roll over at local midnight.
import { and, count, eq, gte, inArray, lt } from 'drizzle-orm'
import type { LeadStatus, TodayCounts } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { enrollments, events, leads, messages } from '../db/schema.ts'
import { zonedParts, zonedTimeToUtc } from '../lib/time.ts'

export interface DayRange {
  /** ISO instant where the local day starts (inclusive). */
  start: string
  /** ISO instant where the next local day starts (exclusive). */
  end: string
}

/** The UTC bounds of the local calendar day that contains `now`. DST-safe (a day can be 23 or 25 hours). */
export function dayRangeInTz(now: Date, tz: string): DayRange {
  const p = zonedParts(now, tz)
  const start = zonedTimeToUtc(tz, p.year, p.month, p.day)
  // Date.UTC rolls day + 1 over month and year ends for us.
  const end = zonedTimeToUtc(tz, p.year, p.month, p.day + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** Lead statuses that mean "enrichment is behind us". */
export const ENRICHED_OR_LATER: LeadStatus[] = [
  'enriched',
  'enrolled',
  'contacted',
  'replied',
  'booked',
  'joined',
]

/**
 * Count what happened today.
 * - discovered: leads created today (any source)
 * - enriched: leads at status enriched or later whose row was last touched today
 * - enrolled: enrollments started today
 * - sent: outbound messages with status sent and a sent_at today (dry runs do not count as sent)
 * - queued: ready_for_human messages created today (what is waiting for Theo)
 * - replied: inbound messages created today
 * - booked / joined: demo_booked / beta_joined events today
 */
export async function todayCounts(
  tz: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<TodayCounts> {
  const { start, end } = dayRangeInTz(now, tz)
  const n = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]?.n ?? 0

  const [discovered, enriched, enrolled, sent, queued, replied, booked, joined] = await Promise.all(
    [
      n(
        db
          .select({ n: count() })
          .from(leads)
          .where(and(gte(leads.created_at, start), lt(leads.created_at, end))),
      ),
      n(
        db
          .select({ n: count() })
          .from(leads)
          .where(
            and(
              inArray(leads.status, ENRICHED_OR_LATER),
              gte(leads.updated_at, start),
              lt(leads.updated_at, end),
            ),
          ),
      ),
      n(
        db
          .select({ n: count() })
          .from(enrollments)
          .where(and(gte(enrollments.started_at, start), lt(enrollments.started_at, end))),
      ),
      n(
        db
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.direction, 'out'),
              eq(messages.status, 'sent'),
              gte(messages.sent_at, start),
              lt(messages.sent_at, end),
            ),
          ),
      ),
      n(
        db
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.status, 'ready_for_human'),
              gte(messages.created_at, start),
              lt(messages.created_at, end),
            ),
          ),
      ),
      n(
        db
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.direction, 'in'),
              gte(messages.created_at, start),
              lt(messages.created_at, end),
            ),
          ),
      ),
      n(
        db
          .select({ n: count() })
          .from(events)
          .where(and(eq(events.kind, 'demo_booked'), gte(events.at, start), lt(events.at, end))),
      ),
      n(
        db
          .select({ n: count() })
          .from(events)
          .where(and(eq(events.kind, 'beta_joined'), gte(events.at, start), lt(events.at, end))),
      ),
    ],
  )

  return { discovered, enriched, enrolled, sent, queued, replied, booked, joined }
}
