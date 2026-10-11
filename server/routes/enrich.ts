// Enrichment API. Mounted at /api/leads next to leads.ts. STUB: 501 NOT_BUILT.
// FILLED BY: the enrich builder.
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const enrichRouter = Router()

// POST /api/leads/enrich { ids?: string[], all?: boolean } -> EnrichResult
enrichRouter.post('/enrich', () => {
  throw notBuilt()
})

export default enrichRouter
