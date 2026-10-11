# Decisions

Things the spec left open, and what the scaffold chose. Dated. Builders add their own below.

## 2026-10-11 (scaffold)

- **Versions.** Express 4.22, React 18.3, Vite 6.4, Tailwind 3.4 as the spec pins them. TypeScript 5.9
  (typescript-eslint supports < 6.1; TS 7 is out but not supported by the lint stack yet), vitest 4.1
  (peer vite ^6), eslint 10 + typescript-eslint 8, zod 4, drizzle-orm 0.45, @libsql/client 0.18,
  multer 2, Node 24.
- **Relative imports carry the `.ts` extension** (`import { x } from './x.ts'`). One rule that works in
  tsx, vite, vitest and the emitted build (`rewriteRelativeImportExtensions` rewrites to `.js`).
  `@shared/*` is an alias for the client (vite + tsconfig). Server code imports shared files by relative
  path (`../../shared/types.ts`) so `node dist/...` runs without a path rewriter.
- **Three tsconfigs.** `tsconfig.json` is the client (Bundler resolution, react-jsx, DOM lib).
  `tsconfig.server.json` is NodeNext and emits to `dist/server`. `tsconfig.test.json` type-checks the
  tests. `npm run check` runs all three. `npm run build` is `vite build` + server tsc.
- **Migrations, not push, on boot.** `drizzle/` holds generated SQL (`npm run db:generate`) and
  `applyMigrations(db)` runs it on every boot and in `createTestDb()`. `npm run db:push` still works for
  quick local schema pokes, but the committed migration is the source of truth. Schema changes =
  edit `server/db/schema.ts`, run `npm run db:generate`, commit both.
- **Foreign keys on.** `PRAGMA foreign_keys = ON` runs in `applyMigrations`. Deleting a lead cascades to
  its properties, enrollments, messages, events. Messages keep a null `enrollment_id`/`step_id` when
  a sequence is deleted.
- **Default db singleton is lazy.** `getDb()` creates the libsql client on first use; `createApp(db)`
  calls `setDefaultDb(db)` so `lib/*` helpers (which take an optional trailing `db` argument) share the
  app's connection. Tests pass an in-memory db explicitly or build an app with `createTestDb()`.
- **Settings are one row per key** (`settings.key` primary key, JSON value). `getSettings()` merges rows
  onto `DEFAULT_SETTINGS` and caches for 5 s per db instance. `updateSettings(partial)` deep-merges
  nested objects (so `{ channels: { mail: true } }` keeps the other channels), replaces arrays, rejects
  unknown keys with 400, and writes only the keys that were sent. A single bad row falls back to its
  default instead of taking the app down. Seed state lives in the same table under `_seeded_at`, which
  the settings loader ignores.
- **sequence_by_persona has five channels** (email, mail, linkedin, instagram, call). The spec lists
  four; instagram is a channel everywhere else, so the map carries it with a null default. Harmless if
  unused.
- **beta_url default** is kept as the spec gives it (`https://proparchive.app/?join=beta`). Outreach
  should fall back to `site_url` when the link does not resolve; that check is the outreach builder's.
- **Send window** `end` is exclusive, `start` inclusive, weekdays use `Date.getDay()` numbering.
  `nextWindowStart` returns the input when already inside and `null` when no day is enabled.
  DST is handled with `Intl.DateTimeFormat` only, no library.
- **Job locks** check for a `running` row younger than 10 minutes, then insert. The process is
  single-threaded and the tick is serial, so there is no insert race to guard. `expireStaleLocks` is
  there for housekeeping; `lastRuns` feeds `GET /api/autopilot`.
- **Auth.** `cookie-session`, cookie `outreach.sid`, 30 days, `sameSite=lax`, `secure=false` (Replit
  terminates TLS in front of the app and the Vite proxy is plain http). `SESSION_SECRET` is generated
  per boot when missing, so logins reset on restart until it is set in `.env`. `APP_PASSWORD` missing
  makes `/api/login` answer 503 `NO_PASSWORD` with the fix in the message. Password compare is
  constant time.
- **Open routes:** `/api/health`, `/api/login`, `/api/logout`, `/api/me`, `/api/webhooks/*` (secret
  header, checked by the route), `/u/*`, `/r/*`. Everything else under `/api` is behind `requireAuth`.
- **Errors** are always `{ error, code? }`. `HttpError(status, message, code)` from `lib/http.ts`,
  zod errors become 400 `VALIDATION` with the first issue path in the message, unregistered modules
  become 501 `NOT_BUILT`, bad JSON 400 `BAD_JSON`. Stub routes throw `notBuilt()`.
- **Module registry** (`server/contracts.ts`): builders call `registerModule(name, impl)` from their
  `index.ts`; `server/index.ts` imports all four index files. Routes use `requireModule(name)` and
  get a clean 501 while the module is missing, so the UI can be built against the real paths now.
- **`/api/leads/enrich` lives in `routes/enrich.ts`** mounted at `/api/leads` before `routes/leads.ts`,
  so the enrich builder owns its route file without touching the leads router.
- **Health** reads `settings.live_mode` and, when the autopilot module is registered, its `status().on`;
  otherwise `settings.autopilot_on`. Returns 503 when the db does not answer.
- **Client in production** is served from `dist/client` by Express with an SPA fallback for every
  GET that is not `/api`, `/u` or `/r`. In development Vite (port 5173) proxies those three prefixes to
  the server on 5300.
- **Tailwind:** base 16px, `.btn*` classes are 44px tall minimum (`min-h-tap`), `.input` too. The left
  nav collapses to a horizontal bar under 768px so phone width works.
- **Lint:** flat eslint, `@eslint/js` + `typescript-eslint` recommended, `consistent-type-imports`,
  unused vars allowed with a `_` prefix. No react-hooks plugin (spec said keep it simple).
- **Prettier:** single quotes, no semicolons, width 100, trailing commas.
- **Em-dash guard:** `hasEmDash()` in `lib/text.ts` for builders to assert on rendered copy. No
  automated sweep of the client yet; the UI builder should grep `—` in `client/` and `content/`.

## 2026-10-11 (autopilot)

- **Interval always runs, ticks only while on.** `start()` schedules the 60 s interval at boot no matter
  what; each scheduled tick reads `settings.autopilot_on` and returns at once when it is false. `POST
/api/autopilot/start|stop` flip the setting and start or stop the interval. `POST /api/autopilot/tick`
  runs a tick now even while off, and answers the status plus a `tick` field with one line per job
  (`ok | error | skipped | not_built | not_due | outside_window`). Two overlapping ticks share one run.
- **Due checks come from `job_runs`, not memory,** so a restart does not rerun discover: discover is due
  when no run started on the local day yet, sync_replies when none in the last 10 minutes, housekeeping
  when none in the last hour. Any status counts (ok, error, running), so a failing discover is tried
  once a day, not once a minute.
- **A missing module is a `not_built` job** with one warn line in the activity log per module per process,
  never a crash. A job error is written to `job_runs` and the activity log and the tick moves on.
- **Today's counters are computed, never stored,** over the local day in `settings.send_window.tz`:
  discovered = leads created today; enriched = leads at status enriched or later whose `updated_at` is
  today; enrolled = enrollments started today; sent = outbound messages with status `sent` and `sent_at`
  today (dry runs do not count as sent, the send job's activity line carries `dryRun`); queued =
  `ready_for_human` messages created today; replied = inbound messages created today; booked / joined =
  `demo_booked` / `beta_joined` events today. "Roll daily counters" in housekeeping is therefore just a
  logged snapshot of these numbers plus `expireStaleLocks()`.
- **`lastTick`** is the in-memory start of the last tick, falling back to the newest `job_runs` row after a
  restart. `nextTick` is null while autopilot is off.
- **Smoke script** (`npm run smoke`) boots the app on a random port with an in-memory db and
  `APP_PASSWORD=test`. A 501 from an unbuilt module fails the run; `SMOKE_ALLOW_NOT_BUILT=1` turns
  those into skips so the script is useful before every builder has landed.
