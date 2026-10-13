// Is Claude web research still owed to this lead? Research is what finds emails and profiles, so a
// lead is not put into the sequence, and an email or profile step is not skipped for good, while
// that answer is pending. Kept apart from the orchestrator so outreach can ask without loading
// the providers.
import type { Settings } from '../../shared/settings.ts'
import type { Lead } from '../db/schema.ts'
import type { Env } from '../env.ts'
import { hasEnoughContact } from './channels.ts'

export function researchConfigured(settings: Settings, env: Env): boolean {
  return settings.enrichment.providers.includes('claude_research') && Boolean(env.ANTHROPIC_API_KEY)
}

/** Research applies to anyone with a name or a company, the same test the provider makes. */
export function researchApplies(lead: Pick<Lead, 'full_name' | 'company'>): boolean {
  return Boolean(lead.full_name?.trim() || lead.company?.trim())
}

/** Research has not had its turn on this lead yet, and there is still something to find. */
export function researchOwed(lead: Lead): boolean {
  if (!researchApplies(lead)) return false
  if (hasEnoughContact(lead)) return false
  return !(lead.enrichment ?? {}).claude_research
}

/** True while the lead should wait for research before anything else happens to it. */
export function awaitsResearch(lead: Lead, settings: Settings, env: Env): boolean {
  return researchConfigured(settings, env) && researchOwed(lead)
}
