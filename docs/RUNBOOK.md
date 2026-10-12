# Runbook

How to run Prop Archive Outreach on your machine or on Replit. Every command below was run on
2026-10-11 against the integrated system (sources, enrich, outreach, autopilot, content, UI).

## First time

1. Node 24 or newer. Check with `node --version`.
2. Outside Replit, `cp .env.example .env` and set `APP_PASSWORD`, `SESSION_SECRET`, and a PostgreSQL
   `DATABASE_URL`. In Replit, use Secrets for the login values; the database URL is managed.
   Provider keys are optional: a missing key turns that provider off.
3. `npm ci`, then `npm run db:push` to initialize the development database.
4. `npm run dev`
   - Server on http://localhost:5300 (API), client on http://localhost:5173 (what you open).
   - `PORT=5311 npm run dev` moves the API; the Vite proxy follows `PORT`.
   - PostgreSQL must have its schema applied before boot. The 36 default
     sequences (email, postcard, LinkedIn, call script, for Maya / Ray / Denise, with and without a
     trigger) are seeded on first boot and `settings.sequence_by_persona` is filled from them.
5. Open http://localhost:5173, log in with `APP_PASSWORD`.

After changing the schema, run `npm run db:generate` (writes `drizzle/postgres/*.sql`) and
`npm run db:push` for development. Replit's Publish flow applies the production schema diff.

## Every day

- `npm run dev` and open the Go page. Flip Autopilot on. Dry run is the default: nothing leaves.
- "Run one round now" on the Go page runs a tick at once. The first tick of the day runs discover,
  which calls the Philadelphia Carto API (OPA assessments, L&I rental licenses) with your target zips
  and creates up to `max_new_leads_per_day` leads. It takes a few seconds for the default seven zips.
- Work the "Waiting for you" queue: copy, send, press Done. LinkedIn, Instagram and calls always
  land here, in dry run and in live mode alike. Postcards land here too when `mail_provider` is
  `print`; "Print letter" opens a print-ready page.
- Email and mail enrollments start on day 0; LinkedIn and call enrollments start one day later, so
  the queue is empty right after a brand new lead is enrolled. That is expected.
- Switch to Live in Settings > Danger when the physical address is filled in and the sequences read
  right. There is a confirm dialog that lists what will go out.

## Checking it by hand (curl)

```
J=/tmp/cj.txt; B=http://localhost:5311
curl -s -c $J -b $J -H 'content-type: application/json' -d '{"password":"test"}' $B/api/login
curl -s -b $J $B/api/leads            # {"items":[],"page":1,"limit":50,"total":0} on a fresh db
curl -s -b $J $B/api/sequences        # 36 seeded sequences with steps and enrolled_count
curl -s -b $J $B/api/settings         # defaults; sequence_by_persona has 12 ids filled
curl -s -b $J $B/api/autopilot        # {on,liveMode,lastTick,nextTick,today:{...},jobs:{...}}
curl -s -b $J -X POST $B/api/autopilot/tick   # one dry-run round; answers the status plus tick.jobs
curl -s -b $J $B/api/queue            # {"groups":{"email":[],...},"total":0} until something is due
curl -s -b $J "$B/api/activity?limit=100"
```

## Scripts

| Script                | What it does                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| `npm run dev`         | server (tsx watch) + vite, both with reload                                 |
| `npm run build`       | client to `dist/client`, server to `dist/server`                            |
| `npm start`           | run the built server, serves the built client, production                   |
| `npm run check`       | TypeScript strict, client + server + tests                                  |
| `npm test`            | vitest, isolated PostgreSQL test schemas; requires development DATABASE_URL |
| `npm run lint`        | eslint                                                                      |
| `npm run format`      | prettier write; `format:check` for CI                                       |
| `npm run db:generate` | write a new migration from `server/db/schema.ts`                            |
| `npm run db:push`     | push the schema straight to the db file (dev only)                          |
| `npm run seed`        | run the seed by hand (idempotent; re-reads `content/sequences/*.md`)        |
| `npm run smoke`       | boot on a random port, log in, import a 3-row CSV, tick in dry run, assert  |

The smoke script clears `target_zips` before the tick so it never calls the Carto API; it checks
that 3 leads exist, the tick ran every job without an error, dry_run messages were written and
nothing is marked sent. `SMOKE_ALLOW_NOT_BUILT=1` only matters while a module is missing.

## Editing the copy

The sequences live in `content/sequences/*.md` (front matter plus `## Step N` sections; see
`docs/COPY.md`). Edit a file and run `npm run seed`: a sequence whose name already exists is left
alone, a renamed one is inserted as new. Edits made in the Sequences page stay in the database.
Postcards start with `Hi {{first_name}},`; a lead without a first name reads "Hi there,".

## Production (Replit)

- Run button and Preview: `npm ci && npm run build && npm start` with `PORT=5000` (port 5000 maps
  to 80 for the Preview). Data lives in this project's Replit PostgreSQL database.
- Publishing: Reserved VM, not Autoscale. The autopilot is a timer inside the server, so the app
  must stay up and run as exactly one copy. Build `npm ci && npm run build`, run `npm start`.
- A published app loses the files it writes on every publish and restart, so it cannot use the
  SQLite file. Replit supplies the PostgreSQL `DATABASE_URL` automatically; no Turso tokens
  or OUTREACH_DATABASE_URL settings are used. Apply development schema changes with
  `npm run db:push`. Replit applies the development-to-production schema diff when you Publish.
  Startup checks the schema but never runs DDL. Keep APP_PASSWORD and SESSION_SECRET in publishing
  secrets. First boot seeds 36 default sequences; production data remains separate from Preview.
  The old `data/outreach.db` is preserved as a backup. The development-only importer
  `npx tsx scripts/import-sqlite.ts` refuses nonempty targets and never changes that file.
- Replit sets `DATABASE_URL` to this project's PostgreSQL database. The app uses it directly.
  Never substitute credentials belonging to the main Prop Archive app.
- Secrets go in Replit Secrets with the same names as `.env.example`. Set `APP_PASSWORD` (nobody
  can log in without it) and `SESSION_SECRET` (or every restart logs you out). Set `PUBLIC_URL`
  when not on Replit, or unsubscribe and tracked links point at localhost.
- Health check: `GET /api/health` returns `{ ok, version, dbOk, liveMode, autopilotOn }`.

## When something is off

- "Please log in" on every call: the cookie expired or `SESSION_SECRET` changed. Log in again.
  Set `SESSION_SECRET` in `.env` so restarts keep you logged in.
- "Add APP_PASSWORD in .env": the password is not set. Set it and restart.
- `POST /api/leads/discover` answers 409 RUNNING: a discover is already running (the tick or an
  earlier press). Wait for it.
- Discover found nothing: check `target_zips` in Settings and the activity feed for
  `discover.li.failed` / `discover.opa.failed` lines (the Carto API was down or slow).
- Nobody gets enrolled: enroll only takes leads at status `enriched` with a usable channel. With no
  provider keys most public-record leads have no email, so turn on `mail` in Settings > Channels or
  add a Hunter / Apollo / PDL / Anthropic key.
- Email refuses to send in live mode: `physical_address` is empty (CAN-SPAM). Fill it in Settings.
- A job never runs: look at `job_runs`. A `running` row younger than 10 minutes blocks the job.
  Housekeeping expires stale rows every hour; or delete the row.
- Delete `data/outreach.db` to start over (you lose leads and history).
