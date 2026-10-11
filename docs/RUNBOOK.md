# Runbook

How to run Prop Archive Outreach on your machine or on Replit.

## First time

1. Node 24 or newer. Check with `node --version`.
2. `cp .env.example .env` and set at least `APP_PASSWORD`. Everything else can stay empty: a missing
   key turns that feature off and the UI says which key to add.
3. `npm install`
4. `npm run dev`
   - Server on http://localhost:5300 (API), client on http://localhost:5173 (what you open).
   - The database file `data/outreach.db` is created and migrated on first boot. Default sequences
     are seeded on first boot too.
5. Open http://localhost:5173, log in with `APP_PASSWORD`.

`npm run db:push` is only needed if you change the schema and want to apply it without a migration.
The normal path is `npm run db:generate` (writes `drizzle/*.sql`) and a restart.

## Every day

- `npm run dev` and open the Go page. Flip Autopilot on. Dry run is the default: nothing leaves.
- Work the "Waiting for you" queue: copy, send, press Done.
- Switch to Live in Settings > Danger when the physical address is filled in and the sequences read
  right. There is a confirm dialog that lists what will go out.

## Scripts

| Script                | What it does                                               |
| --------------------- | ---------------------------------------------------------- |
| `npm run dev`         | server (tsx watch) + vite, both with reload                |
| `npm run build`       | client to `dist/client`, server to `dist/server`           |
| `npm start`           | run the built server, serves the built client, production  |
| `npm run check`       | TypeScript strict, client + server + tests                 |
| `npm test`            | vitest, in-memory sqlite, no network                       |
| `npm run lint`        | eslint                                                     |
| `npm run format`      | prettier write; `format:check` for CI                      |
| `npm run db:generate` | write a new migration from `server/db/schema.ts`           |
| `npm run db:push`     | push the schema straight to the db file (dev only)         |
| `npm run seed`        | run the seed by hand (idempotent)                          |
| `npm run smoke`       | boot, log in, import a CSV, tick, assert the queue (later) |

## Production (Replit)

- Build command: `npm run build`. Run command: `npm start`. Port: 5300 (or set `PORT`).
- Secrets go in Replit Secrets with the same names as `.env.example`.
- The sqlite file lives in `data/`; keep that folder persistent.
- Health check: `GET /api/health` returns `{ ok, version, dbOk, liveMode, autopilotOn }`.

## When something is off

- "Please log in" on every call: the cookie expired or `SESSION_SECRET` changed. Log in again.
  Set `SESSION_SECRET` in `.env` so restarts keep you logged in.
- "Add APP_PASSWORD in .env": the password is not set. Set it and restart.
- "not built yet" (501): that part of the system is still being built by its builder.
- A job never runs: look at `job_runs`. A `running` row younger than 10 minutes blocks the job.
  Housekeeping expires stale rows every hour; or delete the row.
- Delete `data/outreach.db` to start over (you lose leads and history).
