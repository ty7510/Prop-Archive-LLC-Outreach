// Auth: one shared password (APP_PASSWORD), cookie session. Owned by the scaffold.
import { Router } from 'express'
import { LoginBodySchema, type Me } from '../../shared/types.ts'
import { env } from '../env.ts'
import {
  HttpError,
  asyncHandler,
  clientKey,
  isLoggedIn,
  loginLimiter,
  parseOr400,
  passwordMatches,
  tooManyTries,
} from '../lib/http.ts'
import { nowIso } from '../lib/time.ts'

export const authRouter = Router()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (!env.APP_PASSWORD) {
      throw new HttpError(
        503,
        'Add APP_PASSWORD in Replit Secrets (or .env when running locally), then restart',
        'NO_PASSWORD',
      )
    }
    const { password } = parseOr400(LoginBodySchema, req.body)
    const key = clientKey(req)
    if (!loginLimiter.allowed(key)) {
      throw tooManyTries()
    }
    if (!passwordMatches(password)) {
      loginLimiter.recordFailure(key)
      throw new HttpError(401, 'Wrong password', 'WRONG_PASSWORD')
    }
    loginLimiter.reset(key)
    req.session = { loggedIn: true, loggedInAt: nowIso() }
    const me: Me = { loggedIn: true }
    res.json(me)
  }),
)

authRouter.post('/logout', (req, res) => {
  req.session = null
  const me: Me = { loggedIn: false }
  res.json(me)
})

authRouter.get('/me', (req, res) => {
  const me: Me = { loggedIn: isLoggedIn(req) }
  res.json(me)
})

export default authRouter
