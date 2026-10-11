// Fake sources / enrich / outreach modules for autopilot tests. Imported by *.test.ts only.
import { registerModule } from '../contracts.ts'

export interface FakeOptions {
  /** Ids pickBatch returns. Default two ids. */
  batch?: string[]
  /** Make discover throw with this message. */
  discoverError?: string
}

/** Register fakes that append their name to `calls` and return fixed counts. */
export function registerFakes(calls: string[], options: FakeOptions = {}): void {
  registerModule('sources', {
    discover: async () => {
      calls.push('discover')
      if (options.discoverError) throw new Error(options.discoverError)
      return { created: 2, merged: 1, skipped: 0 }
    },
    importCsv: async () => {
      throw new Error('not used in autopilot tests')
    },
  })
  registerModule('enrich', {
    pickBatch: async (limit) => {
      calls.push(`pickBatch:${limit}`)
      return options.batch ?? ['lead-a', 'lead-b']
    },
    enrichLeads: async (ids) => {
      calls.push('enrichLeads')
      return { enriched: ids.length, failed: 0, skipped: 0 }
    },
  })
  registerModule('outreach', {
    enrollEligible: async () => {
      calls.push('enroll')
      return { enrolled: 3 }
    },
    enrollLead: async () => {},
    stopLead: async () => {},
    sendDue: async () => {
      calls.push('send')
      return { sent: 0, dryRun: 4, queued: 2, skipped: 0 }
    },
    syncReplies: async () => {
      calls.push('sync_replies')
      return { received: 1 }
    },
    renderStep: async () => ({ body: '' }),
  })
}

/** Tuesday 2026-10-13 10:00 in New York (14:00Z): inside the default send window. */
export const INSIDE_WINDOW = new Date('2026-10-13T14:00:00.000Z')
/** Sunday 2026-10-11 10:00 in New York: a weekend, outside the default window. */
export const OUTSIDE_WINDOW = new Date('2026-10-11T14:00:00.000Z')

/** A clock that tests can move. */
export function clock(start: Date) {
  let current = start
  return {
    now: () => current,
    set: (d: Date) => {
      current = d
    },
    advanceMinutes: (m: number) => {
      current = new Date(current.getTime() + m * 60_000)
    },
  }
}
