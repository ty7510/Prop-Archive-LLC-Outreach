// Autopilot: the 60 s tick, jobs in order (discover, enrich, enroll, send, sync_replies, housekeeping),
// locks via lib/locks.ts, today's counters, status for the Go page.
// FILLED BY: the autopilot builder. Spec section 11.
// When done, call registerModule('autopilot', impl) here:
//   import { registerModule } from '../contracts.ts'
//   registerModule('autopilot', { start, stop, tick, status })
// server/index.ts calls modules.autopilot?.start() after boot when it is registered.
// This file registers nothing yet. Importing it is safe.
export {}
