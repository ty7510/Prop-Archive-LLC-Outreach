// POST /api/webhooks/outcome: the main app tells us a lead booked a demo or joined the beta.
// Auth is the x-outreach-secret header (settings.webhook_secret), not the cookie.
// FILLED BY: the outreach builder.
import { Router } from 'express'
import { WebhookOutcomeBodySchema } from '../../shared/types.ts'
import { asyncHandler, notFound, parseOr400, passwordMatches, unauthorized } from '../lib/http.ts'
import { getSettings } from '../lib/settings.ts'
import { outreachDeps } from '../outreach/index.ts'
import { findLeadByIdOrEmail, recordOutcome } from '../outreach/outcomes.ts'

export const webhooksRouter = Router()

// POST /api/webhooks/outcome { email?, lead_id?, kind: 'demo_booked' | 'beta_joined' } -> { ok: true, lead_id }
webhooksRouter.post(
  '/outcome',
  asyncHandler(async (req, res) => {
    const deps = outreachDeps()
    const settings = await getSettings(deps.db)
    const header = req.get('x-outreach-secret') ?? ''
    if (!settings.webhook_secret || !passwordMatches(header, settings.webhook_secret)) {
      throw unauthorized('Bad or missing x-outreach-secret header', 'BAD_SECRET')
    }
    const body = parseOr400(WebhookOutcomeBodySchema, req.body)
    const lead = await findLeadByIdOrEmail(deps, body)
    if (!lead) throw notFound('No lead matches that id or email', 'LEAD_NOT_FOUND')
    await recordOutcome(deps, lead.id, body.kind, 'webhook')
    res.json({ ok: true, lead_id: lead.id })
  }),
)

export default webhooksRouter
