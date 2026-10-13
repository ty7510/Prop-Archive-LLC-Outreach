// Go: the big Autopilot switch, today's numbers, the "Waiting for you" queue, the live feed.
import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Phone, Printer, Play, SkipForward, Check, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import type { ActivityEntry, AutopilotStatus, Channel, QueueItem, TodayCounts } from '@shared/types'
import {
  getActivity,
  getAutopilot,
  getQueue,
  getSettings,
  printQueueUrl,
  queueDone,
  queueSkip,
  startAutopilot,
  stopAutopilot,
  tickAutopilot,
} from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { Toggle, Badge } from '../components/Field.tsx'
import CopyButton from '../components/CopyButton.tsx'
import NotBuilt from '../components/NotBuilt.tsx'
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
          {liveMode
            ? 'Live: email and mail go out in the send window'
            : 'Dry run: nothing is sent, everything is queued'}
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
          {!liveMode ? (
            <Link href="/settings#danger" className="btn-secondary">
              Turn on Live mode
            </Link>
          ) : null}
        </div>
        {switchNotBuilt ? <NotBuilt what="Starting and stopping the autopilot." /> : null}
      </section>

      <section>
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

      <WaitingForYou />

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

function WaitingForYou() {
  const q = useQuery({ queryKey: ['queue'], queryFn: getQueue, refetchInterval: 15_000 })
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2>Waiting for you</h2>
        {q.data ? <span className="text-stone-600">{q.data.total} to do</span> : null}
      </div>
      <QueryView
        q={q}
        loading="Loading your queue"
        isEmpty={(d) => d.total === 0}
        empty={
          <Empty
            title="Nothing waiting for you"
            hint="LinkedIn notes, Instagram messages, calls and postcards to print show up here when a step is due."
          />
        }
      >
        {(data) => (
          <div className="space-y-6">
            {QUEUE_ORDER.filter((ch) => (data.groups[ch]?.length ?? 0) > 0).map((ch) => (
              <QueueGroup key={ch} channel={ch} items={data.groups[ch] ?? []} />
            ))}
          </div>
        )}
      </QueryView>
    </section>
  )
}

function QueueGroup({ channel, items }: { channel: Channel; items: QueueItem[] }) {
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-lg font-medium">
        <ChannelIcon channel={channel} className="text-stone-500" />
        {CHANNEL_LABEL[channel]} <span className="text-stone-500">({items.length})</span>
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
