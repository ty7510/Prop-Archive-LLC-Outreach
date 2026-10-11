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

## 2026-10-11 (enrich)

- **Provider interface** is the spec's plus `applies(lead, ctx)`: a provider says no when the lead
  lacks what it needs (Hunter needs a business domain and a first/last name, Apollo and PDL need a
  person's name, L&I needs an OPA account on a property). Saves credits and avoids junk matches.
  Providers throw a plain `Error` on failure; the orchestrator catches it, logs
  `enrich.provider_error` to activity_log and carries on. One lead counts as `failed` only when
  every provider that ran threw; its status goes back to `new` so the next tick retries.
- **Credit caps** count `provider_usage` rows in the calendar month of `settings.send_window.tz`.
  The check is `used + costPerCall > cap`; Hunter declares `costPerCall: 2` (finder + verifier) and
  records what it really used (1 when nothing was found). PDL records 0 for a 404 ("no match" is not
  billed). The free L&I provider records a 0-credit row so `GET /api/enrich/usage` shows calls.
  A cap being hit is logged once per batch, not once per lead.
- **Stop rule** is the spec's: email AND (linkedin OR phone). Email statuses: Hunter verifier
  `deliverable` -> valid, `undeliverable` -> invalid, else risky; Apollo `verified` -> valid,
  `guessed`/`likely to engage` -> risky; Claude research and PDL emails are `unknown` (unverified).
  `mergeProviderResult` never writes an empty value over a value, never replaces a `valid` email with
  a different address, and only upgrades the same address to a better status.
- **Channels** are "do we have a way in" (email that is not invalid, mailing street + zip or city,
  linkedin url, instagram url, phone). Settings toggles and suppression are outreach's job.
- **Status** moves new -> enriching -> enriched only for leads in new/enriching/enriched. A lead that
  is already enrolled or further along keeps its status but still gets the new fields and channels.
- **Claude research** follows the SDK README: `client.messages.parse` with
  `output_config: { effort: 'low', format: zodOutputFormat(schema) }` (a `json_schema` format), the
  `web_search_20260209` server tool with `max_uses: 5`, `max_tokens: 2000`, no streaming. `stop_reason`
  is read before content: `refusal` and `max_tokens` return an empty result, `pause_turn` pushes the
  assistant turn back and continues (3 turns max). Timeout is 60 s for this provider because a web
  search turn cannot finish in the 10 s the plain HTTP providers get; the SDK retries 429/5xx twice.
- **GET /api/enrich/usage** needed a second mount point, so `server/app.ts` gained one line:
  `app.use('/api/enrich', enrichUsageRouter)`.
- **L&I joins** `business_licenses.opa_account_num` on `properties.opa_account`, newest active license
  per property. It fills `properties.units` and license fields, sums `unit_count`, and reads the
  person from `legalfirstname/legallastname`, else `ownercontact1name`.

## 2026-10-11 (outreach)

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

## 2026-10-11 (integration)

- **Merge order** sources, enrich, outreach, ui, autopilot, content, each `--no-ff`. Conflicts were
  only in `server/app.ts` (kept both mount lines), `docs/DECISIONS.md` (kept every section, in date
  order) and `server/routes/settings.test.ts` (the "stub routes answer 501" test is gone: nothing is
  a stub any more). No package.json, lock file or schema conflicts, so no migration was regenerated.
- **One owner per path.** `POST /api/leads/:id/enroll`, `/stop` and `/outcome` were built twice
  (sources in `routes/leads.ts`, outreach in `routes/sequences.ts` as `leadOutreachRouter`). The
  outreach router is mounted first and now owns them; the copies in `routes/leads.ts` were removed.
  `PATCH /api/leads/:id` with `do_not_contact: true` still calls `modules.outreach.stopLead`.
- **Stopping a lead empties its queue.** `stopLead` in `server/outreach/enroll.ts` also marks the
  lead's `queued` and `ready_for_human` outbound messages `skipped`, so a lead who books, joins, says
  no or is marked do-not-contact drops out of Theo's "Waiting for you" list at once.
- **Outreach deps follow the current db.** `outreachDeps()` rebuilds its default bag when `getDb()`
  changes, instead of caching the first database for the life of the process. Production has one db;
  tests make one per test and were reading the wrong one.
- **The smoke stays offline.** `scripts/smoke.ts` sets `target_zips: []` before the tick, so the
  daily discover job has nothing to look up and the Carto API is never called. The CSV it imports is
  the only lead source. Strict mode (no `SMOKE_ALLOW_NOT_BUILT`) passes: 10 of 10.
- **beta_url is `https://proparchive.app/?beta=1`.** The main app's `conversion-dialogs.tsx` opens
  the Join the beta form when the home page is loaded with `?beta=1` (and strips the key); `?join=beta`
  does nothing. `demo_url` stays `https://proparchive.app/demo`.
- **No "Reset today's counters".** Today's numbers and the daily caps are computed from rows for the
  current local day, so there is nothing to reset; the button and its unlisted route are gone and
  Settings > Danger says so in one sentence.
- **Postcards open with `Hi {{first_name}},`** so a lead with no first name renders "Hi there,"
  (the renderer's fallback) instead of "there,". Emails already said "Hi {{first_name}},".
- **Live Carto run observed.** One manual tick on a fresh db with the default seven zips created 50
  leads (583 more skipped by the daily cap) from L&I new rental licenses in about 2.5 s, enriched 10
  (only the free `li_license` provider ran; the others logged `provider_not_configured`), enrolled 0
  (no email, mail off, no profile URLs or phones), and left the queue empty. New-license leads whose
  license covers 1 or 2 units score 55 and persona `maya`; whether that is wanted is Theo's call.

## 2026-10-11 (review fixes)

- **Re-enrolling is a new run.** `enrollments.run` (new column, migration `0001_run_and_attempts`)
  is bumped every time a lead is put back into a sequence that was done or stopped. The idempotency
  key stays `enrollment_id:step_index` for run 0 and becomes `enrollment_id:r<run>:step_index` after
  that, so the rows of an earlier run are never mistaken for "already sent". Before this, a
  re-enrolled lead walked through every step without a single message leaving, and a lead stopped
  mid-sequence got false `sent` events and a false `contacted` status.
- **Dry run to Live restarts dry-run sequences.** `PUT /api/settings` with `live_mode` going from
  off to on calls `restartDryRunEnrollments`: every enrollment whose outbound rows are all `dry_run`
  goes back to step 0 as a new run, so the first live round really sends step 1. Enrollments with a
  real send or a queued human item are left alone. The Live confirm says so.
- **At-most-once, for real.** A message row is set to `sending` (new status) with `attempts + 1`
  right before the provider call. A row found in `sending` on a later tick means the process died
  mid-send: it becomes `failed` with "Send outcome unknown" and is never resent by the machine
  (Theo checks his Sent folder; stop and start the sequence sends a fresh run). A `failed` row is
  retried at most `MAX_SEND_ATTEMPTS` (2) times and never after a timeout or socket error, because
  the provider may have accepted the message. Emails carry our own `Message-ID`
  (`<idempotency_key@host>`) so a duplicate is at least visible on the receiving side.
- **No step without a destination.** An email step for a lead with no email, or a mail step for a
  lead with no mailing address, ends that enrollment (`stopped_manual`) instead of queueing a card
  that says "To: null" or failing every minute. Live Lob mail refuses without `physical_address`
  exactly like live email does, logged once per round per channel.
- **Human steps wait for Theo.** While an enrollment has a `ready_for_human` row, its next step is
  not produced. Queueing no longer stamps `last_contacted_at` or `contacted`; marking the item done
  does (as before). Skip still leaves the enrollment where it is; whether a skipped connection note
  should end the LinkedIn sequence is Theo's call.
- **Owners first in discover.** The OPA owner pass (the 3-20 property ICP, the only pass that
  honours `min_props..max_props`) runs first and may use 80 percent of the day's budget
  (`OPA_BUDGET_SHARE`); new rental licenses take what is left, then recent sales merge. Before,
  633 one-license landlords used the whole budget for about two weeks and no ICP owner was ever
  asked for. L&I leads are still created and still score as before (1-2 units, persona maya at
  55); filtering them by `min_props` would turn the trigger source off entirely, so that stays a
  settings question for Theo.
- **Manual enrich takes the job lock.** `POST /api/leads/enrich` runs under `withJobLock('enrich')`
  like discover does and answers 409 RUNNING when the tick holds it, so the two never enrich (and
  pay for) the same leads at once.
- **Break-up email is day 8, written as `delay_days: 5`.** The scheduler counts from the previous
  send, so the third step of every email sequence now says 5 (3 + 5 = day 8), matching the spec's
  "day 0, 3, 8".
- **A failed discover is retried.** The once-a-day gate only counts `ok` and `running` job rows;
  an `error` row no longer blocks discover for the rest of the day.
- **Replies never undo a result.** `booked`, `joined`, `unsubscribed` and `not_interested` stay
  when a later mail is classified interested / not now / other. Unsubscribe and bounce still win.
- **Bounces are matched inside the report.** When a mail looks like a delivery failure (sender or
  subject) and has no thread id, `matchLead` looks for our message id and for a contacted lead's
  address anywhere in the raw mail (Final-Recipient, the embedded original, "could not be delivered
  to ..."). Resend bounces still need Resend's own webhook (not built: needs a signing secret and a
  decision from Theo); with Resend configured, IMAP alone will not see them.
- **Dedupe key follows the address.** A lead keyed by email that learns a mailing address on merge
  takes the `street|zip` key (unless another lead holds it), so the next OPA candidate for the same
  owner merges instead of becoming a second lead.
- **GET /u/:token is a page with one button.** Link scanners (SafeLinks, Mimecast, Gmail
  prefetch) GET every link in a mail; the GET now only shows "Stop emails to me", and the POST
  (that button, or RFC 8058 List-Unsubscribe-Post) does the unsubscribe. The site link on that page
  is HTML-escaped. `/r` and `/u` share an in-memory limit of 120 hits per client per minute, and a
  repeated click on the same link within 10 minutes is one click event.
- **Webhook hardening.** `site_url`, `demo_url`, `beta_url` and `human_queue_webhook_url` must be
  `https://` with a host. The human queue POST carries `x-outreach-signature: sha256=<HMAC of the
body with webhook_secret>` instead of the secret itself, and refuses private or loopback hosts.
  `trust proxy` is on only on Replit or with `TRUST_PROXY=1`, and the login limiter has a ceiling
  over all addresses together (10x the per-address limit).
- **Owner mail is exempt from Live.** Test sends and reply notices only ever reach
  `owner_email`; Settings and LEGAL.md now say so instead of "nothing leaves". Owner mail has no
  List-Unsubscribe headers (the old `/u/owner` link pointed nowhere).
- **PATCH status by hand stops outreach.** `PATCH /api/leads/:id` with booked / joined /
  not_interested / disqualified ends open enrollments and skips queued items, like the outcome route.
- **UI.** Queue cards break long tracked links (`break-words`, `min-w-0`), the phone nav shrinks to
  fit four links, the phone header has a Log out button, the Live confirm describes the saved
  settings (which are what runs) and warns about unsaved edits, "Start sequence" counts ticks on
  every page, and its confirm is disabled with "Nothing to start" when no lead can start.
  Postcards and call scripts render `demo_link` / `beta_link` / `site_link` as the plain
  `settings.*_url` (a person types or hears those); email and LinkedIn keep tracked links.
- **Not changed, on purpose.** From-address matching of replies still acts without a DKIM/SPF check
  (spec section 10 says "by From address"; Theo is emailed about every reply, and a forged
  unsubscribe only drops one prospect). Making it stricter would silence real replies from mail
  servers that do not add Authentication-Results.
