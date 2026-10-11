// Leads API (spec section 6). STUB: every route answers 501 NOT_BUILT.
// FILLED BY: the sources builder (list, get, patch, import, discover) with the outreach builder
// adding enroll / stop / outcome. Keep the paths exactly as listed; the UI is built against them.
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const leadsRouter = Router()

const stub = () => {
  throw notBuilt()
}

// GET /api/leads?status=&persona=&q=&page=&limit=  -> Paged<Lead>
leadsRouter.get('/', stub)
// POST /api/leads/import (multipart CSV, field "file") -> ImportResult
leadsRouter.post('/import', stub)
// POST /api/leads/discover { zips?, limit? } -> DiscoverResult
leadsRouter.post('/discover', stub)
// GET /api/leads/:id -> lead with properties, enrollments, messages, events
leadsRouter.get('/:id', stub)
// PATCH /api/leads/:id (LeadPatch) -> Lead
leadsRouter.patch('/:id', stub)
// POST /api/leads/:id/enroll { sequence_id } -> { ok: true }
leadsRouter.post('/:id/enroll', stub)
// POST /api/leads/:id/stop { reason? } -> { ok: true }
leadsRouter.post('/:id/stop', stub)
// POST /api/leads/:id/outcome { kind } -> Lead
leadsRouter.post('/:id/outcome', stub)

export default leadsRouter
