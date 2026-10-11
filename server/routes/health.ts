// GET /api/health -> { ok, version, dbOk, liveMode, autopilotOn }. No auth. Owned by the scaffold.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Router } from 'express'
import type { Health } from '../../shared/types.ts'
import { modules } from '../contracts.ts'
import { dbOk, getDb } from '../db/client.ts'
import { asyncHandler } from '../lib/http.ts'
import { getSettings } from '../lib/settings.ts'

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const APP_VERSION = readVersion()

export const healthRouter = Router()

healthRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const db = getDb()
    const ok = await dbOk(db)
    let liveMode = false
    let autopilotOn = false
    if (ok) {
      const s = await getSettings(db)
      liveMode = s.live_mode
      autopilotOn = s.autopilot_on
      if (modules.autopilot) {
        try {
          autopilotOn = (await modules.autopilot.status()).on
        } catch {
          // keep the settings value
        }
      }
    }
    const body: Health = { ok, version: APP_VERSION, dbOk: ok, liveMode, autopilotOn }
    res.status(ok ? 200 : 503).json(body)
  }),
)

export default healthRouter
