// createApp(db): the Express app with every router mounted. Owned by the scaffold.
// Order matters: json body -> cookie session -> public routes -> open api routes -> requireAuth -> api.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookieSession from 'cookie-session'
import express, { type Express } from 'express'
import { setDefaultDb, type Db } from './db/client.ts'
import { env, isProduction } from './env.ts'
import { apiError, errorHandler, requireAuth } from './lib/http.ts'
import { activityRouter } from './routes/activity.ts'
import { authRouter } from './routes/auth.ts'
import { autopilotRouter } from './routes/autopilot.ts'
import { enrichRouter, enrichUsageRouter } from './routes/enrich.ts'
import { healthRouter } from './routes/health.ts'
import { leadsRouter } from './routes/leads.ts'
import { publicRouter } from './routes/public.ts'
import { queueRouter } from './routes/queue.ts'
import { leadOutreachRouter, sequencesRouter } from './routes/sequences.ts'
import { settingsRouter } from './routes/settings.ts'
import { webhooksRouter } from './routes/webhooks.ts'

export interface CreateAppOptions {
  /** Serve dist/client and the SPA fallback. Defaults to NODE_ENV === 'production'. */
  serveClient?: boolean
  /** Folder with the built client. Defaults to <cwd>/dist/client. */
  clientDir?: string
}

export function createApp(db: Db, options: CreateAppOptions = {}): Express {
  setDefaultDb(db)

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: false }))
  app.use(
    cookieSession({
      name: 'outreach.sid',
      keys: [env.SESSION_SECRET],
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      // Production runs behind Replit's TLS proxy; trust proxy is on, so X-Forwarded-Proto counts
      // as https and the cookie is marked Secure. Local dev is plain http, so it is not.
      secure: isProduction,
    }),
  )

  // Public, no auth: unsubscribe and tracked redirects (used from emails).
  app.use(publicRouter)

  // Open API routes.
  app.use('/api/health', healthRouter)
  app.use('/api', authRouter) // /api/login, /api/logout, /api/me
  app.use('/api/webhooks', webhooksRouter) // secret header, checked inside

  // Everything else under /api needs the cookie.
  app.use('/api', requireAuth)
  app.use('/api/settings', settingsRouter)
  app.use('/api/leads', enrichRouter) // POST /api/leads/enrich
  app.use('/api/enrich', enrichUsageRouter) // GET /api/enrich/usage
  app.use('/api/leads', leadOutreachRouter) // POST /api/leads/:id/enroll | stop | outcome
  app.use('/api/leads', leadsRouter)
  app.use('/api/sequences', sequencesRouter)
  app.use('/api/queue', queueRouter)
  app.use('/api/autopilot', autopilotRouter)
  app.use('/api/activity', activityRouter)

  app.use('/api', (_req, res) => apiError(res, 404, 'Not found', 'NOT_FOUND'))

  const serveClient = options.serveClient ?? isProduction
  if (serveClient) {
    const clientDir = options.clientDir ?? resolve(process.cwd(), 'dist/client')
    const indexHtml = resolve(clientDir, 'index.html')
    if (existsSync(indexHtml)) {
      app.use(express.static(clientDir, { index: false, maxAge: '1h' }))
      app.get(/^(?!\/api\/|\/u\/|\/r\/).*/, (_req, res) => {
        res.sendFile(indexHtml)
      })
    } else {
      app.get('/', (_req, res) => {
        res
          .status(503)
          .type('text/plain')
          .send('Client not built. Run: npm run build (or npm run dev for development).')
      })
    }
  }

  app.use(errorHandler)
  return app
}
