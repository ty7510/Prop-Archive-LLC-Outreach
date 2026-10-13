// Activity log: one line per thing the system did, newest first on the Go page. Owned by the scaffold.
import { desc } from 'drizzle-orm'
import type { ActivityEntry, ActivityLevel } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { activityLog } from '../db/schema.ts'
import { newId } from './ids.ts'
import { nowIso } from './time.ts'

/**
 * An error in log form: its message plus the underlying cause. Drizzle wraps a Postgres failure as
 * "Failed query: ..." and keeps the real reason (connection ended, timeout, constraint) in `cause`.
 */
export function errorDetail(err: unknown): { error: string; cause?: string; code?: string } {
  if (!(err instanceof Error)) return { error: String(err) }
  const out: { error: string; cause?: string; code?: string } = { error: err.message }
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error) out.cause = cause.message
  else if (cause !== undefined && cause !== null) out.cause = String(cause)
  const code = (cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown }).code
  if (typeof code === 'string') out.code = code
  return out
}

/**
 * Write one activity line. Never throws: a logging failure must not break a job.
 * `detail` is any JSON-able value (counts, an error message, a provider name).
 */
export async function logActivity(
  level: ActivityLevel,
  event: string,
  detail?: unknown,
  leadId?: string | null,
  db: Db = getDb(),
): Promise<ActivityEntry | null> {
  const entry: ActivityEntry = {
    id: newId(),
    at: nowIso(),
    level,
    event,
    lead_id: leadId ?? null,
    detail: detail === undefined ? null : detail,
  }
  try {
    await db.insert(activityLog).values(entry)
    if (process.env.NODE_ENV !== 'test' && level !== 'info') {
      console.log(`[activity] ${level} ${event}`, detail ?? '')
    }
    return entry
  } catch (err) {
    console.error('[activity] could not write activity log', err)
    return null
  }
}

/** Newest first. */
export async function listActivity(limit = 100, db: Db = getDb()): Promise<ActivityEntry[]> {
  const rows = await db.select().from(activityLog).orderBy(desc(activityLog.at)).limit(limit)
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    level: r.level,
    event: r.event,
    lead_id: r.lead_id ?? null,
    detail: r.detail ?? null,
  }))
}
