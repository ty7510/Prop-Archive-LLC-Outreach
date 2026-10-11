// Job locks on the job_runs table: a job is skipped while a `running` row younger than 10 minutes
// exists. One process, one tick at a time, so a row check is enough. Owned by the scaffold.
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import type { JobRunSummary } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { jobRuns } from '../db/schema.ts'
import { newId } from './ids.ts'
import { nowIso } from './time.ts'

export const LOCK_TTL_MS = 10 * 60_000

export type JobLockResult<T> =
  { skipped: true; reason: 'running' } | { skipped: false; result: T; runId: string }

/**
 * Run `fn` under a job lock. Writes a job_runs row (running -> ok | error).
 * Skips (without running) when a `running` row for this job is younger than 10 minutes.
 * Errors from `fn` are recorded on the row and rethrown.
 */
export async function withJobLock<T>(
  job: string,
  fn: () => Promise<T>,
  db: Db = getDb(),
  now: () => Date = () => new Date(),
): Promise<JobLockResult<T>> {
  const startedAt = now()
  const youngest = new Date(startedAt.getTime() - LOCK_TTL_MS).toISOString()
  const running = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(
      and(eq(jobRuns.job, job), eq(jobRuns.status, 'running'), gt(jobRuns.started_at, youngest)),
    )
    .limit(1)
  if (running.length > 0) return { skipped: true, reason: 'running' }

  const runId = newId()
  await db.insert(jobRuns).values({
    id: runId,
    job,
    started_at: startedAt.toISOString(),
    status: 'running',
  })

  try {
    const result = await fn()
    await db
      .update(jobRuns)
      .set({
        status: 'ok',
        finished_at: now().toISOString(),
        summary: result === undefined ? null : (result as unknown),
      })
      .where(eq(jobRuns.id, runId))
    return { skipped: false, result, runId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .update(jobRuns)
      .set({ status: 'error', finished_at: now().toISOString(), error: message })
      .where(eq(jobRuns.id, runId))
    throw err
  }
}

/** Mark `running` rows older than the TTL as errors. Housekeeping calls this hourly. Returns how many. */
export async function expireStaleLocks(
  db: Db = getDb(),
  now: () => Date = () => new Date(),
): Promise<number> {
  const cutoff = new Date(now().getTime() - LOCK_TTL_MS).toISOString()
  const stale = await db
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.status, 'running'), lt(jobRuns.started_at, cutoff)))
  if (stale.length === 0) return 0
  await db
    .update(jobRuns)
    .set({ status: 'error', finished_at: nowIso(), error: 'expired: lock older than 10 minutes' })
    .where(
      inArray(
        jobRuns.id,
        stale.map((s) => s.id),
      ),
    )
  return stale.length
}

/** The most recent run per job name, for the autopilot status. */
export async function lastRuns(db: Db = getDb()): Promise<Record<string, JobRunSummary>> {
  const rows = await db.select().from(jobRuns).orderBy(desc(jobRuns.started_at)).limit(200)
  const out: Record<string, JobRunSummary> = {}
  for (const r of rows) {
    if (out[r.job]) continue
    out[r.job] = {
      job: r.job,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at ?? null,
      summary: r.summary ?? null,
      error: r.error ?? null,
    }
  }
  return out
}
