// The scheduler: a 60 s interval that runs a tick while settings.autopilot_on is true.
// start() is called once at boot (server/index.ts) and again by POST /api/autopilot/start;
// stop() by POST /api/autopilot/stop and on shutdown. A manual tick runs even when autopilot is off.
import { desc } from 'drizzle-orm'
import type { AutopilotStatus } from '../../shared/types.ts'
import type { AutopilotModule } from '../contracts.ts'
import { getDb, type Db } from '../db/client.ts'
import { jobRuns } from '../db/schema.ts'
import { lastRuns } from '../lib/locks.ts'
import { getSettings } from '../lib/settings.ts'
import { todayCounts } from './counters.ts'
import { runTick, type TickSummary } from './tick.ts'

export const TICK_INTERVAL_MS = 60_000

export interface AutopilotOptions {
  /** Milliseconds between ticks. Default 60 s. */
  intervalMs?: number
  /** Clock, for tests. */
  now?: () => Date
  /** Database. Resolved lazily so createApp(db) can run first. */
  db?: () => Db
}

export class Autopilot implements AutopilotModule {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<TickSummary> | null = null
  private lastTickAt: string | null = null
  private nextTickAt: string | null = null
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly db: () => Db
  /** Modules already warned about as not built, one warn line each per process. */
  private readonly warned = new Set<string>()

  constructor(options: AutopilotOptions = {}) {
    this.intervalMs = options.intervalMs ?? TICK_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
    this.db = options.db ?? getDb
  }

  /** True while the interval is scheduled. */
  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.onInterval()
    }, this.intervalMs)
    // Never keep the process alive just for the timer (the http server does that).
    this.timer.unref?.()
    this.nextTickAt = new Date(this.now().getTime() + this.intervalMs).toISOString()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.nextTickAt = null
  }

  /** Scheduled tick: only while settings.autopilot_on. Never throws. */
  private async onInterval(): Promise<void> {
    this.nextTickAt = new Date(this.now().getTime() + this.intervalMs).toISOString()
    try {
      const settings = await getSettings(this.db())
      if (!settings.autopilot_on) return
      await this.runTick()
    } catch (err) {
      console.error('[autopilot] tick failed', err)
    }
  }

  /** Run one tick now (manual or scheduled). A tick already in flight is awaited instead of doubled. */
  runTick(): Promise<TickSummary> {
    if (this.inFlight) return this.inFlight
    this.lastTickAt = this.now().toISOString()
    this.inFlight = runTick({ db: this.db(), now: this.now, warned: this.warned }).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  async tick(): Promise<void> {
    await this.runTick()
  }

  async status(): Promise<AutopilotStatus> {
    const db = this.db()
    const settings = await getSettings(db)
    const [today, jobs, lastTick] = await Promise.all([
      todayCounts(settings.send_window.tz, this.now(), db),
      lastRuns(db),
      this.lastTickAt ? Promise.resolve(this.lastTickAt) : newestRunStart(db),
    ])
    return {
      on: settings.autopilot_on,
      liveMode: settings.live_mode,
      lastTick,
      nextTick: settings.autopilot_on && this.timer ? this.nextTickAt : null,
      today,
      jobs,
    }
  }
}

/** After a restart the in-memory lastTick is gone; the newest job_runs row is the next best answer. */
async function newestRunStart(db: Db): Promise<string | null> {
  const rows = await db
    .select({ started_at: jobRuns.started_at })
    .from(jobRuns)
    .orderBy(desc(jobRuns.started_at))
    .limit(1)
  return rows[0]?.started_at ?? null
}
