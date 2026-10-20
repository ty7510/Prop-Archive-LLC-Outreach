// One tick: the six jobs in spec order, each under a job_runs lock, each calling the registered
// module through requireModule. A missing module is a skipped job with one warn line, never a crash.
// An error in one job is recorded and the tick moves on to the next job.
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ModuleNotRegisteredError, requireModule, type modules } from '../contracts.ts'
import { getDb, type Db } from '../db/client.ts'
import type { JobStatus } from '../../shared/types.ts'
import { jobRuns } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { expireStaleLocks, withJobLock } from '../lib/locks.ts'
import { isWithinSendWindow } from '../lib/sendWindow.ts'
import { getSettings } from '../lib/settings.ts'
import { dayRangeInTz, todayCounts } from './counters.ts'

export const JOB_ORDER = [
  'discover',
  'enrich',
  'enroll',
  'send',
  'todo',
  'sync_replies',
  'housekeeping',
] as const
export type JobName = (typeof JOB_ORDER)[number]

export const ENRICH_BATCH = 10
/** Stored research answers checked again per tick when the contact checks improve. */
const RECHECK_BATCH = 10
export const SYNC_REPLIES_EVERY_MS = 10 * 60_000
export const HOUSEKEEPING_EVERY_MS = 60 * 60_000

export type JobOutcomeStatus =
  | 'ok'
  | 'error'
  /** another run of this job holds the lock */
  | 'skipped'
  /** the module this job needs is not registered */
  | 'not_built'
  /** the job ran recently enough (discover daily, sync_replies 10 min, housekeeping hourly) */
  | 'not_due'
  /** send only: outside the send window */
  | 'outside_window'
  /** enrich only: the batch was started in the background and the tick went on */
  | 'started'

export interface JobOutcome {
  job: JobName
  status: JobOutcomeStatus
  summary?: unknown
  error?: string
  ms: number
}

export interface TickSummary {
  started_at: string
  finished_at: string
  jobs: JobOutcome[]
}

export interface TickOptions {
  db?: Db
  now?: () => Date
  /** Modules already warned about in this process, so the activity log gets one line, not one a minute. */
  warned?: Set<string>
  /**
   * Run the enrich batch in the background instead of waiting for it. A batch of web research takes
   * minutes; waiting held up the to-do list, so nobody new came on until it finished.
   */
  enrichInBackground?: boolean
}

/** The enrich batch running in the background in this process, so a second one never starts. */
let backgroundEnrich: Promise<JobOutcome> | null = null

const warnedByDefault = new Set<string>()

/** Newest job_runs.started_at for a job (any status unless `statuses` narrows it). null when it never ran. */
export async function lastStartedAt(
  job: JobName,
  db: Db,
  statuses?: readonly JobStatus[],
): Promise<string | null> {
  const rows = await db
    .select({ started_at: jobRuns.started_at })
    .from(jobRuns)
    .where(
      statuses
        ? and(eq(jobRuns.job, job), inArray(jobRuns.status, [...statuses]))
        : eq(jobRuns.job, job),
    )
    .orderBy(desc(jobRuns.started_at))
    .limit(1)
  return rows[0]?.started_at ?? null
}

async function ranSince(
  job: JobName,
  cutoffIso: string,
  db: Db,
  statuses?: readonly JobStatus[],
): Promise<boolean> {
  const last = await lastStartedAt(job, db, statuses)
  return last !== null && last >= cutoffIso
}

/** A run that finished fine, or is still going, counts as "done today". An error does not. */
const COUNTS_AS_RAN: readonly JobStatus[] = ['ok', 'running']

type ModuleName = keyof typeof modules

/** The registered module, or null after one warn line (per module, per process). */
async function resolveModule<K extends ModuleName>(
  name: K,
  job: JobName,
  db: Db,
  warned: Set<string>,
): Promise<NonNullable<(typeof modules)[K]> | null> {
  try {
    return requireModule(name)
  } catch (err) {
    if (!(err instanceof ModuleNotRegisteredError)) throw err
    if (!warned.has(name)) {
      warned.add(name)
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[autopilot] ${job}: ${name} module is not built yet, skipping`)
      }
      await logActivity(
        'warn',
        job,
        { skipped: 'not built', module: name, note: `${name} module is not built yet` },
        null,
        db,
      )
    }
    return null
  }
}

async function runJob(
  job: JobName,
  fn: () => Promise<unknown>,
  db: Db,
  now: () => Date,
): Promise<JobOutcome> {
  const t0 = Date.now()
  try {
    const r = await withJobLock(job, fn, db, now)
    if (r.skipped) {
      return { job, status: 'skipped', ms: Date.now() - t0 }
    }
    await logActivity('info', job, r.result, null, db)
    return { job, status: 'ok', summary: r.result, ms: Date.now() - t0 }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logActivity('error', job, { error: message }, null, db)
    return { job, status: 'error', error: message, ms: Date.now() - t0 }
  }
}

const notDue = (job: JobName): JobOutcome => ({ job, status: 'not_due', ms: 0 })
const notBuilt = (job: JobName): JobOutcome => ({ job, status: 'not_built', ms: 0 })

/** Run every job once, in order. Never throws. */
export async function runTick(options: TickOptions = {}): Promise<TickSummary> {
  const db = options.db ?? getDb()
  const now = options.now ?? (() => new Date())
  const warned = options.warned ?? warnedByDefault
  const startedAt = now()
  const settings = await getSettings(db)
  const tz = settings.send_window.tz
  const jobs: JobOutcome[] = []

  // 1. discover: once per local day.
  {
    const today = dayRangeInTz(startedAt, tz)
    if (await ranSince('discover', today.start, db, COUNTS_AS_RAN)) {
      jobs.push(notDue('discover'))
    } else {
      const sources = await resolveModule('sources', 'discover', db, warned)
      if (!sources) jobs.push(notBuilt('discover'))
      else {
        jobs.push(
          await runJob(
            'discover',
            () => sources.discover({ limit: settings.max_new_leads_per_day }),
            db,
            now,
          ),
        )
      }
    }
  }

  // 2. enrich: every tick, a batch of 10.
  {
    const enrich = await resolveModule('enrich', 'enrich', db, warned)
    if (!enrich) jobs.push(notBuilt('enrich'))
    else {
      const batch = () =>
        runJob(
          'enrich',
          async () => {
            const ids = await enrich.pickBatch(ENRICH_BATCH)
            const r =
              ids.length === 0
                ? { enriched: 0, failed: 0, skipped: 0 }
                : await enrich.enrichLeads(ids)
            // Stored answers checked by older contact checks get checked again (no research call).
            const re = enrich.recheckStored ? await enrich.recheckStored(RECHECK_BATCH) : null
            return {
              picked: ids.length,
              ...r,
              ...(re && re.checked > 0
                ? { rechecked: re.checked, recheck_improved: re.improved }
                : {}),
            }
          },
          db,
          now,
        )
      if (!options.enrichInBackground) jobs.push(await batch())
      else if (backgroundEnrich) jobs.push({ job: 'enrich', status: 'skipped', ms: 0 })
      else {
        // runJob never throws: it logs the error and returns it.
        backgroundEnrich = batch().finally(() => {
          backgroundEnrich = null
        })
        jobs.push({ job: 'enrich', status: 'started', ms: 0 })
      }
    }
  }

  // 3. enroll: every tick.
  const outreach = await resolveModule('outreach', 'enroll', db, warned)
  if (!outreach) jobs.push(notBuilt('enroll'))
  else jobs.push(await runJob('enroll', () => outreach.enrollEligible(), db, now))

  // 4. send: every tick, inside the send window only.
  if (!outreach) jobs.push(notBuilt('send'))
  else if (!isWithinSendWindow(settings, now())) {
    jobs.push({ job: 'send', status: 'outside_window', ms: 0 })
  } else jobs.push(await runJob('send', () => outreach.sendDue(), db, now))

  // 4b. todo: every tick, any hour of a send day: put today's people on the to-do list.
  if (!outreach) jobs.push(notBuilt('todo'))
  else jobs.push(await runJob('todo', () => outreach.fillTodo(), db, now))

  // 5. sync_replies: every 10 minutes.
  {
    const cutoff = new Date(now().getTime() - SYNC_REPLIES_EVERY_MS).toISOString()
    if (await ranSince('sync_replies', cutoff, db)) jobs.push(notDue('sync_replies'))
    else if (!outreach) jobs.push(notBuilt('sync_replies'))
    else jobs.push(await runJob('sync_replies', () => outreach.syncReplies(), db, now))
  }

  // 6. housekeeping: hourly. Expire stale locks and write today's numbers to the log.
  {
    const cutoff = new Date(now().getTime() - HOUSEKEEPING_EVERY_MS).toISOString()
    if (await ranSince('housekeeping', cutoff, db)) jobs.push(notDue('housekeeping'))
    else {
      jobs.push(
        await runJob(
          'housekeeping',
          async () => {
            const expired_locks = await expireStaleLocks(db, now)
            const today = await todayCounts(tz, now(), db)
            return { expired_locks, today }
          },
          db,
          now,
        ),
      )
    }
  }

  return { started_at: startedAt.toISOString(), finished_at: now().toISOString(), jobs }
}
