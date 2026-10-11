// Leads: filter chips, search, table (cards on phones), bulk buttons, side panel.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  Search,
  Upload,
  Sparkles,
  Wand2,
  Play,
  Compass,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import clsx from 'clsx'
import type { LeadStatus, Paged } from '@shared/types'
import type { Lead } from '../types.ts'
import {
  discoverLeads,
  enrichLeads,
  enrollLead,
  getSettings,
  importCsv,
  listLeads,
  listSequences,
  isNotBuilt,
} from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { useToast } from '../components/Toast.tsx'
import { Badge, Chip } from '../components/Field.tsx'
import ChannelIcons from '../components/ChannelIcons.tsx'
import NotBuilt from '../components/NotBuilt.tsx'
import Confirm from '../components/Confirm.tsx'
import { Empty, ErrorNote, Loading } from '../components/QueryState.tsx'
import LeadPanel from '../components/LeadPanel.tsx'
import { pickSequence, type SequencePick } from '../lib/pickSequence.ts'
import {
  CHANNEL_LABEL,
  PERSONA_SHORT,
  leadName,
  leadNeighbourhood,
  orDash,
  plural,
  relativeTime,
  statusLabel,
} from '../lib/format.ts'

interface ChipDef {
  key: string
  label: string
  statuses: LeadStatus[]
}

const CHIPS: ChipDef[] = [
  { key: 'not_enriched', label: 'Not enriched', statuses: ['new', 'enriching'] },
  { key: 'enriched', label: 'Enriched', statuses: ['enriched'] },
  { key: 'in_sequence', label: 'In sequence', statuses: ['enrolled', 'contacted'] },
  { key: 'replied', label: 'Replied', statuses: ['replied'] },
  { key: 'booked_joined', label: 'Booked or joined', statuses: ['booked', 'joined'] },
  { key: 'everyone', label: 'Everyone', statuses: [] },
]

const PAGE_SIZE = 50

export const PERSONA_TONE: Record<string, 'green' | 'blue' | 'purple' | 'stone'> = {
  maya: 'green',
  ray: 'blue',
  denise: 'purple',
  unknown: 'stone',
}

export const STATUS_TONE: Record<string, 'stone' | 'green' | 'blue' | 'amber' | 'red' | 'purple'> =
  {
    new: 'stone',
    enriching: 'amber',
    enriched: 'blue',
    enrolled: 'blue',
    contacted: 'blue',
    replied: 'amber',
    booked: 'green',
    joined: 'green',
    not_interested: 'stone',
    unsubscribed: 'red',
    bounced: 'red',
    disqualified: 'stone',
  }

function lastActivity(lead: Lead): string | null {
  return lead.last_replied_at ?? lead.last_contacted_at ?? lead.next_action_at ?? lead.updated_at
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

export default function Leads() {
  const toast = useToast()
  const [, navigate] = useLocation()
  const search = useSearch()
  const urlId = useMemo(() => new URLSearchParams(search).get('id'), [search])

  const [chip, setChip] = useState<string>('everyone')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(urlId)
  const dq = useDebounced(q.trim(), 300)

  useEffect(() => {
    setOpenId(urlId)
  }, [urlId])

  useEffect(() => {
    setPage(1)
  }, [chip, dq])

  const chipDef = CHIPS.find((c) => c.key === chip) ?? CHIPS[CHIPS.length - 1]!
  const statusList: (LeadStatus | undefined)[] = chipDef.statuses.length
    ? chipDef.statuses
    : [undefined]

  const queries = useQueries({
    queries: statusList.map((status) => ({
      queryKey: ['leads', { status: status ?? '', q: dq, page }],
      queryFn: () => listLeads({ status, q: dq, page, limit: PAGE_SIZE }),
    })),
  })
  const loading = queries.some((x) => x.isLoading)
  const errored = queries.find((x) => x.isError)
  const pages = queries.map((x) => x.data).filter((d): d is Paged<Lead> => Boolean(d))
  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: Lead[] = []
    for (const p of pages) {
      for (const l of p.items) {
        if (!seen.has(l.id)) {
          seen.add(l.id)
          out.push(l)
        }
      }
    }
    return out
  }, [pages])
  const total = pages.reduce((n, p) => n + p.total, 0)
  const hasMore = pages.some((p) => p.page * p.limit < p.total)
  const refetchAll = () => queries.forEach((x) => void x.refetch())

  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: listSequences })

  // ---- bulk actions ----
  const discover = useAction(discoverLeads, {
    success: (r) => `Found ${r.created} new, merged ${r.merged}, skipped ${r.skipped}`,
    invalidate: [['leads'], ['activity']],
  })
  const enrich = useAction(enrichLeads, {
    success: (r) => `Enriched ${r.enriched}, failed ${r.failed}, skipped ${r.skipped}`,
    invalidate: [['leads'], ['activity']],
    onSuccess: () => setSelected(new Set()),
  })
  const [importResult, setImportResult] = useState<string | null>(null)
  const doImport = useAction(importCsv, {
    invalidate: [['leads']],
    onSuccess: (r) => {
      setImportResult(
        `${r.filename}: ${r.row_count} rows, ${r.created} new, ${r.merged} merged, ${r.skipped} skipped` +
          (r.errors.length
            ? `. ${plural(r.errors.length, 'problem')}: ${r.errors.slice(0, 3).join('; ')}`
            : ''),
      )
    },
  })
  const fileRef = useRef<HTMLInputElement>(null)

  // Start sequence: pick per lead, confirm, enroll one by one.
  const [picks, setPicks] = useState<SequencePick[] | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [enrollNotBuilt, setEnrollNotBuilt] = useState(false)
  function openStartSequence() {
    if (!settings.data || !sequences.data) {
      toast.error('Settings and sequences are still loading')
      return
    }
    const chosen = items.filter((l) => selected.has(l.id))
    setPicks(chosen.map((l) => pickSequence(l, settings.data!, sequences.data!)))
  }
  async function confirmStart() {
    if (!picks) return
    setEnrolling(true)
    let ok = 0
    let failed = 0
    for (const p of picks) {
      if (!p.sequence) continue
      try {
        await enrollLead(p.lead.id, { sequence_id: p.sequence.id })
        ok++
      } catch (err) {
        if (isNotBuilt(err)) {
          setEnrollNotBuilt(true)
          break
        }
        failed++
      }
    }
    setEnrolling(false)
    setPicks(null)
    if (ok) toast.ok(`Started ${plural(ok, 'sequence')}`)
    if (failed) toast.error(`${plural(failed, 'lead')} could not be started`)
    if (ok) {
      setSelected(new Set())
      refetchAll()
    }
  }

  const anyNotBuilt = errored && isNotBuilt(errored.error)
  const allOnPageSelected = items.length > 0 && items.every((l) => selected.has(l.id))

  function toggleAll() {
    setSelected((s) => {
      const next = new Set(s)
      if (allOnPageSelected) items.forEach((l) => next.delete(l.id))
      else items.forEach((l) => next.add(l.id))
      return next
    })
  }
  function toggleOne(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function open(id: string | null) {
    setOpenId(id)
    navigate(id ? `/leads?id=${encodeURIComponent(id)}` : '/leads', { replace: true })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1>Leads</h1>
        {total > 0 ? <span className="text-stone-600">{plural(total, 'lead')}</span> : null}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CHIPS.map((c) => (
          <Chip key={c.key} active={chip === c.key} onClick={() => setChip(c.key)}>
            {c.label}
          </Chip>
        ))}
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <input
            type="search"
            className="input pl-10"
            placeholder="Search name, company, email, street"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search leads"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void discover.run({})}
          disabled={discover.busy}
        >
          {discover.busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Compass className="h-4 w-4" aria-hidden />
          )}
          Find new leads
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={doImport.busy}
        >
          {doImport.busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Upload className="h-4 w-4" aria-hidden />
          )}
          Import CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="Choose a CSV file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void doImport.run(f)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={selected.size === 0 || enrich.busy}
          onClick={() => void enrich.run({ ids: [...selected] })}
        >
          <Sparkles className="h-4 w-4" aria-hidden /> Enrich selected
          {selected.size ? ` (${selected.size})` : ''}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={enrich.busy}
          onClick={() => void enrich.run({ all: true })}
        >
          <Wand2 className="h-4 w-4" aria-hidden /> Enrich all not enriched
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={selected.size === 0}
          onClick={openStartSequence}
        >
          <Play className="h-4 w-4" aria-hidden /> Start sequence
          {selected.size ? ` (${selected.size})` : ''}
        </button>
      </div>

      {discover.notBuilt ? <NotBuilt what="Finding new leads from the city records." /> : null}
      {doImport.notBuilt ? <NotBuilt what="CSV import." /> : null}
      {enrich.notBuilt ? <NotBuilt what="Enrichment." /> : null}
      {enrollNotBuilt ? <NotBuilt what="Starting sequences." /> : null}
      {importResult ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-emerald-900" role="status">
          {importResult}
        </p>
      ) : null}
      {doImport.error ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-red-800" role="alert">
          {doImport.error}
        </p>
      ) : null}

      {loading ? <Loading text="Loading leads" /> : null}
      {errored && !loading ? <ErrorNote error={errored.error} retry={refetchAll} /> : null}
      {!loading && !anyNotBuilt && !errored && items.length === 0 ? (
        <Empty
          title={dq ? `Nothing matches "${dq}"` : 'No leads here yet'}
          hint={
            dq
              ? 'Try a shorter search.'
              : 'Press "Find new leads" or import your CSV to get started.'
          }
        />
      ) : null}

      {items.length > 0 ? (
        <>
          {/* Desktop table */}
          <div className="card hidden overflow-hidden p-0 md:block">
            <table className="w-full table-fixed text-left">
              <thead className="bg-stone-50 text-sm text-stone-600">
                <tr>
                  <th className="w-12 px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={allOnPageSelected}
                      onChange={toggleAll}
                      aria-label="Select everyone on this page"
                    />
                  </th>
                  <th className="px-3 py-2">Name</th>
                  <th className="w-24 px-3 py-2">Persona</th>
                  <th className="w-28 px-3 py-2">Props / units</th>
                  <th className="w-44 px-3 py-2">Neighbourhood</th>
                  <th className="w-36 px-3 py-2">Channels</th>
                  <th className="w-36 px-3 py-2">Status</th>
                  <th className="w-28 px-3 py-2">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {items.map((l) => (
                  <tr
                    key={l.id}
                    className={clsx(
                      'cursor-pointer hover:bg-stone-50',
                      openId === l.id && 'bg-emerald-50',
                    )}
                    onClick={() => open(l.id)}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={selected.has(l.id)}
                        onChange={() => toggleOne(l.id)}
                        aria-label={`Select ${leadName(l)}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="truncate font-medium">{leadName(l)}</div>
                      {l.company && l.full_name ? (
                        <div className="truncate text-sm text-stone-500">{l.company}</div>
                      ) : null}
                      {l.do_not_contact ? <Badge tone="red">Do not contact</Badge> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={PERSONA_TONE[l.persona] ?? 'stone'}>
                        {PERSONA_SHORT[l.persona]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {orDash(l.property_count || null)} / {orDash(l.unit_count || null)}
                    </td>
                    <td className="truncate px-3 py-2">{orDash(leadNeighbourhood(l))}</td>
                    <td className="px-3 py-2">
                      <ChannelIcons channels={l.channels} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[l.status] ?? 'stone'}>{statusLabel(l.status)}</Badge>
                    </td>
                    <td className="px-3 py-2 text-sm text-stone-600">
                      {relativeTime(lastActivity(l))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone cards */}
          <ul className="space-y-2 md:hidden">
            <li className="flex items-center gap-3 px-1 text-sm text-stone-600">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={allOnPageSelected}
                onChange={toggleAll}
                aria-label="Select everyone on this page"
              />
              Select all on this page
            </li>
            {items.map((l) => (
              <li
                key={l.id}
                className={clsx(
                  'card flex gap-3 p-3',
                  openId === l.id && 'ring-2 ring-emerald-500',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0"
                  checked={selected.has(l.id)}
                  onChange={() => toggleOne(l.id)}
                  aria-label={`Select ${leadName(l)}`}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => open(l.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate font-medium">{leadName(l)}</span>
                    <Badge tone={PERSONA_TONE[l.persona] ?? 'stone'}>
                      {PERSONA_SHORT[l.persona]}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600">
                    <span>
                      {orDash(l.property_count || null)} props, {orDash(l.unit_count || null)} units
                    </span>
                    <span>{orDash(leadNeighbourhood(l))}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <ChannelIcons channels={l.channels} />
                    <Badge tone={STATUS_TONE[l.status] ?? 'stone'}>{statusLabel(l.status)}</Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              className="btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
            </button>
            <span className="text-sm text-stone-600">Page {page}</span>
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </>
      ) : null}

      <Confirm
        open={picks !== null}
        onClose={() => setPicks(null)}
        onConfirm={() => void confirmStart()}
        title="Start sequence"
        confirmLabel={`Start for ${plural(picks?.filter((p) => p.sequence).length ?? 0, 'lead')}`}
        busy={enrolling}
      >
        <p>The sequence is picked from Settings by each lead's persona.</p>
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {(picks ?? []).map((p) => (
            <li
              key={p.lead.id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg bg-stone-50 px-3 py-2"
            >
              <span className="font-medium">{leadName(p.lead)}</span>
              {p.sequence ? (
                <span className="text-stone-700">
                  {p.sequence.name}{' '}
                  <span className="text-stone-500">({CHANNEL_LABEL[p.channel!]})</span>
                </span>
              ) : (
                <span className="text-amber-800">Skipped: {p.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </Confirm>

      {openId ? (
        <LeadPanel
          id={openId}
          onClose={() => open(null)}
          onChanged={refetchAll}
          settings={settings.data}
          sequences={sequences.data}
        />
      ) : null}
    </div>
  )
}
