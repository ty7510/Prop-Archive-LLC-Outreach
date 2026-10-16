// Go: the big Autopilot switch, today's numbers, the "Waiting for you" queue, the live feed.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExternalLink,
  Mail,
  Phone,
  Printer,
  Play,
  SkipForward,
  Check,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import clsx from 'clsx'
import type {
  ActivityEntry,
  AutopilotStatus,
  Channel,
  LinkedInWanted,
  Queue,
  QueueItem,
  TodayCounts,
} from '@shared/types'
import {
  getActivity,
  getAutopilot,
  getQueue,
  getSettings,
  printQueueUrl,
  queueDone,
  queueRestore,
  queueSkip,
  startAutopilot,
  stopAutopilot,
  tickAutopilot,
} from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { Toggle, Badge } from '../components/Field.tsx'
import CopyButton from '../components/CopyButton.tsx'
import LinkedInPaste from '../components/LinkedInPaste.tsx'
import LinkedInRun from '../components/LinkedInRun.tsx'
import ReplyForm from '../components/ReplyForm.tsx'
import NotBuilt from '../components/NotBuilt.tsx'
import { CompleteSection, RepliedSection, TodoSection } from '../components/TodoSections.tsx'
import { Empty, ErrorNote, Loading, QueryView } from '../components/QueryState.tsx'
import { ChannelIcon } from '../components/ChannelIcons.tsx'
import {
  CHANNEL_LABEL,
  ensureHttp,
  humanise,
  relativeTime,
  shortDateTime,
  telHref,
} from '../lib/format.ts'

const TILES: { key: keyof TodayCounts; label: string }[] = [
  { key: 'discovered', label: 'Found' },
  { key: 'enriched', label: 'Enriched' },
  { key: 'enrolled', label: 'In sequence' },
  { key: 'sent', label: 'Sent' },
  { key: 'queued', label: 'Waiting for you' },
  { key: 'replied', label: 'Replied' },
  { key: 'booked', label: 'Booked' },
  { key: 'joined', label: 'Joined' },
]

const QUEUE_ORDER: Channel[] = ['call', 'linkedin', 'instagram', 'mail', 'email']

export default function Go() {
  const qc = useQueryClient()
  const auto = useQuery({ queryKey: ['autopilot'], queryFn: getAutopilot, refetchInterval: 15_000 })
  const liveMode = auto.data?.liveMode ?? false
  const on = auto.data?.on ?? false
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const emailOn = settings.data?.channels.email ?? false
  // Timed sequences off: the to-do list with every step per person (Theo, 2026-10-16).
  const todoMode = settings.data ? !settings.data.sequences_on : false

  const applyStatus = (s: AutopilotStatus) => {
    void qc.invalidateQueries({ queryKey: ['readiness'] })
    qc.setQueryData(['autopilot'], s)
    void qc.invalidateQueries({ queryKey: ['health'] })
  }
  const start = useAction(startAutopilot, { success: 'Autopilot is on', onSuccess: applyStatus })
  const stop = useAction(stopAutopilot, { success: 'Autopilot is off', onSuccess: applyStatus })
  const tick = useAction(tickAutopilot, {
    success: 'Ran one round',
    onSuccess: applyStatus,
    invalidate: [['queue'], ['activity']],
  })
  const switchBusy = start.busy || stop.busy
  const switchNotBuilt = start.notBuilt || stop.notBuilt || tick.notBuilt

  return (
    <div className="space-y-6">
      <section className="card flex flex-col items-center gap-3 py-8 text-center">
        <Toggle
          size="xl"
          checked={on}
          disabled={switchBusy || auto.isLoading}
          onChange={(next) => void (next ? start.run() : stop.run())}
          label="Autopilot"
        />
        <p className="text-lg text-stone-700">
          {todoMode
            ? `Each weekday up to ${settings.data?.people_per_day ?? 0} people go on your list below, with their LinkedIn found and their note written. The app sends nothing itself.`
            : !liveMode
              ? 'Dry run: nothing is sent, everything is queued'
              : emailOn
                ? 'Live: email and mail go out in the send window'
                : "Live: each weekday, today's LinkedIn notes and postcards show up below"}
        </p>
        {auto.data ? (
          <p className="text-sm text-stone-500">
            Last round {relativeTime(auto.data.lastTick)}
            {auto.data.on && auto.data.nextTick ? `, next ${relativeTime(auto.data.nextTick)}` : ''}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void tick.run()}
            disabled={tick.busy}
          >
            {tick.busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Play className="h-4 w-4" aria-hidden />
            )}
            Run one round now
          </button>
          {!liveMode && !todoMode ? (
            <Link href="/settings#danger" className="btn-secondary">
              Turn on Live mode
            </Link>
          ) : null}
        </div>
        {switchNotBuilt ? <NotBuilt what="Starting and stopping the autopilot." /> : null}
      </section>

      <section hidden={todoMode}>
        <h2 className="mb-3">Today</h2>
        <QueryView q={auto} loading="Loading today's numbers">
          {(s) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TILES.map((t) => (
                <div key={t.key} className="card flex flex-col items-start py-5">
                  <span className="text-4xl font-semibold tabular-nums">{s.today[t.key]}</span>
                  <span className="mt-1 text-stone-600">{t.label}</span>
                </div>
              ))}
            </div>
          )}
        </QueryView>
        {auto.data ? <JobsLine jobs={auto.data.jobs} /> : null}
      </section>

      {todoMode ? (
        <>
          <TodoSection />
          <CompleteSection />
          <RepliedSection />
        </>
      ) : (
        <>
          <WaitingForYou />
          <WroteBack />
        </>
      )}

      <LiveFeed />
    </div>
  )
}

function JobsLine({ jobs }: { jobs: AutopilotStatus['jobs'] }) {
  const entries = Object.values(jobs)
  if (entries.length === 0) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-2 text-sm text-stone-600">
      {entries.map((j) => (
        <li
          key={j.job}
          className="flex items-center gap-1 rounded-full bg-white px-3 py-1 ring-1 ring-stone-200"
        >
          <span
            className={clsx(
              'h-2 w-2 rounded-full',
              j.status === 'ok'
                ? 'bg-emerald-500'
                : j.status === 'error'
                  ? 'bg-red-500'
                  : 'bg-sky-500',
            )}
            aria-hidden
          />
          {humanise(j.job)}{' '}
          {j.status === 'running' ? 'running' : relativeTime(j.finished_at ?? j.started_at)}
          {j.error ? (
            <span className="text-red-700" title={j.error}>
              {' '}
              (failed)
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** The pop-up opens by itself once per browser session when LinkedIn notes are waiting. */
const RUN_SHOWN_KEY = 'linkedin-run-shown'

function runShown(): boolean {
  try {
    return sessionStorage.getItem(RUN_SHOWN_KEY) === '1'
  } catch {
    return false
  }
}

function markRunShown(): void {
  try {
    sessionStorage.setItem(RUN_SHOWN_KEY, '1')
  } catch {
    // Private windows can refuse storage; the pop-up then opens on each visit.
  }
}

function WaitingForYou() {
  const q = useQuery({ queryKey: ['queue'], queryFn: getQueue, refetchInterval: 15_000 })
  const [runOpen, setRunOpen] = useState(false)
  const linkedInWaiting = q.data?.groups.linkedin?.length ?? 0
  useEffect(() => {
    if (linkedInWaiting > 0 && !runShown()) {
      markRunShown()
      setRunOpen(true)
    }
  }, [linkedInWaiting])
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2>Waiting for you</h2>
        {q.data ? <span className="text-stone-600">{q.data.total} to do</span> : null}
      </div>
      <QueryView
        q={q}
        loading="Loading your queue"
        isEmpty={(d) =>
          d.total === 0 && d.skipped_recently.length === 0 && d.linkedin_wanted.length === 0
        }
        empty={
          <Empty
            title="Nothing waiting for you"
            hint="LinkedIn notes, Instagram messages, calls and postcards to print show up here when a step is due."
          />
        }
      >
        {(data) => (
          <div className="space-y-6">
            <LinkedInRun
              open={runOpen}
              onClose={() => setRunOpen(false)}
              items={data.groups.linkedin ?? []}
              wanted={data.linkedin_wanted}
              today={data.today.linkedin}
            />
            {(data.groups.linkedin?.length ?? 0) > 0 || data.linkedin_wanted.length > 0 ? (
              <button type="button" className="btn-primary" onClick={() => setRunOpen(true)}>
                <ChannelIcon channel="linkedin" /> Send LinkedIn notes one by one
              </button>
            ) : null}
            {data.total === 0 ? (
              <p className="card text-stone-700">
                Nothing to send right now. New LinkedIn notes and postcards show up here on weekdays
                during the send window.
              </p>
            ) : null}
            {QUEUE_ORDER.filter((ch) => (data.groups[ch]?.length ?? 0) > 0).map((ch) => (
              <QueueGroup
                key={ch}
                channel={ch}
                items={data.groups[ch] ?? []}
                today={data.today[ch]}
              />
            ))}
            {data.linkedin_wanted.length > 0 &&
            (data.groups.linkedin?.length ?? 0) + (data.today.linkedin?.done ?? 0) <
              (data.today.linkedin?.goal ?? 0) ? (
              <FindOnLinkedIn people={data.linkedin_wanted} today={data.today.linkedin} />
            ) : null}
            {data.skipped_recently.length > 0 ? (
              <SkippedRecently items={data.skipped_recently} />
            ) : null}
          </div>
        )}
      </QueryView>
    </section>
  )
}

function QueueGroup({
  channel,
  items,
  today,
}: {
  channel: Channel
  items: QueueItem[]
  today?: Queue['today'][Channel]
}) {
  return (
    <div>
      <h3 className="mb-2 flex flex-wrap items-center gap-2 text-lg font-medium">
        <ChannelIcon channel={channel} className="text-stone-500" />
        {CHANNEL_LABEL[channel]} <span className="text-stone-500">({items.length})</span>
        {today && today.goal > 0 ? (
          <span className="text-base font-normal text-stone-600">
            {today.done} of {today.goal} done today
          </span>
        ) : null}
        {channel === 'mail' && items.length > 1 ? (
          <a
            href={printQueueUrl(items.map((i) => i.message_id))}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary ml-auto"
          >
            <Printer className="h-4 w-4" aria-hidden /> Print all postcards
          </a>
        ) : null}
      </h3>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        {items.map((item) => (
          <QueueCard key={item.message_id} item={item} />
        ))}
      </div>
    </div>
  )
}

/** Tasks skipped in the last week, each with a way back: a skip by mistake is one click to undo. */
function SkippedRecently({ items }: { items: QueueItem[] }) {
  return (
    <details className="card">
      <summary className="min-h-tap cursor-pointer py-2 text-lg font-medium">
        Skipped recently ({items.length})
      </summary>
      <ul className="mt-2 divide-y divide-stone-200">
        {items.map((item) => (
          <SkippedRow key={item.message_id} item={item} />
        ))}
      </ul>
    </details>
  )
}

function SkippedRow({ item }: { item: QueueItem }) {
  const restore = useAction(queueRestore, {
    success: `${item.person} is back in your queue`,
    invalidate: [['queue'], ['autopilot'], ['activity']],
  })
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <ChannelIcon channel={item.channel} className="shrink-0 text-stone-500" />
        <span className="break-words">
          {item.person}
          {item.company ? <span className="text-stone-600">, {item.company}</span> : null}
        </span>
      </span>
      <button
        type="button"
        className="btn-secondary"
        disabled={restore.busy}
        onClick={() => void restore.run(item.message_id)}
      >
        <RotateCcw className="h-4 w-4" aria-hidden /> Bring back
      </button>
    </li>
  )
}

function postalAddress(raw: string | null): string | null {
  if (!raw || raw === 'null') return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o !== 'object' || o === null) return null
    const parts = ['name', 'street', 'address_line1', 'city', 'state', 'zip']
      .map((k) => o[k])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    return parts.length ? parts.join(', ') : raw
  } catch {
    return raw
  }
}

function QueueCard({ item }: { item: QueueItem }) {
  const [gone, setGone] = useState(false)
  const done = useAction(queueDone, {
    success: 'Marked done',
    invalidate: [['queue'], ['autopilot'], ['activity']],
  })
  const skip = useAction(queueSkip, {
    success: 'Skipped',
    invalidate: [['queue'], ['autopilot'], ['activity']],
  })
  const busy = done.busy || skip.busy
  const notBuilt = done.notBuilt || skip.notBuilt

  // The accounts Theo works these steps from, from Settings > Your accounts.
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const fromAccount =
    item.channel === 'linkedin'
      ? settings.data?.my_linkedin_url
      : item.channel === 'instagram'
        ? settings.data?.my_instagram
        : undefined

  const link = useMemo(() => {
    if (!item.to_address) {
      // No profile on file: search LinkedIn for them by name (Theo picks the right one).
      if (item.channel === 'linkedin') {
        const keywords = `${item.person} Philadelphia`
        return {
          href: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
          label: 'Find on LinkedIn',
          icon: ExternalLink,
        }
      }
      return null
    }
    if (item.channel === 'call')
      return { href: telHref(item.to_address), label: `Call ${item.to_address}`, icon: Phone }
    if (item.channel === 'linkedin' || item.channel === 'instagram')
      return { href: ensureHttp(item.to_address), label: 'Open profile', icon: ExternalLink }
    if (item.channel === 'mail')
      return { href: printQueueUrl([item.message_id]), label: 'Print postcard', icon: Printer }
    return null
  }, [item])

  if (gone) return null

  const copyText = item.subject ? `${item.subject}\n\n${item.body}` : item.body

  return (
    <article className="card flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link
            href={`/leads?id=${encodeURIComponent(item.lead_id)}`}
            className="text-lg font-medium hover:underline"
          >
            {item.person}
          </Link>
          {item.company ? <p className="text-stone-600">{item.company}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-stone-500">
          <Badge tone="blue">{CHANNEL_LABEL[item.channel]}</Badge>
          {item.sequence_name ? (
            <span>
              {item.sequence_name}
              {item.step_index !== null ? `, step ${item.step_index + 1}` : ''}
            </span>
          ) : null}
        </div>
      </header>
      {item.channel === 'mail' && postalAddress(item.to_address) ? (
        <p className="break-words text-sm text-stone-600">To: {postalAddress(item.to_address)}</p>
      ) : null}
      {fromAccount ? (
        <p className="break-words text-sm text-stone-600">Send from: {fromAccount}</p>
      ) : null}
      <ContactLine item={item} />
      {item.subject ? <p className="break-words font-medium">{item.subject}</p> : null}
      <p className="whitespace-pre-wrap break-words text-stone-800">{item.body}</p>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={copyText} label="Copy text" />
        {link ? (
          <a
            href={link.href}
            target={item.channel === 'call' ? undefined : '_blank'}
            rel="noreferrer"
            className="btn-secondary"
          >
            <link.icon className="h-4 w-4" aria-hidden /> {link.label}
          </a>
        ) : null}
        <button
          type="button"
          className="btn-primary ml-auto"
          disabled={busy}
          onClick={() => void done.run(item.message_id).then((r) => r && setGone(true))}
        >
          <Check className="h-4 w-4" aria-hidden /> Done
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => void skip.run(item.message_id).then((r) => r && setGone(true))}
        >
          <SkipForward className="h-4 w-4" aria-hidden /> Skip
        </button>
      </div>
      {notBuilt ? <NotBuilt what="Marking queue items done or skipped." /> : null}
    </article>
  )
}

/** Their phone and email, to call or write to them yourself. */
function ContactLine({ item }: { item: QueueItem }) {
  if (!item.phone && !item.email) return null
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-700">
      {item.phone ? (
        <a href={telHref(item.phone)} className="inline-flex items-center gap-1 underline">
          <Phone className="h-4 w-4" aria-hidden /> {item.phone}
        </a>
      ) : null}
      {item.email ? (
        <a
          href={`mailto:${item.email}`}
          className="inline-flex items-center gap-1 break-all underline"
        >
          <Mail className="h-4 w-4" aria-hidden /> {item.email}
        </a>
      ) : null}
    </p>
  )
}

/**
 * Under today's LinkedIn goal and nobody left with a profile: the best-fit people research found
 * no profile for. Theo looks them up and pastes the link; their note then comes up above.
 */
function FindOnLinkedIn({
  people,
  today,
}: {
  people: LinkedInWanted[]
  today?: Queue['today'][Channel]
}) {
  return (
    <details className="card" open>
      <summary className="min-h-tap cursor-pointer py-2 text-lg font-medium">
        Find more people on LinkedIn ({people.length})
      </summary>
      <p className="mt-1 text-stone-700">
        {today && today.goal > 0
          ? `${today.done} of ${today.goal} LinkedIn notes done today. `
          : ''}
        Research found no profile for these people. Search, open the right person, copy the link
        from the address bar and paste it here. Their note then shows up above.
      </p>
      <ul className="mt-3 divide-y divide-stone-200">
        {people.map((p) => (
          <li key={p.lead_id} className="space-y-2 py-3">
            <Link
              href={`/leads?id=${encodeURIComponent(p.lead_id)}`}
              className="font-medium hover:underline"
            >
              {p.person}
            </Link>
            {p.company && p.company !== p.person ? (
              <span className="text-stone-600">, {p.company}</span>
            ) : null}
            {p.city ? <span className="text-stone-600"> ({p.city})</span> : null}
            <LinkedInPaste leadId={p.lead_id} person={p.person} city={p.city} />
          </li>
        ))}
      </ul>
    </details>
  )
}

const SENT_WORD: Partial<Record<Channel, string>> = {
  linkedin: 'LinkedIn note',
  mail: 'Postcard',
  call: 'Call',
  instagram: 'Instagram message',
}

/** Everyone reached in the last month who has not answered: log a reply the day it comes in. */
function WroteBack() {
  const q = useQuery({ queryKey: ['queue'], queryFn: getQueue, refetchInterval: 15_000 })
  const items = q.data?.contacted_recently ?? []
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const shown = items.filter((i) => !hidden.has(i.lead_id))
  if (shown.length === 0) return null
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2>Did anyone write back?</h2>
        <span className="text-stone-600">{shown.length} reached in the last 30 days</span>
      </div>
      <p className="mb-3 text-stone-700">
        When someone answers your LinkedIn note, a postcard or a call, press They replied. Nothing
        more goes to them, and they move to Replied on the Leads page.
      </p>
      <ul className="card divide-y divide-stone-200">
        {shown.map((item) => (
          <li key={item.lead_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <ChannelIcon channel={item.channel} className="shrink-0 text-stone-500" />
            <span className="min-w-0 flex-1">
              <Link
                href={`/leads?id=${encodeURIComponent(item.lead_id)}`}
                className="font-medium hover:underline"
              >
                {item.person}
              </Link>
              <span className="block text-sm text-stone-600">
                {SENT_WORD[item.channel] ?? CHANNEL_LABEL[item.channel]}{' '}
                {item.channel === 'call' ? 'made' : 'sent'} {relativeTime(item.sent_at)}
              </span>
              <ContactLine item={item} />
            </span>
            <ReplyForm
              leadId={item.lead_id}
              person={item.person}
              channel={item.channel === 'instagram' ? 'linkedin' : item.channel}
              onSaved={() => setHidden((h) => new Set(h).add(item.lead_id))}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return ''
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object') {
    const entries = Object.entries(detail as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .slice(0, 6)
    return entries.map(([k, v]) => `${humanise(k).toLowerCase()} ${String(v)}`).join(', ')
  }
  return String(detail)
}

function LiveFeed() {
  const q = useQuery({
    queryKey: ['activity'],
    queryFn: () => getActivity(100),
    refetchInterval: 5_000,
  })
  return (
    <section>
      <h2 className="mb-3">Live feed</h2>
      {q.isLoading ? <Loading text="Loading the feed" /> : null}
      {q.isError ? <ErrorNote error={q.error} retry={() => void q.refetch()} /> : null}
      {q.data && q.data.length === 0 ? (
        <Empty title="Quiet so far" hint="Every job writes one line here when it runs." />
      ) : null}
      {q.data && q.data.length > 0 ? (
        <ol className="card divide-y divide-stone-100 p-0">
          {q.data.map((a) => (
            <FeedRow key={a.id} entry={a} />
          ))}
        </ol>
      ) : null}
    </section>
  )
}

function FeedRow({ entry }: { entry: ActivityEntry }) {
  const detail = detailText(entry.detail)
  return (
    <li className="flex gap-3 px-4 py-2.5">
      <span
        className={clsx(
          'mt-2 h-2.5 w-2.5 shrink-0 rounded-full',
          entry.level === 'error'
            ? 'bg-red-500'
            : entry.level === 'warn'
              ? 'bg-amber-500'
              : 'bg-emerald-500',
        )}
        aria-label={entry.level}
      />
      <div className="min-w-0 flex-1">
        <p className="break-words">
          <span className="font-medium">{humanise(entry.event)}</span>
          {detail ? <span className="text-stone-600">: {detail}</span> : null}
          {entry.lead_id ? (
            <>
              {' '}
              <Link
                href={`/leads?id=${encodeURIComponent(entry.lead_id)}`}
                className="text-emerald-700 underline"
              >
                lead
              </Link>
            </>
          ) : null}
        </p>
      </div>
      <time
        dateTime={entry.at}
        className="shrink-0 text-sm text-stone-500"
        title={shortDateTime(entry.at)}
      >
        {relativeTime(entry.at)}
      </time>
    </li>
  )
}
