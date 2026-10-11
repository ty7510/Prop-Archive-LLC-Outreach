// Lead sources: OPA owners, L&I rental licenses, recent sales, CSV import, scoring, dedupe.
// Spec sections 5 and 8. Owned by the sources builder.
// Importing this file registers the 'sources' module so routes and autopilot can use it.
import { registerModule, type SourcesModule } from '../contracts.ts'
import { discover } from './discover.ts'
import { importCsv } from './import.ts'

export const sourcesModule: SourcesModule = {
  async discover(opts) {
    const s = await discover(opts)
    return { created: s.created, merged: s.merged, skipped: s.skipped }
  },
  importCsv(buffer, filename) {
    return importCsv(buffer, filename)
  },
}

registerModule('sources', sourcesModule)

export { discover } from './discover.ts'
export { importCsv } from './import.ts'
export { previewOpaOwners } from './opa.ts'
export { personaFor, scoreLead } from './score.ts'
export { neighborhoodFor, neighborhoodForLead } from './neighborhoods.ts'
export { displayNameFor } from './merge.ts'
