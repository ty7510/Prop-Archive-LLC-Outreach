// One person on the to-do list: every step at once, in the order Theo does them (2026-10-16): the
// LinkedIn note, the printout he mails in a folder with his business card, then the email he sends
// from Gmail. Each step shows its words in full so he can proof them, lets him edit them, and has
// the buttons that do the work. When every step is done the person moves to Complete by themselves.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import {
  Check,
  ExternalLink,
  FileText,
  Mail,
  Pencil,
  Phone,
  Printer,
  Save,
  SkipForward,
  UserX,
} from 'lucide-react'
import clsx from 'clsx'
import type { TodoPerson, TodoStep, TodoStepKind } from '@shared/types'
import { editStepText, linkedInWrongPerson, printQueueUrl, queueDone, queueSkip } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { ensureHttp, telHref } from '../lib/format.ts'
import CopyButton from './CopyButton.tsx'
import LinkedInPaste from './LinkedInPaste.tsx'
import ReplyForm from './ReplyForm.tsx'

/** A free LinkedIn account allows 200 characters in a connection note. */
const NOTE_MAX = 200

const STEP_TITLE: Record<TodoStepKind, string> = {
  linkedin_connect: 'Send a LinkedIn connection note',
  linkedin_follow_up: 'Send a LinkedIn message',
  postcard: 'Mail the printout',
  email: 'Send the email',
  call: 'Call them',
}

const INVALIDATE = [['todo'], ['queue'], ['autopilot'], ['activity']]

function stepTitle(step: TodoStep): string {
  return step.kind === 'postcard' && !step.printout ? 'Mail a postcard' : STEP_TITLE[step.kind]
}

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

/** The email as it goes out: Theo's words, then the opt-out and address lines. */
function fullEmail(body: string, footer: string): string {
  return footer.trim() ? `${body.trim()}\n\n${footer.trim()}` : body.trim()
}

/**
 * A new Gmail message to them from Theo's account. Without a body he pastes the email he copied
 * (2026-10-19: "copy a email ... click there email and then send"). He presses Send himself.
 */
export function gmailComposeUrl(gmailUser: string, to: string, subject: string, body = ''): string {
  const params = [
    gmailUser.trim() ? `authuser=${encodeURIComponent(gmailUser.trim())}` : '',
    'view=cm',
    'fs=1',
    `to=${encodeURIComponent(to)}`,
    `su=${encodeURIComponent(subject)}`,
    body ? `body=${encodeURIComponent(body)}` : '',
  ].filter(Boolean)
  return `https://mail.google.com/mail/?${params.join('&')}`
}

/** The line under a person's name: company, how many properties, city, which round. */
export function personFacts(person: TodoPerson): string {
  return [
    person.company && person.company !== person.person ? person.company : null,
    person.property_count > 0
      ? `${person.property_count} ${person.property_count === 1 ? 'property' : 'properties'}`
      : null,
    person.city,
    person.round > 1 ? `back for round ${person.round}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim()

/**
 * The words of one waiting step while Theo proofs and edits them. The list refreshes every 15
 * seconds; new words from the server replace the draft only while he is not changing it.
 */
function useStepDraft(step: TodoStep) {
  const [saved, setSaved] = useState({ subject: step.subject ?? '', body: step.body })
  const [draft, setDraft] = useState(saved)
  const [problems, setProblems] = useState(step.problems)
  const dirty = norm(draft.subject) !== norm(saved.subject) || norm(draft.body) !== norm(saved.body)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const draftRef = useRef(draft)
  draftRef.current = draft
  const pending = useRef<{ key: string; done: Promise<boolean> } | null>(null)

  useEffect(() => {
    if (dirtyRef.current) return
    const next = { subject: step.subject ?? '', body: step.body }
    setSaved(next)
    setDraft(next)
    setProblems(step.problems)
  }, [step.subject, step.body, step.problems])

  const hasSubject = step.kind === 'email' || (step.kind === 'postcard' && step.printout)
  const save = useAction(
    () =>
      editStepText(step.message_id, {
        ...(hasSubject ? { subject: draft.subject } : {}),
        body: draft.body,
      }),
    {
      success: 'Saved',
      invalidate: [['todo']],
      onSuccess: (r) => {
        setSaved({ subject: r.subject ?? '', body: r.body })
        setProblems(r.problems)
      },
    },
  )

  return {
    draft,
    setSubject: (subject: string) => setDraft((d) => ({ ...d, subject })),
    setBody: (body: string) => setDraft((d) => ({ ...d, body })),
    dirty,
    problems,
    saving: save.busy,
    /** Saves when there are changes. False when the save failed (the toast says why). */
    async saveIfDirty(): Promise<boolean> {
      if (!dirtyRef.current) return true
      // Leaving a box and pressing a button right after both save: the same words go once.
      const key = JSON.stringify(draftRef.current)
      if (pending.current?.key === key) return pending.current.done
      const done = save.run().then((r) => r !== undefined)
      pending.current = { key, done }
      try {
        return await done
      } finally {
        if (pending.current?.done === done) pending.current = null
      }
    },
  }
}

type Draft = ReturnType<typeof useStepDraft>

export default function TodoCard({
  person,
  footer,
  gmailUser,
}: {
  person: TodoPerson
  /** The lines under every email (opt-out and mailing address). */
  footer: string
  /** The Gmail account Open in Gmail writes from. */
  gmailUser: string
}) {
  const waiting = person.steps.filter((s) => s.status === 'waiting')
  const nextId = waiting[0]?.message_id
  const printoutWaiting = person.steps.some((s) => s.kind === 'postcard' && s.status === 'waiting')
  const hasLinkedInStep = person.steps.some((s) => s.channel === 'linkedin')
  const hasEmailStep = person.steps.some((s) => s.kind === 'email')
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
          <p className="text-stone-600">{personFacts(person)}</p>
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
            person={person}
            current={step.message_id === nextId}
            footer={footer}
            gmailUser={gmailUser}
            printoutWaiting={printoutWaiting}
          />
        ))}
      </ol>

      {person.linkedin_missing === 'not_found' && !hasLinkedInStep ? (
        <div className="space-y-2 rounded-xl border border-dashed border-stone-300 p-3">
          <p className="text-sm text-stone-700">
            The app could not find {person.person} on LinkedIn. If you find them, paste the link and
            their note shows up above.
          </p>
          <LinkedInPaste leadId={person.lead_id} person={person.person} city={person.city} />
        </div>
      ) : null}

      {person.email && !hasEmailStep ? (
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
  person,
  current,
  footer,
  gmailUser,
  printoutWaiting,
}: {
  n: number
  step: TodoStep
  person: TodoPerson
  current: boolean
  footer: string
  gmailUser: string
  printoutWaiting: boolean
}) {
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
        {stepTitle(step)}
        {finished ? (
          <span className="text-sm font-normal">{step.status === 'done' ? 'done' : 'skipped'}</span>
        ) : null}
      </p>

      {finished ? null : (
        <div className="mt-2">
          <StepWork
            step={step}
            person={person}
            footer={footer}
            gmailUser={gmailUser}
            printoutWaiting={printoutWaiting}
          />
        </div>
      )}
    </li>
  )
}

/**
 * A waiting step's words and buttons: the same on a person's card and on today's LinkedIn,
 * printout and email lists. `how` shows the how-to line; the lists say it once at the top.
 */
export function StepWork({
  step,
  person,
  footer,
  gmailUser,
  printoutWaiting,
  how = true,
}: {
  step: TodoStep
  person: TodoPerson
  footer: string
  gmailUser: string
  printoutWaiting: boolean
  how?: boolean
}) {
  const draft = useStepDraft(step)
  const done = useAction((note?: string) => queueDone(step.message_id, note), {
    success: 'Done',
    invalidate: INVALIDATE,
  })
  const skip = useAction(() => queueSkip(step.message_id), {
    success: 'Skipped',
    invalidate: INVALIDATE,
  })
  const wrong = useAction(() => linkedInWrongPerson(person.lead_id, step.message_id), {
    success: 'Removed that profile. The note stays, so you can find them yourself.',
    invalidate: INVALIDATE,
  })
  const [opened, setOpened] = useState(false)
  const busy = done.busy || skip.busy || wrong.busy || draft.saving

  // What Theo sent is what gets recorded: unsaved edits are saved first.
  const markDone = async (note?: string) => {
    if (await draft.saveIfDirty()) await done.run(note)
  }

  return (
    <div className="space-y-3">
      {step.channel === 'linkedin' ? (
        <LinkedInStep
          step={step}
          person={person}
          draft={draft}
          how={how}
          onOpen={() => setOpened(true)}
        />
      ) : step.channel === 'mail' && step.printout ? (
        <PrintoutStep step={step} how={how} onPrint={() => setOpened(true)} />
      ) : step.channel === 'mail' ? (
        <PostcardStep step={step} how={how} onPrint={() => setOpened(true)} />
      ) : step.channel === 'email' ? (
        <EmailStep
          step={step}
          draft={draft}
          footer={footer}
          gmailUser={gmailUser}
          printoutWaiting={printoutWaiting}
          printoutSkipped={person.steps.some(
            (s) => s.kind === 'postcard' && s.status === 'skipped',
          )}
          how={how}
          onOpen={() => setOpened(true)}
        />
      ) : step.channel === 'call' ? (
        <CallStep step={step} onCall={() => setOpened(true)} />
      ) : null}

      <Problems problems={step.channel === 'mail' ? step.problems : draft.problems} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={opened ? 'btn-primary' : 'btn-secondary'}
          disabled={busy}
          onClick={() => void markDone()}
        >
          <Check className="h-4 w-4" aria-hidden />{' '}
          {step.channel === 'mail'
            ? 'Mailed it'
            : step.channel === 'call'
              ? 'Talked to them'
              : 'Sent it'}
        </button>
        {step.channel === 'call' ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void markDone('no answer, left a message')}
          >
            No answer
          </button>
        ) : null}
        {step.channel === 'linkedin' && step.found_by_app && step.to_address ? (
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
  )
}

/** House-rule hints on the words as they are now. They never stop Theo from sending. */
function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null
  return (
    <div className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
      <p className="font-medium">Check before you send:</p>
      <ul className="list-disc pl-5">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  )
}

function SaveButton({ draft }: { draft: Draft }) {
  if (!draft.dirty) return null
  return (
    <button
      type="button"
      className="btn-secondary"
      disabled={draft.saving}
      onClick={() => void draft.saveIfDirty()}
    >
      <Save className="h-4 w-4" aria-hidden /> Save changes
    </button>
  )
}

/**
 * The note in a box, Copy note, and a button to their LinkedIn (as it was before the to-do list).
 * Without a profile: a LinkedIn search for them and a box to paste the profile they find.
 */
function LinkedInStep({
  step,
  person,
  draft,
  how,
  onOpen,
}: {
  step: TodoStep
  person: TodoPerson
  draft: Draft
  how: boolean
  onOpen: () => void
}) {
  const [editing, setEditing] = useState(false)
  const note = draft.draft.body
  const profile = step.to_address?.trim() ?? ''
  return (
    <>
      {step.kind === 'linkedin_follow_up' ? (
        // Someone who got a note before: a message, not a second connection request.
        <p className={how ? 'text-sm text-stone-700' : 'text-sm text-amber-800'}>
          This one is a message, not a connection request. Copy it, open their LinkedIn, press
          Message, paste it and Send.
        </p>
      ) : how ? (
        <p className="text-sm text-stone-700">
          Copy the note, open their LinkedIn, press Connect, then Add a note, paste it and Send.
        </p>
      ) : null}
      {step.found_by_app && profile ? (
        <p className="text-sm text-amber-800">
          The app found this profile. Check it is them before you send.
        </p>
      ) : null}
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
        {editing ? (
          <textarea
            className="input min-h-[120px] py-2"
            value={note}
            maxLength={300}
            aria-label={`LinkedIn note for ${person.person}`}
            onChange={(e) => draft.setBody(e.target.value)}
            onBlur={() => void draft.saveIfDirty()}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-stone-800">{note}</p>
        )}
        <p
          className={clsx(
            'mt-2 text-xs',
            note.length > NOTE_MAX ? 'font-medium text-red-700' : 'text-stone-500',
          )}
        >
          {note.length} of {NOTE_MAX} characters
          {note.length > NOTE_MAX ? '. LinkedIn may cut it off unless you have Premium.' : ''}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={note} label="Copy note" onCopy={() => void draft.saveIfDirty()} />
        {profile ? (
          <a
            href={ensureHttp(profile)}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary"
            onClick={onOpen}
          >
            <ExternalLink className="h-4 w-4" aria-hidden /> Open their LinkedIn
          </a>
        ) : null}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            if (editing) void draft.saveIfDirty()
            setEditing(!editing)
          }}
        >
          <Pencil className="h-4 w-4" aria-hidden /> {editing ? 'Done editing' : 'Edit note'}
        </button>
        <SaveButton draft={draft} />
      </div>
      {!profile ? (
        <div className="space-y-2 rounded-xl border border-dashed border-stone-300 p-3">
          <p className="text-sm text-stone-700">
            The app has not found {person.person} on LinkedIn. Search for them, send the note, and
            paste their profile link here to keep it.
          </p>
          <LinkedInPaste leadId={person.lead_id} person={person.person} city={person.city} />
        </div>
      ) : null}
    </>
  )
}

/** The one-page printout: proof and edit it on its own page, then print it and mail it. */
function PrintoutStep({
  step,
  how,
  onPrint,
}: {
  step: TodoStep
  how: boolean
  onPrint: () => void
}) {
  return (
    <>
      <p className="text-sm text-stone-700">
        {how
          ? 'Proof it, print it, and mail it in a folder with your business card to: '
          : 'Mail to: '}
        {postalLines(step.to_address)}
      </p>
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        {step.subject ? <p className="font-medium text-stone-900">{step.subject}</p> : null}
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-stone-700">
          {step.body}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/printout/${encodeURIComponent(step.message_id)}`} className="btn-primary">
          <FileText className="h-4 w-4" aria-hidden /> Proof and edit
        </Link>
        <a
          href={printQueueUrl([step.message_id])}
          target="_blank"
          rel="noreferrer"
          className="btn-secondary"
          onClick={onPrint}
        >
          <Printer className="h-4 w-4" aria-hidden /> Print
        </a>
      </div>
    </>
  )
}

/** A 4x6 postcard on a card made before printouts. */
function PostcardStep({
  step,
  how,
  onPrint,
}: {
  step: TodoStep
  how: boolean
  onPrint: () => void
}) {
  return (
    <>
      <p className="text-sm text-stone-700">
        {how
          ? 'Print it, put a stamp on it and mail it to: '
          : 'A postcard: print it, put a stamp on it and mail it to: '}
        {postalLines(step.to_address)}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={printQueueUrl([step.message_id])}
          target="_blank"
          rel="noreferrer"
          className="btn-primary"
          onClick={onPrint}
        >
          <Printer className="h-4 w-4" aria-hidden /> Print postcard
        </a>
      </div>
    </>
  )
}

/**
 * The email in full to proof and edit. Theo copies it, clicks their address (a new Gmail message
 * to them opens with the subject filled in), pastes it and presses Send there (2026-10-19: "copy a
 * email to send to someone click there email and then send just like the linkedin").
 */
function EmailStep({
  step,
  draft,
  footer,
  gmailUser,
  printoutWaiting,
  printoutSkipped,
  how,
  onOpen,
}: {
  step: TodoStep
  draft: Draft
  footer: string
  gmailUser: string
  printoutWaiting: boolean
  /** Their printout was skipped, but the email may still say it was mailed. */
  printoutSkipped: boolean
  how: boolean
  onOpen: () => void
}) {
  const to = step.to_address?.trim() ?? ''
  const { subject, body } = draft.draft
  const email = fullEmail(body, footer)
  return (
    <>
      {how ? (
        <p className="text-sm text-stone-700">
          Copy the email, then click their address. A new Gmail message to them opens with the
          subject filled in. Paste the email there and press Send.
        </p>
      ) : null}
      {printoutWaiting ? (
        <p className="text-sm text-amber-800">
          Send it after you mail the printout: the email says it is on its way.
        </p>
      ) : null}
      {printoutSkipped ? (
        <p className="text-sm text-amber-800">
          You skipped their printout. If the email says you mailed something, take that line out.
        </p>
      ) : null}
      <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-3">
        {to ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-stone-600">To:</span>
            <a
              href={gmailComposeUrl(gmailUser, to, subject)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-tap min-w-0 items-center gap-1 break-all font-medium text-emerald-700 underline"
              title={`Write to ${to} in Gmail`}
              onClick={() => {
                void draft.saveIfDirty()
                onOpen()
              }}
            >
              <Mail className="h-4 w-4 shrink-0" aria-hidden /> {to}
            </a>
            <CopyButton text={to} label="Copy address" compact />
          </div>
        ) : null}
        <label className="block text-sm font-medium text-stone-800">
          Subject
          <input
            className="input mt-1"
            value={subject}
            maxLength={200}
            onChange={(e) => draft.setSubject(e.target.value)}
            onBlur={() => void draft.saveIfDirty()}
          />
        </label>
        <label className="block text-sm font-medium text-stone-800">
          Email
          <textarea
            className="input mt-1 min-h-[220px] py-2 font-normal"
            value={body}
            onChange={(e) => draft.setBody(e.target.value)}
            onBlur={() => void draft.saveIfDirty()}
          />
        </label>
        {footer.trim() ? (
          <div className="text-sm text-stone-500">
            <p>Added at the bottom:</p>
            <p className="whitespace-pre-wrap">{footer}</p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={email} label="Copy email" onCopy={() => void draft.saveIfDirty()} />
        <CopyButton text={subject} label="Copy subject" />
        <SaveButton draft={draft} />
      </div>
    </>
  )
}

/** A call on a card made before the to-do list became LinkedIn, printout and email. */
function CallStep({ step, onCall }: { step: TodoStep; onCall: () => void }) {
  return (
    <>
      <p className="text-sm text-stone-700">What to say:</p>
      <div className="rounded-2xl rounded-tl-sm bg-white p-3 ring-1 ring-stone-200">
        <p className="whitespace-pre-wrap break-words text-stone-800">{step.body}</p>
      </div>
      {step.to_address ? (
        <div className="flex flex-wrap gap-2">
          <a href={telHref(step.to_address)} className="btn-primary" onClick={onCall}>
            <Phone className="h-4 w-4" aria-hidden /> Call {step.to_address}
          </a>
        </div>
      ) : null}
    </>
  )
}
