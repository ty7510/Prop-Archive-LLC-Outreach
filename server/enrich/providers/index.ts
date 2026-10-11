// The default provider set, in a map by id. The orchestrator orders them by settings.
import type { EnrichProviderId } from '../../../shared/settings.ts'
import type { HttpDeps } from '../http.ts'
import type { EnrichProvider } from '../types.ts'
import { createApolloProvider } from './apollo.ts'
import { createClaudeResearchProvider, type ClaudeResearchDeps } from './claudeResearch.ts'
import { createHunterProvider } from './hunter.ts'
import { createLiLicenseProvider } from './liLicense.ts'
import { createPdlProvider } from './pdl.ts'

export interface ProviderDeps {
  http?: HttpDeps
  claude?: ClaudeResearchDeps
}

export function createProviders(deps: ProviderDeps = {}): Record<EnrichProviderId, EnrichProvider> {
  return {
    li_license: createLiLicenseProvider(deps.http),
    claude_research: createClaudeResearchProvider(deps.claude),
    hunter: createHunterProvider(deps.http),
    apollo: createApolloProvider(deps.http),
    pdl: createPdlProvider(deps.http),
  }
}

export {
  createApolloProvider,
  createClaudeResearchProvider,
  createHunterProvider,
  createLiLicenseProvider,
  createPdlProvider,
}
