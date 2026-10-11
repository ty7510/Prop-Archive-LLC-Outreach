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

## Outreach builder (2026-10-11)

- **Deps bag** (`server/outreach/deps.ts`): db, clock, random, fetch, SMTP mailer factory, a thin
  `Llm` (text + structured) over `@anthropic-ai/sdk`, and an IMAP client factory, all injected.
  `defaultDeps()` reads env; `testDeps(db, fakes)` for tests. Routes read `outreachDeps()`, tests
  swap it with `setOutreachDeps()`. No test touches the network.
- **Public base URL for links:** `PUBLIC_URL` env, else the first `REPLIT_DOMAINS` entry, else
  `http://localhost:PORT`. Settings has no such key, so this stays an env value.
- **Tracked links carry `?c=<channel>&s=<sequence-slug>`** so `/r/:token/:dest` can tag the click
  without a lookup; it falls back to the lead's last outbound message. Unknown token still
  redirects (without `ref`) so a prospect never hits a dead link.
- **At-most-once:** `sendDue` writes the message row (`queued`) with `enrollment_id:step_index`
  before any provider call. A later run that finds the row as `sent|dry_run|ready_for_human|skipped`
  only advances the enrollment; a row left `queued|failed` is retried in place.
- **Daily caps count `dry_run` rows too**, so a dry run paces exactly like live would.
- **Human channels advance the enrollment when the `ready_for_human` row is created.** Queue
  done/skip only change the message status (done also stamps `last_contacted_at`).
- **Lead statuses never contacted by the autopilot:** replied, booked, joined, not_interested,
  unsubscribed, bounced, disqualified, plus do_not_contact and any suppression hit. A human may
  re-enrol replied / not_now leads by hand; unsubscribed, bounced, do_not_contact and suppressed
  are refused for everyone.
- **`first_name` falls back to "there"** when unknown, so "Hi {{first_name}}" never reads "Hi ,".
  Unknown variable names render empty and log `template_missing_var` as a warn.
- **Test send** emails step 1 (rendered for a labelled sample lead) to `owner_email` regardless of
  `live_mode`, since it only reaches Theo. It still needs an email provider and the physical address.
- **Replies:** IMAP search since last sync (stored as settings row `_replies_synced_at`) minus one
  day of slack, last 200 uids. Thread match on `In-Reply-To`/`References` vs `provider_message_id`,
  else From address of a contacted lead. Bounces skip the model and never notify the owner.
- **Webhook outcomes** reuse `recordOutcome`, which `POST /api/leads/:id/outcome` also uses.
  `enroll`, `stop` and `outcome` live in `routes/sequences.ts` as `leadOutreachRouter`, mounted at
  `/api/leads` before `leadsRouter` (one line in `app.ts`).
