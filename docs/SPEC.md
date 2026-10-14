# Prop Archive Outreach: system spec (v1)

One app. Theo flips settings, presses Go, and the system finds Philadelphia landlords who fit the
Prop Archive ideal customer, enriches them with every reachable channel, and runs outreach that
books demos (https://proparchive.app/demo) and beta sign ups (https://proparchive.app, "Join the beta").
Theo only touches the parts a human legally has to touch (LinkedIn, Instagram, phone calls) and
he does those from a one-click queue.

This file is the contract. Every builder reads it. If something is not here, choose the simplest
thing that works and write it down in docs/DECISIONS.md.

## 1. Non-negotiables

- **Legal channels only.**
  - Email: cold B2B email is fine under CAN-SPAM when every message has a true From, a real
    physical mailing address in the footer, a working one-click unsubscribe link, no misleading
    subject. Suppression list is honoured forever.
  - Direct mail: postcards and letters to the owner mailing address from public property records
    are fine. Via Lob API when a key is present, otherwise a print-ready PDF/HTML batch.
  - LinkedIn and Instagram: no scraping of their sites, no automated login, no bots sending
    messages. We find profile URLs through licensed data APIs and public web search, write the
    message, and put it in a **human queue** where Theo copies and sends with one click.
    An optional outgoing webhook per ready message exists for his own tooling.
  - Phone: no automated texting or robocalls (TCPA). Phone numbers go into a **call queue** with
    a script. Theo dials.
  - Public records (Philadelphia OPA property assessments, L&I rental licenses) are open data and
    are the backbone lead source.
- **Dry run is the default.** `live_mode=false` means everything is computed and queued but no
  email or mail leaves the building. Theo flips live mode in Settings, with a confirm.
- **At-most-once sends.** Every outbound message has an idempotency key
  (`enrollment_id:step_index`). Jobs take a lock row before running. A crash never double sends.
- **No em-dash (the character "—") in any text the UI shows.** Use a plain hyphen, a comma or a
  new sentence. Empty table cells show an en dash ("–").
- **Plain words in the UI.** Buttons say what happens. No jargon. Big targets. Phone width works.
- **Secrets only in `.env`** (gitignored). `.env.example` lists every key with a one-line comment.
  Nothing works worse than "feature off" when a key is missing: the UI shows "add KEY in Settings".
- **Never contact a lead marked do_not_contact or on the suppression list.** Also never contact a
  lead whose email bounced or who replied, until Theo re-enables them by hand.

## 2. Stack

- Node 24, TypeScript (strict), ESM.
- Server: Express 4. Client: React 18 + Vite 6 + Tailwind 3 + wouter + @tanstack/react-query.
- Database: this project's Replit PostgreSQL through Drizzle ORM + `pg` (managed `DATABASE_URL`).
  `npm run db:push` applies the development schema. Tests use isolated PostgreSQL schemas.
- Validation: zod. Tests: vitest (+ supertest for API). Lint: eslint + prettier.
- Email: nodemailer (SMTP) or Resend (HTTP). Inbox sync: imapflow (IMAP). Mail: Lob API via fetch.
- AI: `@anthropic-ai/sdk`, model `claude-haiku-5-5`, structured outputs via `output_config.format`,
  web search server tool `web_search_20260209` for research enrichment. Reply classification and
  personalization also use it. Everything degrades to templates when `ANTHROPIC_API_KEY` is missing.
- Scheduler: in-process tick every 60 s (`server/autopilot`). Replit-safe: single process.
- Scripts: `dev` (server + vite), `build`, `start`, `check` (tsc), `test`, `lint`, `format`,
  `format:check`, `db:push`, `seed`.

## 3. Directory layout and ownership

```
server/
  index.ts              boot: env, db, routes, static client, scheduler       (scaffold)
  env.ts                zod-validated process.env                            (scaffold)
  db/schema.ts          ALL tables (section 4)                               (scaffold)
  db/client.ts          drizzle client factory, migrate on boot              (scaffold)
  routes/*.ts           one router per resource (section 6)                  (scaffold stubs, builders fill)
  sources/              OPA, L&I, CSV import, scoring, dedupe                (builder: sources)
  enrich/               providers + orchestrator + credit caps               (builder: enrich)
  outreach/             templates, rendering, sequences, senders, replies    (builder: outreach)
  autopilot/            tick, jobs, locks, pipeline, activity log            (builder: autopilot)
  seed/                 default sequences, sample leads, settings            (builder: content)
  lib/                  tiny shared helpers (ids, time, text)                (scaffold)
shared/
  types.ts              zod schemas + TS types shared by server and client   (scaffold)
  settings.ts           settings keys, defaults, zod schema                  (scaffold)
client/
  index.html, src/main.tsx, src/App.tsx, src/pages/*, src/components/*, src/api.ts  (builder: ui)
content/
  sequences/*.md        human-readable copy, also what seed loads            (builder: content)
docs/                   SPEC.md (this), DECISIONS.md, RUNBOOK.md, LEGAL.md
.github/workflows/ci.yml  check + test + format:check on push and PR         (scaffold)
```

Builders own only their directories plus the matching `server/routes/<name>.ts`. Shared files
(schema, shared/types, settings, package.json) are owned by the scaffold. If a builder truly needs a
schema or dependency change, make it minimal and list it at the top of their report so the
integrator can reconcile.

## 4. Data model (Drizzle, PostgreSQL)

All ids are `text` ULIDs (use `ulid` package). Timestamps are ISO strings in `text` columns.
JSON columns are `text` with `{ mode: 'json' }`.

**leads**
- id, created_at, updated_at
- source: 'opa' | 'li' | 'csv' | 'manual'
- status: 'new' | 'enriching' | 'enriched' | 'enrolled' | 'contacted' | 'replied' | 'booked' |
  'joined' | 'not_interested' | 'unsubscribed' | 'bounced' | 'disqualified'
- persona: 'maya' | 'ray' | 'denise' | 'unknown'   (3-6 props => maya, 7-14 => ray, 15-20 => denise)
- icp_score integer 0-100 (section 5)
- owner_kind: 'person' | 'llc' | 'unknown'
- full_name, first_name, last_name, company (LLC or business name)
- email, email_status: 'unknown' | 'valid' | 'risky' | 'invalid'
- phone, phone_type: 'unknown' | 'mobile' | 'landline' | 'voip'
- linkedin_url, instagram_url, website
- mailing_street, mailing_city, mailing_state, mailing_zip, mailing_verified boolean
- property_count integer, unit_count integer, zips json string[]
- trigger json { type: 'new_license' | 'recent_sale' | 'csv' | 'none', date?: string, detail?: string }
- channels json { email: boolean, mail: boolean, linkedin: boolean, instagram: boolean, call: boolean }
  (what we are actually able to use for this lead; computed after enrichment)
- enrichment json (raw provider payloads keyed by provider, with fetched_at)
- tags json string[], notes text
- do_not_contact boolean default false
- unsubscribe_token text unique
- last_contacted_at, last_replied_at, next_action_at
- dedupe_key text unique: normalised `mailing_street|mailing_zip` or `lower(email)` fallback

**properties**: id, lead_id, address, zip, category, units, sale_date, sale_price, market_value,
opa_account, license_num, license_issue_date, license_expiry, source, raw json.

**sequences**: id, name, channel: 'email' | 'mail' | 'linkedin' | 'instagram' | 'call',
persona: 'maya' | 'ray' | 'denise' | 'any', trigger: 'new_license' | 'recent_sale' | 'any',
active boolean, description, created_at, updated_at.

**sequence_steps**: id, sequence_id, step_index, delay_days, subject (email only), body
(template with `{{vars}}`), channel (inherits), notes.

**enrollments**: id, lead_id, sequence_id, status: 'active' | 'paused' | 'done' |
'stopped_replied' | 'stopped_unsubscribed' | 'stopped_bounced' | 'stopped_manual',
current_step integer, next_send_at, started_at, ended_at. Unique (lead_id, sequence_id).

**messages**: id, lead_id, enrollment_id, step_id, channel, direction: 'out' | 'in',
status: 'dry_run' | 'queued' | 'ready_for_human' | 'sent' | 'skipped' | 'failed' | 'bounced' |
'received', idempotency_key unique, subject, body, to_address (email, postal json, or profile url),
provider, provider_message_id, scheduled_at, sent_at, error, classification (inbound only:
'interested' | 'booked' | 'not_now' | 'not_interested' | 'unsubscribe' | 'bounce' | 'other' | null),
raw json, created_at.

**events**: id, lead_id, kind ('click' | 'open' | 'demo_booked' | 'beta_joined' | 'reply' |
'unsubscribe' | 'note' | 'status_change' ...), detail json, at.

**suppression**: id, kind: 'email' | 'domain' | 'address' | 'phone', value (normalised), reason, at.

**settings**: key text primary key, value json. Single logical row set; see shared/settings.ts.

**job_runs**: id, job, started_at, finished_at, status: 'running' | 'ok' | 'error', summary json,
error text. A job is skipped if a `running` row for it is younger than 10 minutes.

**activity_log**: id, at, level: 'info' | 'warn' | 'error', event, lead_id, detail json.

**imports**: id, kind, filename, row_count, created, merged, skipped, at, errors json.

## 5. Scoring and personas

`icp_score` 0-100, computed in `server/sources/score.ts`, pure function, unit tested:
- property_count 3-20: +40 (3-6: +40, 7-14: +40, 15-20: +35; 1-2: +5; >20: +10; 0/unknown: +15)
- any property zip in settings.target_zips: +20 (all of them: +25)
- trigger new_license within 60 days: +20; recent_sale within 90 days: +20
- property category MULTI FAMILY or MIXED USE or APARTMENTS: +10
- owner mailing address inside Philadelphia: +5 (local owner); out of state: 0
- clamp 0-100. Persona from property_count; 'unknown' when count is 0.

## 6. HTTP API (JSON, `/api/...`)

- `GET /api/health` -> { ok, version, dbOk, liveMode, autopilotOn }
- Leads: `GET /api/leads?status=&persona=&q=&page=&limit=` (paged), `GET /api/leads/:id` (with
  properties, enrollments, messages, events), `PATCH /api/leads/:id` (notes, tags, do_not_contact,
  status for manual outcomes), `POST /api/leads/import` (multipart CSV), `POST /api/leads/discover`
  (run sources now, body { zips?, limit? }), `POST /api/leads/enrich` (body { ids?: string[], all?:
  boolean }), `POST /api/leads/:id/enroll` { sequence_id }, `POST /api/leads/:id/stop`,
  `POST /api/leads/:id/outcome` { kind: 'demo_booked' | 'beta_joined' | 'not_interested' }.
- Sequences: `GET /api/sequences` (with steps), `POST /api/sequences`, `PUT /api/sequences/:id`
  (replace steps), `DELETE /api/sequences/:id`, `POST /api/sequences/:id/preview` { lead_id? } ->
  rendered steps, `POST /api/sequences/:id/test-send` -> sends step 1 to settings.owner_email.
- Queue (human channels): `GET /api/queue` -> ready_for_human messages grouped by channel,
  `POST /api/queue/:messageId/done`, `POST /api/queue/:messageId/skip`.
- Settings: `GET /api/settings`, `PUT /api/settings` (partial, validated by shared/settings.ts),
  `GET /api/settings/providers` -> which keys are present (never the values).
- Autopilot: `GET /api/autopilot` -> { on, liveMode, lastTick, nextTick, today: {discovered,
  enriched, enrolled, sent, queued, replied, booked, joined}, jobs: last run per job },
  `POST /api/autopilot/start`, `POST /api/autopilot/stop`, `POST /api/autopilot/tick` (run now),
  `GET /api/activity?limit=` (activity_log newest first).
- Public (no auth, used in emails): `GET /u/:token` one-click unsubscribe page (also accepts POST
  for List-Unsubscribe-Post), `GET /r/:token/:dest` tracked redirect: dest 'demo' -> settings.demo_url,
  'beta' -> settings.beta_url, 'site' -> settings.site_url; records a click event, appends
  `?utm_source=outreach&utm_medium=<channel>&utm_campaign=<sequence>&ref=<lead_id>`.
- Webhooks: `POST /api/webhooks/outcome` with header `x-outreach-secret` = settings.webhook_secret,
  body { email?, lead_id?, kind: 'demo_booked' | 'beta_joined' } (for the main app later).
- Auth: single shared password (`APP_PASSWORD` env). Cookie session. Public routes above exempt.

Errors: `{ error: string, code?: string }` with 4xx/5xx. Validate every body with zod.

## 7. Settings (shared/settings.ts, all with defaults)

```
autopilot_on: false
live_mode: false
owner_name: 'Theo Young'            owner_email: 'theo@proparchive.biz'
from_name: 'Theo at Prop Archive'   from_email: 'theo@proparchive.biz'   reply_to: same
physical_address: ''                  (CAN-SPAM footer; required before live email)
site_url: 'https://proparchive.app'  demo_url: 'https://proparchive.app/demo'
beta_url: 'https://proparchive.app/?join=beta'   (verify; fall back to site_url)
target_zips: ['19104','19121','19122','19139','19143','19146','19125']
min_props: 3   max_props: 20   min_icp_score: 50
personas: ['maya','ray','denise']
channels: { email: true, mail: false, linkedin: true, instagram: false, call: true }
daily_caps: { email: 20, mail: 10, linkedin: 15, instagram: 10, call: 10 }
send_window: { tz: 'America/New_York', days: [1,2,3,4,5], start: '08:30', end: '17:00' }
max_new_leads_per_day: 50
enrichment: { providers: ['li_license','claude_research','hunter','apollo','pdl'],
              monthly_credit_cap: { hunter: 50, apollo: 100, pdl: 50, claude_research: 200 } }
sequence_by_persona: { maya: { email: id|null, mail: id|null, linkedin: id|null, call: id|null }, ray: {...}, denise: {...} }
email_provider: 'smtp' | 'resend'   mail_provider: 'lob' | 'print'
notify_owner_on_reply: true          human_queue_webhook_url: ''
webhook_secret: random on first boot
```

Env keys (`.env.example`): `APP_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL` (managed by Replit),
`ANTHROPIC_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `RESEND_API_KEY`,
`IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `LOB_API_KEY`, `HUNTER_API_KEY`,
`APOLLO_API_KEY`, `PDL_API_KEY`, `PORT=5300`.

## 8. Lead sources (server/sources)

**OPA owners** (Philadelphia property assessments, Carto SQL API, no key):
`https://phl.carto.com/api/v2/sql?q=<sql>` over table `opa_properties_public`. Columns that exist:
`owner_1, owner_2, mailing_street, mailing_city_state, mailing_zip, mailing_address_1,
mailing_address_2, location, zip_code, category_code_description, sale_date, sale_price,
market_value, parcel_number, unit`. (There is no `number_of_units` column.) Categories seen:
'SINGLE FAMILY', 'MULTI FAMILY', 'MIXED USE', 'APARTMENTS  > 4 UNITS', 'COMMERCIAL', 'VACANT LAND'.
Query owners by grouping on normalised `mailing_street + mailing_zip` (and owner_1) across the
target zips, keep groups with min_props..max_props properties in residential categories, pull
their parcels. In the 7 default zips this is about 1,900 owners. Paginate with LIMIT/OFFSET;
be polite (serial requests, 250 ms apart).

**L&I rental licenses** (table `business_licenses`, `licensetype='Rental'`): columns include
`address, zip, opa_account_num, opa_owner, owneroccupied, licensenum, rentalcategory,
initialissuedate, mostrecentissuedate, expirationdate, licensestatus, numberofunits,
legalfirstname, legallastname, legalname, legalentitytype, business_name,
business_mailing_address, ownercontact1name, ownercontact1mailingaddress, ownercontact1city,
ownercontact1state, ownercontact1zippostalcode, ownercontact2name, ...`. Use it two ways:
1. Trigger: `initialissuedate` within the last N days in target zips = brand-new landlord license
   (`trigger.type='new_license'`). About 2,800 city-wide since July 2026.
2. Enrichment: join on `opa_account_num` = OPA `parcel_number` to turn an LLC owner into a human
   (legalfirstname/legallastname or ownercontact1name) and get `numberofunits` per property.
   This is the `li_license` enrichment provider: free, first in line.

**Recent sales trigger**: OPA `sale_date` within last 90 days in target zips, residential
categories (`trigger.type='recent_sale'`).

**CSV import**: Theo's existing ~600 leads. Columns are unknown; auto-map by header name
(name, first, last, email, phone, company, address, city, state, zip, linkedin, notes, units,
properties). Merge by dedupe_key; never overwrite a non-empty field with an empty one. Report
created/merged/skipped.

Dedupe/merge (`server/sources/merge.ts`): normalise street (uppercase, strip punctuation,
collapse spaces, expand ST/AVE/RD consistently), zip to 5 digits, names to Title Case, LLC
suffix detection sets owner_kind.

## 9. Enrichment (server/enrich)

Provider interface:
```ts
interface EnrichProvider {
  id: 'li_license' | 'claude_research' | 'hunter' | 'apollo' | 'pdl';
  isConfigured(env): boolean;
  costPerCall: number;              // credits, for caps
  enrich(lead, ctx): Promise<Partial<LeadContactFields> & { raw: unknown; confidence: number }>;
}
```
Orchestrator runs providers in settings order, stops when the lead has email AND (linkedin OR
phone), respects `monthly_credit_cap` (count calls in `activity_log` or a `provider_usage` table),
stores raw payloads under `leads.enrichment[provider]`, recomputes `channels`, sets status
'enriched'. Never overwrite a verified email with an unverified one.

- `li_license`: described above, free.
- `claude_research`: `@anthropic-ai/sdk`, `claude-haiku-5-5`, `output_config.effort: 'low'`,
  tools `[{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]`, structured output
  schema { full_name, company, website, linkedin_url, instagram_url, business_email,
  business_phone, confidence, sources: string[] }. Prompt: find the public business presence
  of "<owner or LLC> Philadelphia landlord/property owner", only return what a source states,
  never guess emails. Also used to pick a first name for an LLC when L&I has none.
- `hunter`: `GET https://api.hunter.io/v2/email-finder?domain=&first_name=&last_name=&api_key=`
  and `GET /v2/email-verifier?email=`. Only when a website domain is known.
- `apollo`: `POST https://api.apollo.io/api/v1/people/match` (header `x-api-key`), body
  { first_name, last_name, organization_name, domain, reveal_personal_emails: false }.
  Best for Denise (management companies).
- `pdl`: `GET https://api.peopledatalabs.com/v5/person/enrich?name=&company=&location=Philadelphia`
  header `X-Api-Key`.
All providers: 10 s timeout, retries 2 with backoff on 429/5xx, errors logged to activity_log and
never crash the batch. Each provider has a unit test with a mocked fetch.

## 10. Outreach (server/outreach)

**Templates**: body text with `{{first_name}}`, `{{full_name}}`, `{{company}}`, `{{property_count}}`,
`{{unit_count}}`, `{{neighborhood}}` (from zip via a small map: 19104 University City, 19121 Brewerytown/North Philly,
19122 Temple area, 19139 West Philly, 19143 Southwest Philly, 19146 Point Breeze/Graduate Hospital, 19125 Fishtown/Kensington),
`{{trigger_line}}` (one sentence from the trigger, empty when none), `{{demo_link}}`, `{{beta_link}}`,
`{{site_link}}`, `{{sender_name}}`, `{{unsubscribe_link}}`. Missing var renders empty and logs a warn.
Optional AI first line: when `ANTHROPIC_API_KEY` exists and a step body contains `{{ai_opener}}`,
generate one plain sentence (`claude-haiku-5-5`, effort low, max 60 tokens) grounded ONLY in the lead's
known facts (property count, neighborhood, trigger); never invent facts.

**Email sender**: nodemailer SMTP (`SMTP_*`) or Resend (`RESEND_API_KEY`). Plain-text body plus a
minimal HTML twin. Headers: `List-Unsubscribe: <mailto:...>, <https://host/u/token>`,
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Footer appended to every email:
`\n\n{{sender_name}}, Prop Archive LLC\n{{physical_address}}\nNo more emails: {{unsubscribe_link}}`.
Refuse to send when `physical_address` is empty (activity_log error, message stays queued).

**Mail sender**: `lob` -> `POST https://api.lob.com/v1/postcards` (or `/v1/letters` for bodies over
350 chars) with Basic auth `LOB_API_KEY:`; `print` -> message becomes `ready_for_human` under channel
'mail' and `GET /api/queue/print?ids=` returns an HTML page formatted for printing (one letter per
page, address block, body, hand-sign line).

**Human channels** (linkedin, instagram, call): rendering creates a `ready_for_human` message with
the profile URL or phone and the text. If `human_queue_webhook_url` is set, POST the message JSON
there once (idempotent on message id).

**Scheduling**: `next_send_at` = now when enrolling, then `sent_at + delay_days` moved into the
next send window with a random 0-25 minute jitter. Daily caps per channel count `sent` plus
`ready_for_human` created today.

**Replies** (`server/outreach/replies.ts`): IMAP (`IMAP_*`) search INBOX since last sync; match
by `In-Reply-To`/`References` to our `provider_message_id`, else by From address to a contacted
lead. Create an inbound message, classify (Claude structured output, effort low; fallback keyword
rules: unsubscribe/stop/remove -> 'unsubscribe', mailer-daemon/undeliverable -> 'bounce',
"book"/"demo"/"call" + positive -> 'interested'), stop all active enrollments for the lead, set
lead status, add suppression for 'unsubscribe' and 'bounce', write an event, and when
`notify_owner_on_reply` send Theo one email "Reply from <name>: <first 200 chars>". Theo answers
replies himself. The system never auto-replies.

## 11. Autopilot (server/autopilot)

`tick()` every 60 s when `autopilot_on`. Each job takes a `job_runs` lock, is idempotent, and
logs one activity line with counts. Order inside a tick:
1. `discover` (once per day, or when `POST /api/leads/discover`): sources -> leads, capped by
   `max_new_leads_per_day`, scored, persona set.
2. `enrich` (every tick, batch of 10): leads with status 'new', icp_score >= min_icp_score,
   persona in settings.personas, not do_not_contact.
3. `enroll` (every tick): enriched leads with no enrollment -> for each enabled channel the lead
   supports, enroll in `sequence_by_persona[persona][channel]` (skip null). Email first; if no
   email but mailing address and mail enabled -> mail. LinkedIn/call enrollments run in parallel
   with email, offset by 1 day.
4. `send` (every tick, inside send window only): due steps -> render -> live_mode ? send : dry_run
   row; human channels -> ready_for_human regardless of live_mode (nothing leaves without Theo).
   Caps enforced. Advance enrollment; mark 'done' after the last step.
5. `sync_replies` (every 10 minutes): section 10.
6. `housekeeping` (hourly): expire stale `running` job locks, roll daily counters.

Go page shows the last tick, next tick, and a live feed (poll `/api/activity` every 5 s).

## 12. UI (client)

Left nav, four entries, big labels: **Leads**, **Sequences**, **Settings**, **Go**. Top right: a pill
"Dry run" (grey) or "Live" (green), and "Autopilot on/off". Login page with one password field.

**Leads**: filter chips across the top: Not enriched | Enriched | In sequence | Replied |
Booked or joined | Everyone. Search box. Table: name (or company), persona badge, properties/units,
neighbourhood, channel icons (lit when available), status, last activity. Checkbox per row.
Buttons: "Find new leads", "Import CSV", "Enrich selected", "Enrich all not enriched",
"Start sequence" (picks by persona automatically, shows which). Row click opens a side panel: all
contact fields with copy buttons, properties list, timeline of messages and events, notes, buttons
"Stop outreach", "Do not contact", "Booked a demo", "Joined the beta", "Not interested".

**Sequences**: list grouped by channel, each card shows persona, trigger, steps count, active
toggle, how many leads are in it. Edit view: name, channel, persona, trigger, steps (delay, subject,
body textarea, live preview rendered for a sample lead on the right), "Send me a test". Variables
listed as chips you click to insert.

**Settings**: plain sections. "Who you are" (names, emails, physical address), "Who to target"
(zips as chips, min/max properties, personas checkboxes, min score), "Channels" (toggle + daily cap
per channel, send window), "Finding people" (providers on/off, monthly caps, shows "key missing"
when env lacks it), "Links" (site, demo, beta), "Danger" (Live mode toggle with a confirm dialog
that lists what will go out; Reset today's counters). Save button sticky at bottom.

**Go**: a very big switch "Autopilot" with a one-line status under it ("Dry run: nothing is sent,
everything is queued" or "Live: email and mail go out in the send window"). Today's numbers in big
tiles (found, enriched, in sequence, sent, waiting for you, replied, booked, joined). Then "Waiting
for you" queue: one card per ready message with the person, channel, the text, Copy button, "Open
profile" or "Call" link, "Done" and "Skip". Then the live activity feed.

## 13. Content (content/, server/seed)

Default sequences, written in Theo's plain voice, pain first then the fix, one ask, no jargon,
short. Each has persona variants (maya/ray/denise) and trigger variants (new_license, recent_sale,
none). Channels: email 3 steps (day 0, 3, 8), mail 1 step (postcard, under 350 chars), linkedin 2
steps (connection note under 300 chars, then message), call 1 step (script with the 10 second
open, 3 discovery questions, the ask). The ask is always one of: a 15 minute demo (demo_link) or
join the beta (beta_link). Both are mentioned at most once per message. Seed inserts them with
`active=true` and fills `settings.sequence_by_persona`.

## 14. Quality gates (all must pass before the branch is done)

- `npm run check` (tsc, strict), `npm test`, `npm run lint`, `npm run format:check`, `npm run build`.
- `npm run dev` boots with an empty `.env` (only APP_PASSWORD) and the UI renders every page.
- Unit tests: scoring, merge/dedupe, template rendering, send window and caps, idempotency,
  CAN-SPAM footer, suppression, reply classification fallback, provider parsing with mocked fetch,
  OPA/L&I SQL builders, CSV header mapping.
- API tests with supertest against an in-memory db: leads list/filter, import, settings validate,
  autopilot start/stop, tick in dry run creates dry_run messages and ready_for_human queue items.
- A `scripts/smoke.ts` that boots the server on a random port, logs in, imports a sample CSV,
  runs a tick in dry run, and asserts the queue is non-empty.
