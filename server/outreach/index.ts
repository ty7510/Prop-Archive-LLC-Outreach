// Outreach: templates, rendering, sequences, email and mail senders, human queue, replies.
// Spec section 10. Registers the OutreachModule with the production deps bag.
import { registerModule, type OutreachModule } from '../contracts.ts'
import { getDb } from '../db/client.ts'
import { defaultDeps, type OutreachDeps } from './deps.ts'
import { enrollEligible, enrollLead, stopLead } from './enroll.ts'
import { syncReplies } from './replies.ts'
import { sendDue } from './send.ts'
import { renderStep } from './sequences.ts'

/** Build an OutreachModule over a deps bag. Tests pass testDeps(db, fakes). */
export function createOutreach(deps: OutreachDeps): OutreachModule {
  return {
    enrollEligible: () => enrollEligible(deps),
    enrollLead: async (leadId, sequenceId) => {
      await enrollLead(deps, leadId, sequenceId)
    },
    stopLead: async (leadId, reason) => {
      await stopLead(deps, leadId, reason)
    },
    sendDue: () => sendDue(deps),
    syncReplies: () => syncReplies(deps),
    renderStep: (stepId, leadId) => renderStep(deps, stepId, leadId),
  }
}

let current: OutreachDeps | null = null
let fallback: OutreachDeps | null = null

/**
 * The deps the routes use. Lazy so the app database (set by createApp) is the one we talk to, and
 * rebuilt when that database changes (tests make a fresh in-memory db per test; production has one).
 * Tests call setOutreachDeps(testDeps(db, ...)) to swap in fakes.
 */
export function outreachDeps(): OutreachDeps {
  if (current) return current
  const db = getDb()
  if (!fallback || fallback.db !== db) fallback = defaultDeps(db)
  return fallback
}

export function setOutreachDeps(deps: OutreachDeps | null): void {
  current = deps
}

registerModule('outreach', {
  enrollEligible: () => createOutreach(outreachDeps()).enrollEligible(),
  enrollLead: (leadId, sequenceId) => createOutreach(outreachDeps()).enrollLead(leadId, sequenceId),
  stopLead: (leadId, reason) => createOutreach(outreachDeps()).stopLead(leadId, reason),
  sendDue: () => createOutreach(outreachDeps()).sendDue(),
  syncReplies: () => createOutreach(outreachDeps()).syncReplies(),
  renderStep: (stepId, leadId) => createOutreach(outreachDeps()).renderStep(stepId, leadId),
})

export { defaultDeps, testDeps } from './deps.ts'
export type { OutreachDeps } from './deps.ts'
