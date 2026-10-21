// The Go page when timed sequences are off: To do (a switch between today's LinkedIn notes,
// printouts, emails and every step per person), Complete (waiting for a reply until they come
// back), Replied (everyone who answered).
import { useState } from 'react'
import { Link } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { ListChecks, Loader2, Printer, Tag, UserPlus } from 'lucide-react'
import { NO_NEW_LINKEDIN, type TodoList } from '@shared/types'
import { fillTodoNow, getReadiness, getTodo, printLabelsUrl, printQueueUrl } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { CHANNEL_LABEL, relativeTime, shortDateTime } from '../lib/format.ts'
import { todayLists } from '../lib/todayLists.ts'
import { Empty, QueryView } from './QueryState.tsx'
import ReplyForm from './ReplyForm.tsx'
import TodoCard from './TodoCard.tsx'
import TodoRun from './TodoRun.tsx'
import {
  ListCount,
  NoLinkedIn,
  OneByOneButton,
  StepList,
  StepRun,
  TodayTabs,
  useTodayTab,
} from './TodayLists.tsx'

export function useTodo() {
  return useQuery({ queryKey: ['todo'], queryFn: getTodo, refetchInterval: 15_000 })
}

export function TodoSection() {
  const q = useTodo()
  // Nothing opens by itself any more (2026-10-19): Theo picks a list with the switch.
  const [runOpen, setRunOpen] = useState(false)
  const [linkedInRunOpen, setLinkedInRunOpen] = useState(false)
  const [tab, setTab] = useTodayTab()
  const fill = useAction(fillTodoNow, {
    success: (r) => {
      const people = `${r.added} ${r.added === 1 ? 'person' : 'people'} added`
      // Room for LinkedIn notes but nobody new with a profile (Theo, 2026-10-21): never "already
      // on your list", which read as if today's people were there.
      if (r.reason === NO_NEW_LINKEDIN)
        return r.added > 0
          ? `${people}. Nobody new with a LinkedIn to add yet`
          : 'Nobody new with a LinkedIn to add yet'
      if (r.added > 0) return people
      return r.reason === 'not a send day'
        ? 'New people are added on weekdays'
        : "Today's people are already on your list"
    },
    invalidate: [['todo'], ['activity']],
  })

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2>To do</h2>
        {q.data ? (
          <span className="text-stone-600">
            {q.data.people.length} {q.data.people.length === 1 ? 'person' : 'people'} ·{' '}
            {q.data.today.sent} of {q.data.today.goal} LinkedIn notes sent today
          </span>
        ) : null}
      </div>
      <QueryView q={q} loading="Loading your list">
        {(data) => {
          const lists = todayLists(data.people)
          const addPeople =
            data.today.sent + lists.linkedin.length < data.today.goal ? (
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
                {fill.busy ? 'Adding people' : "Add today's people now"}
              </button>
            ) : null
          return (
            <div className="space-y-4">
              <TodoRun
                open={runOpen}
                onClose={() => setRunOpen(false)}
                people={data.people}
                footer={data.email_footer}
                gmailUser={data.gmail_user}
              />
              <StepRun
                open={linkedInRunOpen}
                onClose={() => setLinkedInRunOpen(false)}
                title="Today's LinkedIn notes"
                items={lists.linkedin}
                data={data}
              />
              {data.today.sent + lists.linkedin.length < data.today.goal ? (
                <ResearchStopped />
              ) : null}
              <TodayTabs tab={tab} onChange={setTab} lists={lists} people={data.people.length} />

              {/* All four lists stay mounted, so switching never drops words being edited. */}
              <div className="space-y-4" hidden={tab !== 'linkedin'}>
                <ListCount
                  waiting={lists.linkedin.length}
                  sent={data.sent_today.linkedin}
                  verb="send"
                />
                <div className="flex flex-wrap gap-2">
                  {lists.linkedin.length > 0 ? (
                    <OneByOneButton onClick={() => setLinkedInRunOpen(true)} />
                  ) : null}
                  {addPeople}
                </div>
                <StepList
                  items={lists.linkedin}
                  data={data}
                  how="Copy each note, open their LinkedIn, press Connect, then Add a note, paste it and Send. Then press Sent it."
                  empty={{
                    title: 'No LinkedIn messages to send',
                    hint: 'Each weekday new people show up with a note written for them.',
                  }}
                />
                <NoLinkedIn people={lists.noLinkedIn} />
              </div>
              <div className="space-y-4" hidden={tab !== 'printouts'}>
                <ListCount
                  waiting={lists.printouts.length}
                  sent={data.sent_today.mail}
                  verb="mail"
                />
                <div className="flex flex-wrap gap-2">
                  <PrintAll data={data} />
                  {addPeople}
                </div>
                <StepList
                  items={lists.printouts}
                  data={data}
                  how="Proof each one, print it, and mail it in a folder with your business card. Then press Mailed it."
                  empty={{
                    title: 'No printouts to mail',
                    hint: 'Each weekday new people show up with a printout written for them.',
                  }}
                />
              </div>
              <div className="space-y-4" hidden={tab !== 'emails'}>
                <ListCount waiting={lists.emails.length} sent={data.sent_today.email} verb="send" />
                {addPeople ? <div className="flex flex-wrap gap-2">{addPeople}</div> : null}
                <StepList
                  items={lists.emails}
                  data={data}
                  how="Copy the email, then click their address. A new Gmail message to them opens with the subject filled in. Paste the email there, press Send, then press Sent it here."
                  empty={{
                    title: 'No emails to send',
                    hint: 'Only people with an email address on file get an email.',
                  }}
                />
                {lists.noEmail > 0 && data.people.length > 0 ? (
                  <p className="text-sm text-stone-600">
                    {lists.noEmail} of the {data.people.length} people on your list have no email to
                    send. Only people with an email address on file get one.
                  </p>
                ) : null}
              </div>
              <div className="space-y-4" hidden={tab !== 'people'}>
                <div className="flex flex-wrap gap-2">
                  {data.people.length > 0 ? (
                    <button type="button" className="btn-primary" onClick={() => setRunOpen(true)}>
                      <ListChecks className="h-4 w-4" aria-hidden /> Start: one person at a time
                    </button>
                  ) : null}
                  <PrintAll data={data} />
                  {addPeople}
                </div>
                {data.people.length === 0 ? (
                  <Empty
                    title="Nothing to do right now"
                    hint={`Each weekday new people with a LinkedIn show up here until you have sent ${data.today.goal} LinkedIn notes. Skip a LinkedIn note and a new person takes their place. Each has every step: their LinkedIn note, a printout to mail with your card, and an email to send from Gmail.`}
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
            </div>
          )
        }}
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

/**
 * Under today's LinkedIn goal while research has stopped (the Anthropic account is out of credits,
 * the key was refused, or this month's research cap is reached): nobody new gets a LinkedIn
 * profile, so the list cannot refill. Says so here, with the fix, instead of only in Settings
 * (Theo, 2026-10-21: "the linkedin is not refreshing to show me todays 25").
 */
function ResearchStopped() {
  const q = useQuery({ queryKey: ['readiness'], queryFn: getReadiness, staleTime: 60_000 })
  const stopped = (q.data ?? []).filter(
    (item) => !item.ok && (item.key === 'enrich' || item.key === 'research_cap'),
  )
  if (stopped.length === 0) return null
  return (
    <div role="status" className="card space-y-1 border-amber-300 bg-amber-50">
      <p className="font-medium">
        Research has stopped, so nobody new with a LinkedIn can come on the list.
      </p>
      {stopped.map((item) => (
        <p key={item.key} className="text-stone-700">
          {item.fix || item.label}
        </p>
      ))}
    </div>
  )
}
