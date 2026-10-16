// The Go page when timed sequences are off: To do (every step per person), Complete (waiting for a
// reply until they come back), Replied (everyone who answered).
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { ListChecks, Loader2, Printer, Tag, UserPlus } from 'lucide-react'
import type { TodoList } from '@shared/types'
import { fillTodoNow, getTodo, printLabelsUrl, printQueueUrl } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { CHANNEL_LABEL, relativeTime, shortDateTime } from '../lib/format.ts'
import { Empty, QueryView } from './QueryState.tsx'
import ReplyForm from './ReplyForm.tsx'
import TodoCard from './TodoCard.tsx'
import TodoRun from './TodoRun.tsx'

/** The pop-up opens by itself once per browser session when people are waiting. */
const RUN_SHOWN_KEY = 'todo-run-shown'

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

export function useTodo() {
  return useQuery({ queryKey: ['todo'], queryFn: getTodo, refetchInterval: 15_000 })
}

export function TodoSection() {
  const q = useTodo()
  const [runOpen, setRunOpen] = useState(false)
  const waiting = q.data?.people.length ?? 0
  useEffect(() => {
    if (waiting > 0 && !runShown()) {
      markRunShown()
      setRunOpen(true)
    }
  }, [waiting])
  const fill = useAction(fillTodoNow, {
    success: (r) =>
      r.added > 0
        ? `${r.added} ${r.added === 1 ? 'person' : 'people'} added`
        : r.reason === 'not a send day'
          ? 'New people are added on weekdays'
          : "Today's people are already on your list",
    invalidate: [['todo'], ['activity']],
  })

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2>To do</h2>
        {q.data ? (
          <span className="text-stone-600">
            {q.data.people.length} {q.data.people.length === 1 ? 'person' : 'people'} ·{' '}
            {q.data.today.added} of {q.data.today.goal} new today
          </span>
        ) : null}
      </div>
      <QueryView q={q} loading="Loading your list">
        {(data) => (
          <div className="space-y-4">
            <TodoRun
              open={runOpen}
              onClose={() => setRunOpen(false)}
              people={data.people}
              footer={data.email_footer}
              gmailUser={data.gmail_user}
            />
            <div className="flex flex-wrap gap-2">
              {data.people.length > 0 ? (
                <button type="button" className="btn-primary" onClick={() => setRunOpen(true)}>
                  <ListChecks className="h-4 w-4" aria-hidden /> Start: one person at a time
                </button>
              ) : null}
              <PrintAll data={data} />
              {data.today.added < data.today.goal ? (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={fill.busy}
                  onClick={() => void fill.run()}
                >
                  {fill.busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <UserPlus className="h-4 w-4" aria-hidden />
                  )}
                  {fill.busy ? 'Finding them on LinkedIn' : "Add today's people now"}
                </button>
              ) : null}
            </div>
            {data.people.length === 0 ? (
              <Empty
                title="Nothing to do right now"
                hint={`Each weekday up to ${data.today.goal} people show up here with every step: their LinkedIn note, a printout to mail with your card, and an email to send from Gmail.`}
              />
            ) : (
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                {data.people.map((p) => (
                  <TodoCard
                    key={p.lead_id}
                    person={p}
                    footer={data.email_footer}
                    gmailUser={data.gmail_user}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </QueryView>
    </section>
  )
}

/** Every waiting printout on one print page, their envelope labels, and any old postcards. */
function PrintAll({ data }: { data: TodoList }) {
  const waiting = data.people.flatMap((p) =>
    p.steps.filter((s) => s.kind === 'postcard' && s.status === 'waiting'),
  )
  const printouts = waiting.filter((s) => s.printout).map((s) => s.message_id)
  const postcards = waiting.filter((s) => !s.printout).map((s) => s.message_id)
  return (
    <>
      {printouts.length > 1 ? (
        <a
          href={printQueueUrl(printouts)}
          target="_blank"
          rel="noreferrer"
          className="btn-secondary"
        >
          <Printer className="h-4 w-4" aria-hidden /> Print all {printouts.length} printouts
        </a>
      ) : null}
      {printouts.length > 0 ? (
        <a
          href={printLabelsUrl(printouts)}
          target="_blank"
          rel="noreferrer"
          className="btn-secondary"
        >
          <Tag className="h-4 w-4" aria-hidden /> Envelope labels
        </a>
      ) : null}
      {postcards.length > 1 ? (
        <a
          href={printQueueUrl(postcards)}
          target="_blank"
          rel="noreferrer"
          className="btn-secondary"
        >
          <Printer className="h-4 w-4" aria-hidden /> Print all {postcards.length} postcards
        </a>
      ) : null}
    </>
  )
}

export function CompleteSection() {
  const q = useTodo()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const people = (q.data?.complete ?? []).filter((p) => !hidden.has(p.lead_id))
  if (!q.data) return null
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2>Complete</h2>
        <span className="text-stone-600">{people.length} waiting for a reply</span>
      </div>
      <p className="mb-3 text-stone-700">
        Everyone here got every step. If they write back, press They replied. If not, they come back
        on your list {q.data.recycle_after_days} days after their last step.
      </p>
      {people.length === 0 ? (
        <Empty title="No one yet" hint="People land here when every step on their card is done." />
      ) : (
        <ul className="card divide-y divide-stone-200">
          {people.map((p) => (
            <li key={p.lead_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className="min-w-0 flex-1">
                <Link
                  href={`/leads?id=${encodeURIComponent(p.lead_id)}`}
                  className="font-medium hover:underline"
                >
                  {p.person}
                </Link>
                {p.company && p.company !== p.person ? (
                  <span className="text-stone-600">, {p.company}</span>
                ) : null}
                <span className="block text-sm text-stone-600">
                  {p.done.join(', ')} done {relativeTime(p.last_done_at)}. Back on your list{' '}
                  <time dateTime={p.back_on} title={shortDateTime(p.back_on)}>
                    {relativeTime(p.back_on)}
                  </time>{' '}
                  if no reply.
                </span>
              </span>
              <ReplyForm
                leadId={p.lead_id}
                person={p.person}
                channel={
                  p.done.includes('LinkedIn')
                    ? 'linkedin'
                    : p.done.includes('Email')
                      ? 'email'
                      : p.done.includes('Call')
                        ? 'call'
                        : 'mail'
                }
                onSaved={() => setHidden((h) => new Set(h).add(p.lead_id))}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const STATUS_WORD: Record<string, string> = {
  replied: 'Replied',
  booked: 'Booked a demo',
  joined: 'Joined',
  not_interested: 'Not interested',
}

export function RepliedSection() {
  const q = useTodo()
  const people = q.data?.replied ?? []
  if (!q.data) return null
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2>Replied</h2>
        <span className="text-stone-600">{people.length} so far</span>
      </div>
      {people.length === 0 ? (
        <Empty
          title="No replies yet"
          hint="When someone writes back, press They replied on their card. Email replies show up here by themselves."
        />
      ) : (
        <ul className="card divide-y divide-stone-200">
          {people.map((p) => (
            <li key={p.lead_id} className="space-y-1 py-3">
              <p>
                <Link
                  href={`/leads?id=${encodeURIComponent(p.lead_id)}`}
                  className="font-medium hover:underline"
                >
                  {p.person}
                </Link>
                {p.company && p.company !== p.person ? (
                  <span className="text-stone-600">, {p.company}</span>
                ) : null}
              </p>
              <p className="text-sm text-stone-600">
                {STATUS_WORD[p.status] ?? p.status}
                {p.channel ? ` on ${CHANNEL_LABEL[p.channel]}` : ''}{' '}
                <time dateTime={p.replied_at} title={shortDateTime(p.replied_at)}>
                  {relativeTime(p.replied_at)}
                </time>
                {p.phone ? ` · ${p.phone}` : ''}
                {p.email ? ` · ${p.email}` : ''}
              </p>
              {p.note ? (
                <p className="whitespace-pre-wrap break-words text-stone-800">“{p.note}”</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
