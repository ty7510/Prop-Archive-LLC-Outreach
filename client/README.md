# Client (React + Vite + Tailwind)

The browser side of the outreach system. Spec section 12 is the contract; this file says what each
screen does and what it expects from the API (spec section 6, types in `shared/types.ts`).

## Layout

- `index.html`, `src/main.tsx`: React root, react-query client (no retry on 4xx or 501), toast provider.
- `src/App.tsx`: wouter routes, left nav (Leads, Sequences, Settings, Go), the "Dry run / Live" and
  "Autopilot on/off" pills (poll `/api/health` every 15 s), login guard via `/api/me`.
- `src/api.ts`: one typed helper per endpoint. All errors are `ApiRequestError { status, code }`;
  `isNotBuilt(err)` is true for 501 `NOT_BUILT`.
- `src/types.ts`: client view of the server rows (Lead, LeadDetail, Sequence with steps, ...).
- `src/hooks/useAction.ts`: wraps any API call for a button: busy flag, success toast, error toast,
  and a `notBuilt` flag. Pages render `<NotBuilt />` ("This part is still being built") from that flag
  instead of an error toast.
- `src/components/`: `Toast`, `NotBuilt`, `QueryState` (Loading, Empty, ErrorNote, QueryView),
  `CopyButton`, `Confirm` (+ `Modal`), `Field` (Field, Toggle, Chip, Badge, Section), `ChannelIcons`,
  `LeadPanel`, `SequenceEditor`.
- `src/lib/`: pure helpers with vitest tests: `format` (labels, neighbourhood map, relative time,
  en dash for empty cells), `template` (variable list, local `{{var}}` render, caret insert),
  `pickSequence` (which sequence "Start sequence" picks for a lead).

Tailwind only, lucide-react icons, no component library. Every tap target is at least 44 px. The
layout works at 390 px wide with no horizontal page scroll (tables become cards below `md`).
No em-dash appears in any UI text; empty cells show an en dash.

## Screens

### Login (`/login`)

One password field, posts to `/api/login`. 503 `NO_PASSWORD` and 401 show the server's message.

### Leads (`/leads`, `/leads?id=<lead>`)

- Filter chips: Not enriched (`new`, `enriching`), Enriched, In sequence (`enrolled`, `contacted`),
  Replied, Booked or joined (`booked`, `joined`), Everyone. A chip with several statuses runs one
  `GET /api/leads?status=` per status (the API takes one status) and merges the pages.
- Search box (debounced 300 ms) sends `q=`.
- Table on desktop, cards on phones: checkbox, name (or company), persona badge, properties / units,
  neighbourhood (first property zip, else mailing zip, via the zip map), channel icons lit when
  `lead.channels[x]` is true, status badge, last activity. Previous / Next paging, 50 per page.
- Buttons: Find new leads (`POST /api/leads/discover {}`), Import CSV (hidden file input, multipart
  `file`, result line shows rows / created / merged / skipped / first errors), Enrich selected
  (`POST /api/leads/enrich { ids }`), Enrich all not enriched (`{ all: true }`), Start sequence.
- Start sequence: for each selected lead `pickSequence` reads `settings.sequence_by_persona[persona]`
  and `settings.channels`, prefers the first enabled channel the lead can use (email, mail, linkedin,
  instagram, call), falls back to the first configured channel when the lead is not enriched yet. A
  confirm dialog lists lead -> sequence (channel) and the reason for any lead that is skipped. Confirm
  posts `POST /api/leads/:id/enroll { sequence_id }` one at a time.
- Row click opens the side panel (`?id=` in the URL so Go page links land here):
  `GET /api/leads/:id`. Shows persona / status / fit score / trigger badges, contact rows with copy
  buttons and open / call links, properties, timeline (messages and events merged, newest first,
  tap a message to read it), notes with Save (`PATCH notes`), tags, and buttons: Start sequence
  (shows which), Stop outreach (`POST /:id/stop`), Do not contact / Allow contact (`PATCH
do_not_contact`), Booked a demo, Joined the beta, Not interested (`POST /:id/outcome { kind }`).

### Sequences (`/sequences`, `/sequences/new`, `/sequences/:id`)

- List: cards grouped by channel. Each card shows persona, trigger, step count, description, how
  many leads are in it (`enrolled_count`, en dash until the API sends it), an Active / Paused toggle
  (`PUT /api/sequences/:id { active }`) and an Edit button.
- Editor: name, channel, persona, trigger, active, description, then one card per step (delay days,
  subject for email, body, notes, character count), Add a step, Remove step. Variable chips insert
  `{{name}}` at the caret of the last focused subject or body field. The right column is the preview:
  `POST /api/sequences/:id/preview` for a saved sequence, or a local render of the unsaved draft with
  sample values (unknown variables are flagged). Sticky bottom bar: Save changes / Create sequence
  (`PUT` / `POST`), Send me a test (`POST /:id/test-send`, toast names `settings.owner_email`),
  Delete with a confirm (`DELETE`).

### Settings (`/settings`, `/settings#danger`)

Loads `GET /api/settings` into a draft. The sticky bottom bar shows "Save N changes" and sends only
the top-level keys that changed (`PUT /api/settings`), plus Discard. Sections:

- Who you are: names, emails, physical address (amber border while empty).
- Who to target: zips as removable chips with an add box (five digits), min / max properties,
  minimum fit score, new leads per day, persona checkboxes.
- Channels: toggle + per-day cap for each channel; email provider (SMTP / Resend) and mail provider
  (Print myself / Lob) with a "Key found" / "Key missing: add X to .env" badge from
  `GET /api/settings/providers`; send window as day chips, from / until times, time zone.
- Finding people: each enrichment provider on / off (the order is fixed to the spec order), monthly
  caps, key badges; IMAP key badge for reading replies.
- Which sequence each persona gets: persona x channel selects filled from `GET /api/sequences`
  (sequences for that persona or "any"), writes `sequence_by_persona`.
- Links: site, demo, beta; email me on reply; human queue webhook URL; webhook secret with Copy.
- Danger: Live mode toggle. Turning it on opens a confirm that lists exactly what goes out (channels,
  caps, provider, missing keys, send window, empty-address warning) and then saves `live_mode` on its
  own, independent of other unsaved edits. Turning it off saves straight away. Reset today's counters
  calls `POST /api/autopilot/reset-today` (not in the spec; a 404 or 501 shows the "still being
  built" note; the integrator can add the route or drop the button).

### Go (`/go`)

- A very big Autopilot switch (`POST /api/autopilot/start|stop`), a one-line status ("Dry run:
  nothing is sent, everything is queued" or "Live: email and mail go out in the send window"),
  last / next round, "Run one round now" (`POST /api/autopilot/tick`) and a shortcut to Live mode.
- Today: eight tiles from `GET /api/autopilot` (Found, Enriched, In sequence, Sent, Waiting for you,
  Replied, Booked, Joined), then one pill per job with its last run.
- Waiting for you: `GET /api/queue` (15 s), grouped call, linkedin, instagram, mail, email. Each card:
  person, company, channel, sequence and step, subject, text, Copy text, Open profile (linkedin /
  instagram), Call (tel: link), Print letter (`/api/queue/print?ids=`), Done and Skip
  (`POST /api/queue/:id/done|skip`). Mail groups with several letters get Print all.
- Live feed: `GET /api/activity?limit=100` every 5 s, level dot, event, short detail, lead link, time.

## Loading, empty, error, not built

Every query renders a spinner while loading, a plain empty state, and an error box with Try again.
When the server answers 501 `NOT_BUILT` the page shows the dashed "This part is still being built"
note in place of the data (queries) or under the button (actions). Nothing retries a 4xx or a 501.

## Tests

`npm test` runs the `client/src/lib/*.test.ts` files along with the server tests (vitest, node
environment, no DOM needed). `npm run check` type-checks the client with `tsconfig.json`;
`npm run build` produces `dist/client`.
