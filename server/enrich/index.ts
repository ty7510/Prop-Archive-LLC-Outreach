// Enrichment: providers (li_license, claude_research, hunter, apollo, pdl), orchestrator, credit caps.
// Spec section 9. Registers the EnrichModule the routes and autopilot call through requireModule.
import { registerModule } from '../contracts.ts'
import { enrichLeads, pickBatch, researchPause } from './orchestrator.ts'
import { recheckStored } from './recheck.ts'

registerModule('enrich', {
  pickBatch: (limit) => pickBatch(limit),
  enrichLeads: (ids) => enrichLeads(ids),
  researchPause: () => researchPause(),
  recheckStored: (limit) => recheckStored(limit),
})

export { enrichLeads, pickBatch, researchPause } from './orchestrator.ts'
export { recheckStored } from './recheck.ts'
export { usageReport } from './usage.ts'
export { computeChannels, hasEnoughContact } from './channels.ts'
export type { EnrichProvider, EnrichContext, ProviderResult, LeadContactFields } from './types.ts'
