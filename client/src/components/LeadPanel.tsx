// Side panel for one lead: contact fields with copy buttons, properties, timeline, notes, buttons.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  X,
  ExternalLink,
  Phone,
  Play,
  Ban,
  OctagonX,
  CalendarCheck,
  UserPlus,
  ThumbsDown,
  Save,
} from 'lucide-react'
import clsx from 'clsx'
import type { Settings } from '@shared/settings'
import type { OutcomeKind } from '@shared/types'
import type { LeadDetail, LeadEvent, Message, Sequence } from '../types.ts'
import { enrollLead, getLead, leadOutcome, patchLead, stopLead } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import CopyButton from './CopyButton.tsx'
import { Badge } from './Field.tsx'
import ChannelIcons from './ChannelIcons.tsx'
import NotBuilt from './NotBuilt.tsx'
import { ErrorNote, Loading } from './QueryState.tsx'
import { pickSequence } from '../lib/pickSequence.ts'
import {
  CHANNEL_LABEL,
  ensureHttp,
  humanise,
  leadName,
  mailingAddress,
  money,
  neighbourhood,
  orDash,
  personaLabel,
  shortDate,
  shortDateTime,
  statusLabel,
  telHref,
  triggerLabel,
} from '../lib/format.ts'

const PERSONA_TONE: Record<string, 'green' | 'blue' | 'purple' | 'stone'> = {
  maya: 'green',
  ray: 'blue',
  denise: 'purple',
  unknown: 'stone',
}

export default function LeadPanel({
  id,
  onClose,
  onChanged,
  settings,
  sequences,
}: {
  id: string
  onClose: () => void
  onChanged: () => void
  settings: Settings | undefined
  sequences: Sequence[] | undefined
}) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => getLead(id) })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['lead', id] })
    onChanged()
  }

  return (
    <div
      className="fixed inset-0 z-30 flex justify-end bg-stone-900/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Lead details"
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-stone-200 px-4 py-3">
          <div className="min-w-0">
            {q.data ? (
              <>
                <h2 className="truncate">{leadName(q.data)}</h2>
                {q.data.company && q.data.full_name ? (
                  <p className="truncate text-stone-600">{q.data.company}</p>
                ) : null}
              </>
            ) : (
              <h2>Lead</h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-2 rounded-lg p-2 text-stone-500 hover:bg-stone-100"
            aria-label="Close"
          >
            <X className="h-6 w-6" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {q.isLoading ? <Loading text="Loading lead" /> : null}
          {q.isError ? <ErrorNote error={q.error} retry={() => void q.refetch()} /> : null}
          {q.data ? (
            <LeadBody lead={q.data} refresh={refresh} settings={settings} sequences={sequences} />
          ) : null}
        </div>
      </aside>
    </div>
  )
}

function LeadBody({
  lead,
  refresh,
  settings,
  sequences,
}: {
  lead: LeadDetail
  refresh: () => Promise<void>
  settings: Settings | undefined
  sequences: Sequence[] | undefined
}) {
  const [notes, setNotes] = useState(lead.notes ?? '')
  useEffect(() => setNotes(lead.notes ?? ''), [lead.id, lead.notes])

  const saveNotes = useAction(() => patchLead(lead.id, { notes }), {
    success: 'Notes saved',
    onSuccess: refresh,
  })
  const dnc = useAction(() => patchLead(lead.id, { do_not_contact: !lead.do_not_contact }), {
    success: lead.do_not_contact ? 'Contact allowed again' : 'Marked do not contact',
    onSuccess: refresh,
  })
  const stop = useAction(() => stopLead(lead.id), {
    success: 'Outreach stopped',
    onSuccess: refresh,
  })
  const outcome = useAction((kind: OutcomeKind) => leadOutcome(lead.id, { kind }), {
    success: (r) => `Marked ${statusLabel(r.status).toLowerCase()}`,
    onSuccess: refresh,
  })

  const pick = useMemo(
    () => (settings && sequences ? pickSequence(lead, settings, sequences) : null),
    [lead, settings, sequences],
  )
  const start = useAction(() => enrollLead(lead.id, { sequence_id: pick!.sequence!.id }), {
    success: pick?.sequence ? `Started ${pick.sequence.name}` : 'Started',
    onSuccess: refresh,
  })

  const notBuilt =
    saveNotes.notBuilt || dnc.notBuilt || stop.notBuilt || outcome.notBuilt || start.notBuilt
  const busy = saveNotes.busy || dnc.busy || stop.busy || outcome.busy || start.busy
  const activeEnrollment = lead.enrollments.some(
    (e) => e.status === 'active' || e.status === 'paused',
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={PERSONA_TONE[lead.persona] ?? 'stone'}>{personaLabel(lead.persona)}</Badge>
        <Badge tone="stone">{statusLabel(lead.status)}</Badge>
        <Badge tone={lead.icp_score >= 70 ? 'green' : lead.icp_score >= 50 ? 'blue' : 'stone'}>
          Fit {lead.icp_score}
        </Badge>
        {lead.do_not_contact ? <Badge tone="red">Do not contact</Badge> : null}
        {lead.trigger.type !== 'none' ? (
          <Badge tone="amber">
            {triggerLabel(lead.trigger.type)}
            {lead.trigger.date ? ` ${shortDate(lead.trigger.date)}` : ''}
          </Badge>
        ) : null}
        <span className="ml-auto">
          <ChannelIcons channels={lead.channels} />
        </span>
      </div>

      <section>
        <h3 className="mb-2 text-base font-semibold text-stone-700">Contact</h3>
        <dl className="divide-y divide-stone-100 rounded-xl border border-stone-200">
          <ContactRow
            label="Email"
            value={lead.email}
            note={
              lead.email_status !== 'unknown'
                ? humanise(lead.email_status)
                : proofNote(lead, 'email', lead.email)
            }
          />
          <ContactRow
            label="Phone"
            value={lead.phone}
            note={
              lead.phone_type !== 'unknown'
                ? humanise(lead.phone_type)
                : proofNote(lead, 'phone', lead.phone)
            }
            link={
              lead.phone ? { href: telHref(lead.phone), label: 'Call', icon: Phone } : undefined
            }
          />
          <ContactRow
            label="LinkedIn"
            value={lead.linkedin_url}
            note={proofNote(lead, 'linkedin_url', lead.linkedin_url)}
            link={
              lead.linkedin_url
                ? { href: ensureHttp(lead.linkedin_url), label: 'Open', icon: ExternalLink }
                : undefined
            }
          />
          <ContactRow
            label="Instagram"
            value={lead.instagram_url}
            note={proofNote(lead, 'instagram_url', lead.instagram_url)}
            link={
              lead.instagram_url
                ? { href: ensureHttp(lead.instagram_url), label: 'Open', icon: ExternalLink }
                : undefined
            }
          />
          <ContactRow
            label="Facebook"
            value={lead.facebook_url}
            note={proofNote(lead, 'facebook_url', lead.facebook_url)}
            link={
              lead.facebook_url
                ? { href: ensureHttp(lead.facebook_url), label: 'Open', icon: ExternalLink }
                : undefined
            }
          />
          <ContactRow
            label="Website"
            value={lead.website}
            note={proofNote(lead, 'website', lead.website)}
            link={
              lead.website
                ? { href: ensureHttp(lead.website), label: 'Open', icon: ExternalLink }
                : undefined
            }
          />
          <ContactRow
            label="Mailing address"
            value={mailingAddress(lead) || null}
            note={lead.mailing_verified ? 'Verified' : undefined}
          />
          <ContactRow label="Full name" value={lead.full_name} />
          <ContactRow label="Company" value={lead.company} />
          <ContactRow
            label="Properties / units"
            value={
              lead.property_count || lead.unit_count
                ? `${lead.property_count} properties, ${lead.unit_count} units`
                : null
            }
          />
        </dl>
      </section>

      {otherContacts(lead).length ? (
        <section>
          <h3 className="mb-2 text-base font-semibold text-stone-700">Other ways in</h3>
          <p className="mb-2 text-sm text-stone-600">
            Property managers and agents who handle their rentals. Not the owner.
          </p>
          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200">
            {otherContacts(lead).map((c) => (
              <li
                key={`${c.field}-${c.value}`}
                className="flex flex-wrap items-baseline gap-x-2 px-3 py-2"
              >
                <span className="text-sm text-stone-500">
                  {c.role === 'agent' ? 'Agent' : 'Manager'}
                </span>
                <span className="min-w-0 break-words font-medium">{c.value}</span>
                <a
                  href={c.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-stone-500 underline"
                >
                  {sourceHost(c.source_url)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-2 text-base font-semibold text-stone-700">
          Properties <span className="font-normal text-stone-500">({lead.properties.length})</span>
        </h3>
        {researchDetails(lead).length ? (
          <ul className="mb-2 list-disc pl-5 text-sm text-stone-600">
            {researchDetails(lead).map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
        {lead.properties.length === 0 ? (
          <p className="text-stone-500">No properties on file.</p>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200">
            {lead.properties.map((p) => (
              <li key={p.id} className="px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{orDash(p.address)}</span>
                  <span className="text-sm text-stone-500">
                    {p.zip ? neighbourhood(p.zip) : ''} {p.zip ?? ''}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 text-sm text-stone-600">
                  {p.category ? <span>{p.category}</span> : null}
                  {p.units ? <span>{p.units} units</span> : null}
                  {p.sale_date ? (
                    <span>
                      Sold {shortDate(p.sale_date)} {p.sale_price ? money(p.sale_price) : ''}
                    </span>
                  ) : null}
                  {p.market_value ? <span>Value {money(p.market_value)}</span> : null}
                  {p.license_num ? <span>License {p.license_num}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-base font-semibold text-stone-700">Timeline</h3>
        <Timeline lead={lead} />
      </section>

      <section>
        <h3 className="mb-2 text-base font-semibold text-stone-700">Notes</h3>
        <textarea
          className="input min-h-[96px] py-2"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering about this person"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          {lead.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {lead.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || notes === (lead.notes ?? '')}
            onClick={() => void saveNotes.run()}
          >
            <Save className="h-4 w-4" aria-hidden /> Save notes
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-semibold text-stone-700">Actions</h3>
        {pick ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !pick.sequence || activeEnrollment}
              onClick={() => void start.run()}
            >
              <Play className="h-4 w-4" aria-hidden /> Start sequence
            </button>
            <span className="text-sm text-stone-600">
              {activeEnrollment
                ? 'Already in a sequence'
                : pick.sequence
                  ? `${pick.sequence.name} (${CHANNEL_LABEL[pick.channel!]})`
                  : pick.reason}
            </span>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !activeEnrollment}
            onClick={() => void stop.run()}
          >
            <OctagonX className="h-4 w-4" aria-hidden /> Stop outreach
          </button>
          <button
            type="button"
            className={clsx(lead.do_not_contact ? 'btn-secondary' : 'btn-danger')}
            disabled={busy}
            onClick={() => void dnc.run()}
          >
            <Ban className="h-4 w-4" aria-hidden />{' '}
            {lead.do_not_contact ? 'Allow contact' : 'Do not contact'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void outcome.run('demo_booked')}
          >
            <CalendarCheck className="h-4 w-4" aria-hidden /> Booked a demo
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void outcome.run('beta_joined')}
          >
            <UserPlus className="h-4 w-4" aria-hidden /> Joined the beta
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void outcome.run('not_interested')}
          >
            <ThumbsDown className="h-4 w-4" aria-hidden /> Not interested
          </button>
        </div>
        {notBuilt ? <NotBuilt what="Lead actions." /> : null}
      </section>
    </div>
  )
}

function ContactRow({
  label,
  value,
  note,
  link,
}: {
  label: string
  value: string | null
  note?: string
  link?: { href: string; label: string; icon: typeof ExternalLink }
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <dt className="w-28 shrink-0 text-sm text-stone-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">
        {value ? value : <span className="text-stone-400">–</span>}
        {note ? <span className="ml-2 text-sm text-stone-500">{note}</span> : null}
      </dd>
      {value && link ? (
        <a
          href={link.href}
          target={link.href.startsWith('tel:') ? undefined : '_blank'}
          rel="noreferrer"
          className="btn-secondary min-w-tap px-2"
          aria-label={`${link.label} ${label}`}
        >
          <link.icon className="h-4 w-4" aria-hidden />
        </a>
      ) : null}
      {value ? <CopyButton text={value} compact label={`Copy ${label.toLowerCase()}`} /> : null}
    </div>
  )
}

type TimelineItem =
  { kind: 'message'; at: string; m: Message } | { kind: 'event'; at: string; e: LeadEvent }

function Timeline({ lead }: { lead: LeadDetail }) {
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = []
    for (const m of lead.messages)
      out.push({ kind: 'message', at: m.sent_at ?? m.scheduled_at ?? m.created_at, m })
    for (const e of lead.events) out.push({ kind: 'event', at: e.at, e })
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }, [lead])
  const [openMsg, setOpenMsg] = useState<string | null>(null)

  if (items.length === 0) return <p className="text-stone-500">Nothing has happened yet.</p>
  return (
    <ol className="space-y-2">
      {items.map((it) =>
        it.kind === 'message' ? (
          <li key={`m-${it.m.id}`} className="rounded-xl border border-stone-200 px-3 py-2">
            <button
              type="button"
              className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-left"
              onClick={() => setOpenMsg(openMsg === it.m.id ? null : it.m.id)}
            >
              <span className="font-medium">
                {it.m.direction === 'in' ? 'Reply' : CHANNEL_LABEL[it.m.channel]}{' '}
                <span className="font-normal text-stone-600">
                  {humanise(it.m.status).toLowerCase()}
                </span>
                {it.m.classification ? (
                  <Badge tone="amber">{humanise(it.m.classification)}</Badge>
                ) : null}
              </span>
              <time className="text-sm text-stone-500">{shortDateTime(it.at)}</time>
            </button>
            {it.m.subject ? <p className="text-sm text-stone-700">{it.m.subject}</p> : null}
            {openMsg === it.m.id ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-stone-800">{it.m.body}</p>
            ) : (
              <p className="truncate text-sm text-stone-500">{it.m.body}</p>
            )}
            {it.m.error ? <p className="text-sm text-red-700">{it.m.error}</p> : null}
          </li>
        ) : (
          <li
            key={`e-${it.e.id}`}
            className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1 text-sm"
          >
            <span className="text-stone-700">{humanise(it.e.kind)}</span>
            <time className="text-stone-500">{shortDateTime(it.at)}</time>
          </li>
        ),
      )}
    </ol>
  )
}

/** Property notes the web research found, stored with its raw result. */
function researchDetails(lead: {
  enrichment: Record<string, { data?: unknown } | undefined>
}): string[] {
  const data = lead.enrichment?.claude_research?.data as { property_details?: unknown } | null
  const list = data?.property_details
  return Array.isArray(list)
    ? list.filter((d): d is string => typeof d === 'string').slice(0, 20)
    : []
}

interface CheckedContact {
  field: string
  value: string
  role: 'owner' | 'manager' | 'agent'
  source_url: string
  verdict: 'verified' | 'likely' | 'rejected'
  reason: string
}

/** Contacts the web research checked (server/enrich/verify.ts), from its stored result. */
function checkedContacts(lead: {
  enrichment: Record<string, { data?: unknown } | undefined>
}): CheckedContact[] {
  const data = lead.enrichment?.claude_research?.data as { checked?: unknown } | null
  return Array.isArray(data?.checked) ? (data.checked as CheckedContact[]) : []
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

function sameValue(field: string, a: string, b: string): boolean {
  if (field === 'phone') return a.replace(/\D/g, '').endsWith(b.replace(/\D/g, '').slice(-10))
  return a.trim().toLowerCase().replace(/\/+$/, '') === b.trim().toLowerCase().replace(/\/+$/, '')
}

/** "Verified on hotpads.com" when research proved this value belongs to the owner. */
function proofNote(
  lead: { enrichment: Record<string, { data?: unknown } | undefined> },
  field: string,
  value: string | null,
): string | undefined {
  if (!value) return undefined
  const hit = checkedContacts(lead).find(
    (c) =>
      c.field === field &&
      c.role === 'owner' &&
      c.verdict !== 'rejected' &&
      sameValue(field, value, c.value),
  )
  if (!hit) return undefined
  return `${hit.verdict === 'verified' ? 'Verified' : 'Likely'} on ${sourceHost(hit.source_url)}`
}

/** Manager and agent contacts the research tied to their rentals. Never shown as the owner's. */
function otherContacts(lead: {
  enrichment: Record<string, { data?: unknown } | undefined>
}): CheckedContact[] {
  return checkedContacts(lead)
    .filter((c) => c.role !== 'owner' && c.verdict !== 'rejected')
    .slice(0, 10)
}
