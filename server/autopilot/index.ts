// Autopilot: the 60 s tick, jobs in order (discover, enrich, enroll, send, sync_replies, housekeeping),
// locks via lib/locks.ts, today's counters, status for the Go page. Spec section 11.
// Importing this file registers the module; server/index.ts calls modules.autopilot.start() after boot.
import { registerModule } from '../contracts.ts'
import { Autopilot } from './autopilot.ts'

export const autopilot = new Autopilot()

registerModule('autopilot', autopilot)

export { Autopilot, TICK_INTERVAL_MS } from './autopilot.ts'
export { dayRangeInTz, todayCounts } from './counters.ts'
export { JOB_ORDER, runTick } from './tick.ts'
export type { JobName, JobOutcome, JobOutcomeStatus, TickSummary } from './tick.ts'
