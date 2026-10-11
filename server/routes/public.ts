// Public routes used from emails: one-click unsubscribe and tracked redirects. No auth. STUB: 501.
// FILLED BY: the outreach builder. Mounted at the app root (paths are /u/... and /r/...).
import { Router } from 'express'
import { notBuilt } from '../lib/http.ts'

export const publicRouter = Router()

const stub = () => {
  throw notBuilt()
}

// GET /u/:token -> small HTML page confirming "You will not get more email from us"
publicRouter.get('/u/:token', stub)
// POST /u/:token -> same, for List-Unsubscribe-Post one click
publicRouter.post('/u/:token', stub)
// GET /r/:token/:dest (dest = demo | beta | site) -> 302 with utm params, records a click event
publicRouter.get('/r/:token/:dest', stub)

export default publicRouter
