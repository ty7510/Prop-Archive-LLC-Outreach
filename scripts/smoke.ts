// Smoke test: boot the whole app on a random port with an in-memory database, log in, set up
// settings, import a tiny CSV, run one autopilot tick in dry run and check the results.
// Exit code 1 on any failure. Prints a one-screen summary.
//
//   npm run smoke
//   SMOKE_ALLOW_NOT_BUILT=1 npm run smoke   (a 501 NOT_BUILT from an unbuilt module counts as a skip)
//
// Env is set before any server module loads, because server/env.ts reads process.env at import time.
process.env.APP_PASSWORD = 'test'
process.env.DATABASE_URL = 'file::memory:'
process.env.OUTREACH_DATABASE_URL = 'file::memory:'
process.env.SESSION_SECRET ||= 'smoke-session-secret-not-for-production'
process.env.NODE_ENV ||= 'development'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type StepStatus = 'ok' | 'fail' | 'skip'
interface StepResult {
  name: string
  status: StepStatus
  note: string
}

const ALLOW_NOT_BUILT = process.env.SMOKE_ALLOW_NOT_BUILT === '1'
const results: StepResult[] = []

class NotBuilt extends Error {
  constructor(what: string) {
    super(`${what} answered 501 NOT_BUILT (module not built yet)`)
    this.name = 'NotBuilt'
  }
}

class Skip extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Skip'
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn()
    results.push({ name, status: 'ok', note: typeof value === 'string' ? value : '' })
    return typeof value === 'string' ? undefined : value
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ name, status: 'skip', note: err.message })
      return undefined
    }
    if (err instanceof NotBuilt && ALLOW_NOT_BUILT) {
      results.push({ name, status: 'skip', note: err.message })
      return undefined
    }
    const message = err instanceof Error ? err.message : String(err)
    results.push({ name, status: 'fail', note: message })
    return undefined
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** A tiny fetch wrapper that keeps the session cookies. */
class Client {
  private cookies = new Map<string, string>()
  constructor(private readonly base: string) {}

  async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; text: string }> {
    const headers: Record<string, string> = {}
    const cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) headers.cookie = cookie
    let payload: RequestInit['body']
    if (body instanceof FormData) payload = body
    else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: payload,
      redirect: 'manual',
    })
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const eq = pair?.indexOf('=') ?? -1
      if (pair && eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    const text = await res.text()
    return { status: res.status, json: parseJson(text), text }
  }

  async expect(method: string, path: string, body?: unknown, ok = [200]): Promise<unknown> {
    const r = await this.call(method, path, body)
    if (r.status === 501 && (r.json as { code?: string } | null)?.code === 'NOT_BUILT') {
      throw new NotBuilt(`${method} ${path}`)
    }
    if (!ok.includes(r.status)) {
      throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 200)}`)
    }
    return r.json
  }
}

const CSV = [
  'name,email,phone,company,address,city,state,zip,linkedin,properties',
  'Maya Thompson,maya.thompson@example.com,215-555-0101,,1200 S 47th St,Philadelphia,PA,19143,https://www.linkedin.com/in/maya-thompson-example,4',
  'Ray Alvarez,ray@alvarezholdings.example.com,,Alvarez Holdings LLC,2300 N 29th St,Philadelphia,PA,19121,https://www.linkedin.com/in/ray-alvarez-example,9',
  'Denise Carter,denise@carterpm.example.com,215-555-0103,Carter Property Management,1500 Frankford Ave,Philadelphia,PA,19125,https://www.linkedin.com/in/denise-carter-example,18',
  '',
].join('\n')

async function main(): Promise<number> {
  const started = Date.now()
  const { createApp } = await import('../server/app.ts')
  const { createTestDb } = await import('../server/db/client.ts')
  const { hasModule, modules } = await import('../server/contracts.ts')
  const { ensureWebhookSecret } = await import('../server/lib/settings.ts')
  const { seed } = await import('../server/seed/index.ts')
  const { messages } = await import('../server/db/schema.ts')
  const { eq } = await import('drizzle-orm')

  // Register whatever modules exist. Each index file registers itself when its builder is done.
  await import('../server/sources/index.ts')
  await import('../server/enrich/index.ts')
  await import('../server/outreach/index.ts')
  await import('../server/autopilot/index.ts')
  const present = (['sources', 'enrich', 'outreach', 'autopilot'] as const).filter((m) =>
    hasModule(m),
  )

  const db = await createTestDb()
  await ensureWebhookSecret(db)
  const seeded = await seed(db)
  const app = createApp(db, { serveClient: false })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const client = new Client(`http://127.0.0.1:${port}`)
  const dir = mkdtempSync(join(tmpdir(), 'outreach-smoke-'))

  try {
    await step('boot', async () => {
      const health = (await client.expect('GET', '/api/health')) as {
        ok: boolean
        dbOk: boolean
        liveMode: boolean
      }
      assert(health.ok && health.dbOk, 'health not ok')
      assert(health.liveMode === false, 'live mode must be off in smoke')
      return `port ${port}, modules: ${present.join(', ') || 'none'}, seed: ${JSON.stringify(seeded)}`
    })

    await step('login', async () => {
      await client.expect('POST', '/api/login', { password: 'test' })
      const me = (await client.expect('GET', '/api/me')) as { loggedIn: boolean }
      assert(me.loggedIn, 'not logged in after login')
      return 'cookie session works'
    })

    await step('settings', async () => {
      const s = (await client.expect('PUT', '/api/settings', {
        live_mode: false,
        // No target zips: the daily discover job has nothing to look up, so the smoke never calls
        // the Carto API. The CSV below is the only lead source here.
        target_zips: [],
        physical_address: '1500 Market St, Suite 1200, Philadelphia, PA 19102',
        // Any time of any day counts as the send window, so the tick's send job always runs here.
        send_window: {
          tz: 'America/New_York',
          days: [0, 1, 2, 3, 4, 5, 6],
          start: '00:00',
          end: '23:59',
        },
        min_icp_score: 0,
      })) as { live_mode: boolean; physical_address: string }
      assert(s.live_mode === false, 'live_mode should be false')
      assert(s.physical_address.length > 0, 'physical_address not saved')
      return 'dry run, no target zips, physical address set, send window open all day'
    })

    const imported = await step('import csv', async () => {
      const file = join(dir, 'leads.csv')
      writeFileSync(file, CSV)
      const form = new FormData()
      form.append('file', new Blob([CSV], { type: 'text/csv' }), 'leads.csv')
      const r = (await client.expect('POST', '/api/leads/import', form)) as {
        created: number
        merged: number
        skipped: number
        row_count: number
      }
      assert(r.row_count === 3, `expected 3 rows, got ${r.row_count}`)
      assert(r.created === 3, `expected 3 created, got ${r.created}`)
      return r
    })

    const tick = await step('autopilot tick', async () => {
      const r = (await client.expect('POST', '/api/autopilot/tick')) as {
        tick: { jobs: { job: string; status: string; error?: string }[] } | null
        today: Record<string, unknown>
      }
      assert(r.tick, 'tick summary missing')
      const errors = r.tick.jobs.filter((j) => j.status === 'error')
      assert(
        errors.length === 0,
        `jobs failed: ${errors.map((j) => `${j.job}: ${j.error ?? ''}`).join('; ')}`,
      )
      return r
    })
    if (tick) {
      results.push({
        name: 'tick jobs',
        status: 'ok',
        note: tick.tick!.jobs.map((j) => `${j.job}=${j.status}`).join(' '),
      })
    }

    await step('leads has 3 rows', async () => {
      if (!imported) throw new Skip('import did not run')
      const page = (await client.expect('GET', '/api/leads?limit=50')) as {
        items: unknown[]
        total: number
      }
      assert(Array.isArray(page.items), 'items is not an array')
      assert(page.total === 3, `expected total 3, got ${page.total}`)
      assert(page.items.length === 3, `expected 3 items, got ${page.items.length}`)
      return 'total 3'
    })

    await step('autopilot today counts are numbers', async () => {
      const s = (await client.expect('GET', '/api/autopilot')) as {
        today: Record<string, unknown>
        on: boolean
        liveMode: boolean
      }
      const keys = [
        'discovered',
        'enriched',
        'enrolled',
        'sent',
        'queued',
        'replied',
        'booked',
        'joined',
      ]
      for (const k of keys) {
        assert(
          typeof s.today[k] === 'number' && Number.isFinite(s.today[k]),
          `today.${k} is ${String(s.today[k])}`,
        )
      }
      assert(s.liveMode === false, 'liveMode should be false')
      return keys.map((k) => `${k}=${String(s.today[k])}`).join(' ')
    })

    await step('dry run produced work', async () => {
      if (!modules.outreach) throw new Skip('outreach module not registered')
      if (!imported) throw new Skip('import did not run')
      const queue = (await client.expect('GET', '/api/queue')) as { total: number }
      const dryRuns = await db.select().from(messages).where(eq(messages.status, 'dry_run'))
      assert(
        queue.total > 0 || dryRuns.length > 0,
        `queue total ${queue.total}, dry_run messages ${dryRuns.length}: nothing was produced`,
      )
      return `queue ${queue.total}, dry_run messages ${dryRuns.length}`
    })

    await step('nothing left the building', async () => {
      const sent = await db.select().from(messages).where(eq(messages.status, 'sent'))
      assert(sent.length === 0, `${sent.length} messages are marked sent in dry run`)
      return 'no sent messages'
    })
  } finally {
    modules.autopilot?.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = results.filter((r) => r.status === 'fail').length
  const skipped = results.filter((r) => r.status === 'skip').length
  const width = Math.max(...results.map((r) => r.name.length))
  console.log('')
  console.log('Prop Archive outreach smoke test')
  console.log('-'.repeat(40))
  for (const r of results) {
    const mark = r.status === 'ok' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL'
    console.log(`${mark}  ${r.name.padEnd(width)}  ${r.note}`)
  }
  console.log('-'.repeat(40))
  console.log(
    `${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped in ${Date.now() - started} ms`,
  )
  if (failed > 0 && !ALLOW_NOT_BUILT && results.some((r) => r.note.includes('NOT_BUILT'))) {
    console.log('Tip: SMOKE_ALLOW_NOT_BUILT=1 npm run smoke treats unbuilt modules as skips.')
  }
  return failed > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('smoke crashed', err)
    process.exit(1)
  })
