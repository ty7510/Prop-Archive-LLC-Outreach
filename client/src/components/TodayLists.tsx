// Today's to-do list one kind at a time (Theo, 2026-10-19): every LinkedIn note, every printout or
// every email in one list, with a switch between them. Each card shows the person and that one
// step the way the LinkedIn notes first looked: the words, Copy, the button to open, Sent it.
import { useState } from 'react'
import { Link } from 'wouter'
import { ChevronLeft, ChevronRight, Play } from 'lucide-react'
import type { TodoList } from '@shared/types'
import { isTodayTab, type TodayItem, type TodayLists, type TodayTab } from '../lib/todayLists.ts'
import { usePinnedIndex } from '../hooks/usePinnedIndex.ts'
import { Chip } from './Field.tsx'
import { Modal } from './Confirm.tsx'
import { Empty } from './QueryState.tsx'
import LinkedInPaste from './LinkedInPaste.tsx'
import { personFacts, StepWork } from './TodoCard.tsx'

const TAB_KEY = 'todo-tab'

function savedTab(): TodayTab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return isTodayTab(v) ? v : 'linkedin'
  } catch {
    return 'linkedin'
  }
}

/** The list Theo looked at last, kept in this browser. LinkedIn first. */
export function useTodayTab(): [TodayTab, (tab: TodayTab) => void] {
  const [tab, setTab] = useState<TodayTab>(savedTab)
  return [
    tab,
    (next) => {
      setTab(next)
      try {
        localStorage.setItem(TAB_KEY, next)
      } catch {
        // Private windows can refuse storage; the switch still works for this visit.
      }
    },
  ]
}

export function TodayTabs({
  tab,
  onChange,
  lists,
  people,
}: {
  tab: TodayTab
  onChange: (tab: TodayTab) => void
  lists: TodayLists
  people: number
}) {
  const tabs: { key: TodayTab; label: string; n: number }[] = [
    { key: 'linkedin', label: 'LinkedIn messages', n: lists.linkedin.length },
    { key: 'printouts', label: 'Printouts', n: lists.printouts.length },
    { key: 'emails', label: 'Emails', n: lists.emails.length },
    { key: 'people', label: 'By person', n: people },
  ]
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
      {tabs.map((t) => (
        <Chip key={t.key} active={tab === t.key} onClick={() => onChange(t.key)}>
          {t.label} ({t.n})
        </Chip>
      ))}
    </div>
  )
}

/** "5 to send · 3 sent today" over each list. */
export function ListCount({
  waiting,
  sent,
  verb,
}: {
  waiting: number
  sent: number
  verb: string
}) {
  return (
    <p className="text-stone-600">
      {waiting} to {verb} · {sent} {verb === 'mail' ? 'mailed' : 'sent'} today
    </p>
  )
}

/** One person and one step, the same buttons as on their card. */
function StepCard({ item, data }: { item: TodayItem; data: TodoList }) {
  const { person, step } = item
  const facts = personFacts(person)
  return (
    <article className="card flex min-w-0 flex-col gap-3">
      <header className="min-w-0">
        <Link
          href={`/leads?id=${encodeURIComponent(person.lead_id)}`}
          className="text-lg font-medium hover:underline"
        >
          {person.person}
        </Link>
        {facts ? <p className="text-stone-600">{facts}</p> : null}
      </header>
      <StepWork
        step={step}
        person={person}
        footer={data.email_footer}
        gmailUser={data.gmail_user}
        printoutWaiting={person.steps.some((s) => s.kind === 'postcard' && s.status === 'waiting')}
        how={false}
      />
    </article>
  )
}

export function StepList({
  items,
  data,
  how,
  empty,
}: {
  items: TodayItem[]
  data: TodoList
  /** What to do with each one, said once over the list. */
  how: string
  empty: { title: string; hint: string }
}) {
  if (items.length === 0) return <Empty title={empty.title} hint={empty.hint} />
  return (
    <div className="space-y-3">
      <p className="text-stone-700">{how}</p>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        {items.map((item) => (
          <StepCard key={item.step.message_id} item={item} data={data} />
        ))}
      </div>
    </div>
  )
}

/** Today's LinkedIn notes as a pop-up, one at a time, like the first LinkedIn pop-up. */
export function StepRun({
  open,
  onClose,
  title,
  items,
  data,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** The live list: a note drops out when it is marked sent or skipped. */
  items: TodayItem[]
  data: TodoList
}) {
  const { at, current: item, go } = usePinnedIndex(items, (i) => i.step.message_id, open)
  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      {item ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-stone-600">
              {at + 1} of {items.length}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={at === 0}
                onClick={() => go(at - 1)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden /> Back
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={at >= items.length - 1}
                onClick={() => go(at + 1)}
              >
                Next <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
          <StepCard key={item.step.message_id} item={item} data={data} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-stone-700">
            That&apos;s everyone for now. New ones come up on weekdays.
          </p>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function OneByOneButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn-primary" onClick={onClick}>
      <Play className="h-4 w-4" aria-hidden /> Send them one by one
    </button>
  )
}

/** People on the list the app could not find on LinkedIn: paste their profile to get a note. */
export function NoLinkedIn({ people }: { people: TodayLists['noLinkedIn'] }) {
  if (people.length === 0) return null
  return (
    <details className="card">
      <summary className="min-h-tap cursor-pointer py-2 text-lg font-medium">
        No LinkedIn found ({people.length})
      </summary>
      <p className="mt-1 text-stone-700">
        The app could not find these people on LinkedIn. If you find them, paste the link and their
        note shows up above.
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
            <LinkedInPaste leadId={p.lead_id} person={p.person} city={p.city} />
          </li>
        ))}
      </ul>
    </details>
  )
}
