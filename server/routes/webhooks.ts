// POST /api/webhooks/outcome: the main app tells us a lead booked a demo or joined the beta.
// Auth is the x-outreach-secret header (settings.webhook_secret), not the cookie. STUB: 501.
// FILLED BY: the outreach builder.
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const webhooksRouter = Router()

// POST /api/webhooks/outcome { email?, lead_id?, kind: 'demo_booked' | 'beta_joined' } -> { ok: true }
webhooksRouter.post('/outcome', () => {
  throw notBuilt()
})

export default webhooksRouter
