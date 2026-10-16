// One person on the to-do list: every step at once, in order, each with what to do and a button
// that does the work (copy the note and open their LinkedIn, print the postcard, call). When every
// step is done the person moves to Complete by themselves.
import { useState } from 'react'
import { Link } from 'wouter'
import { Check, ExternalLink, Mail, Phone, Printer, SkipForward, UserX } from 'lucide-react'
import clsx from 'clsx'
import type { TodoPerson, TodoStep, TodoStepKind } from '@shared/types'
import { linkedInWrongPerson, printQueueUrl, queueDone, queueSkip } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { ensureHttp, telHref } from '../lib/format.ts'
import CopyButton, { copyText } from './CopyButton.tsx'
import LinkedInPaste from './LinkedInPaste.tsx'
import ReplyForm from './ReplyForm.tsx'

const STEP_TITLE: Record<TodoStepKind, string> = {
  linkedin_connect: 'Send a LinkedIn connection note',
  linkedin_follow_up: 'Send a LinkedIn message',
  postcard: 'Mail a postcard',
  call: 'Call them',
}

const INVALIDATE = [['todo'], ['queue'], ['autopilot'], ['activity']]

function postalLines(raw: string | null): string | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const parts = ['name', 'company', 'street', 'city', 'state', 'zip']
      .map((k) => o[k])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    return parts.join(', ')
  } catch {
    return raw
  }
}

export default function TodoCard({ person }: { person: TodoPerson }) {
  const waiting = person.steps.filter((s) => s.status === 'waiting')
  const nextId = waiting[0]?.message_id
  return (
    <article className="card flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/leads?id=${encodeURIComponent(person.lead_id)}`}
            className="text-lg font-medium hover:underline"
          >
            {person.person}
          </Link>
          <p className="text-stone-600">
            {[
              person.company && person.company !== person.person ? person.company : null,
              person.property_count > 0
                ? `${person.property_count} ${person.property_count === 1 ? 'property' : 'properties'}`
                : null,
              person.city,
              person.round > 1 ? `back for round ${person.round}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <span className="text-sm text-stone-600">
          {person.steps.length - waiting.length} of {person.steps.length} done
        </span>
      </header>

      <ol className="space-y-3">
        {person.steps.map((step, i) => (
          <StepRow
            key={step.message_id}
            n={i + 1}
            step={step}
            leadId={person.lead_id}
            current={step.message_id === nextId}
          />
        ))}
      </ol>

      {person.linkedin_missing === 'not_found' ? (
        <div className="space-y-2 rounded-xl border border-dashed border-stone-300 p-3">
          <p className="text-sm text-stone-700">
            The app could not find {person.person} on LinkedIn. If you find them, paste the link and
            their note shows up above.
          </p>
          <LinkedInPaste leadId={person.lead_id} person={person.person} city={person.city} />
        </div>
      ) : null}

      {person.email ? (
        <p className="text-sm text-stone-700">
          <a
            href={`mailto:${person.email}`}
            className="inline-flex items-center gap-1 break-all underline"
          >
            <Mail className="h-4 w-4" aria-hidden /> {person.email}
          </a>{' '}
          (write to them yourself if you like)
        </p>
      ) : null}

      <div className="border-t border-stone-200 pt-3">
        <ReplyForm leadId={person.lead_id} person={person.person} />
      </div>
    </article>
  )
}

function StepRow({
  n,
  step,
  leadId,
  current,
}: {
  n: number
  step: TodoStep
  leadId: string
  current: boolean
}) {
  const done = useAction((note?: string) => queueDone(step.message_id, note), {
    success: 'Done',
    invalidate: INVALIDATE,
  })
  const skip = useAction(() => queueSkip(step.message_id), {
    success: 'Skipped',
    invalidate: INVALIDATE,
  })
  const wrong = useAction(() => linkedInWrongPerson(leadId, step.message_id), {
    success: 'Removed that profile. The app will not pick it again.',
    invalidate: INVALIDATE,
  })
  const [opened, setOpened] = useState(false)
  const busy = done.busy || skip.busy || wrong.busy
  const finished = step.status !== 'waiting'

  return (
    <li
      className={clsx(
        'rounded-xl border p-3',
        finished
          ? 'border-stone-200 bg-stone-50 text-stone-500'
          : current
            ? 'border-emerald-300 bg-emerald-50/40'
            : 'border-stone-200',
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <span
          className={clsx(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm',
            finished ? 'bg-stone-200' : 'bg-emerald-600 text-white',
          )}
          aria-hidden
        >
          {finished ? <Check className="h-4 w-4" /> : n}
        </span>
        {STEP_TITLE[step.kind]}
        {finished ? (
          <span className="text-sm font-normal">{step.status === 'done' ? 'done' : 'skipped'}</span>
        ) : null}
      </p>

      {finished ? null : (
        <div className="mt-2 space-y-3">
          {step.channel === 'linkedin' ? (
            <>
              <p className="text-sm text-stone-700">
                Press the green button: it copies the note and opens their profile. On LinkedIn
                press Connect, then Add a note, paste, and Send.
              </p>
              {step.found_by_app ? (
                <p className="text-sm text-amber-800">
                  The app found this profile. Check it is them before you send.
                </p>
              ) : null}
            </>
          ) : step.channel === 'mail' ? (
            <p className="text-sm text-stone-700">
              Print it, put a stamp on it and mail it to: {postalLines(step.to_address)}
            </p>
          ) : step.channel === 'call' ? (
            <p className="text-sm text-stone-700">What to say:</p>
          ) : null}

          {step.channel !== 'mail' ? (
            <div className="rounded-2xl rounded-tl-sm bg-white p-3 ring-1 ring-stone-200">
              <p className="whitespace-pre-wrap break-words text-stone-800">{step.body}</p>
              {step.channel === 'linkedin' ? (
                <p className="mt-1 text-xs text-stone-500">{step.body.length} of 200 characters</p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {step.channel === 'linkedin' && step.to_address ? (
              <>
                <a
                  href={ensureHttp(step.to_address)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-primary"
                  onClick={() => {
                    void copyText(step.body)
                    setOpened(true)
                  }}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden /> Copy note and open LinkedIn
                </a>
                <CopyButton text={step.body} label="Copy note" />
              </>
            ) : null}
            {step.channel === 'mail' ? (
              <a
                href={printQueueUrl([step.message_id])}
                target="_blank"
                rel="noreferrer"
                className="btn-primary"
                onClick={() => setOpened(true)}
              >
                <Printer className="h-4 w-4" aria-hidden /> Print postcard
              </a>
            ) : null}
            {step.channel === 'call' && step.to_address ? (
              <a
                href={telHref(step.to_address)}
                className="btn-primary"
                onClick={() => setOpened(true)}
              >
                <Phone className="h-4 w-4" aria-hidden /> Call {step.to_address}
              </a>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={opened ? 'btn-primary' : 'btn-secondary'}
              disabled={busy}
              onClick={() => void done.run()}
            >
              <Check className="h-4 w-4" aria-hidden />{' '}
              {step.channel === 'linkedin'
                ? 'Sent it'
                : step.channel === 'mail'
                  ? 'Mailed it'
                  : 'Talked to them'}
            </button>
            {step.channel === 'call' ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void done.run('no answer, left a message')}
              >
                No answer
              </button>
            ) : null}
            {step.channel === 'linkedin' && step.found_by_app ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => void wrong.run()}
              >
                <UserX className="h-4 w-4" aria-hidden /> Not them
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => void skip.run()}
            >
              <SkipForward className="h-4 w-4" aria-hidden /> Skip
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
