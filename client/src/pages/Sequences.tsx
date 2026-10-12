// Sequences: the ones that are on first, then every turned-off sequence folded away, grouped by
// channel. Plus the edit view at /sequences/new and /sequences/:id.
import { Link, Route, Switch, useParams } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus, Pencil, Users } from 'lucide-react'
import type { Channel } from '@shared/types'
import type { Sequence } from '../types.ts'
import { getSettings, listSequences, updateSequence } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { Badge, Toggle } from '../components/Field.tsx'
import NotBuilt from '../components/NotBuilt.tsx'
import { Empty, QueryView } from '../components/QueryState.tsx'
import { ChannelIcon } from '../components/ChannelIcons.tsx'
import Readiness from '../components/Readiness.tsx'
import SequenceEditor from '../components/SequenceEditor.tsx'
import { CHANNEL_LABEL, PERSONA_LABEL, plural, triggerLabel } from '../lib/format.ts'
import { CHANNEL_ORDER } from '../lib/pickSequence.ts'

export default function Sequences() {
  return (
    <Switch>
      <Route path="/sequences/new">
        <SequenceEditor />
      </Route>
      <Route path="/sequences/:id">
        <EditById />
      </Route>
      <Route>
        <SequenceList />
      </Route>
    </Switch>
  )
}

function EditById() {
  const { id } = useParams<{ id: string }>()
  const q = useQuery({ queryKey: ['sequences'], queryFn: listSequences })
  return (
    <QueryView q={q} loading="Loading sequence">
      {(list) => {
        const seq = list.find((s) => s.id === id)
        if (!seq) {
          return (
            <Empty
              title="This sequence does not exist"
              hint="It may have been deleted. Go back to the list to pick another."
            />
          )
        }
        return <SequenceEditor key={seq.id} sequence={seq} />
      }}
    </QueryView>
  )
}

function SequenceList() {
  const q = useQuery({ queryKey: ['sequences'], queryFn: listSequences })
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const mainId = settings.data?.main_sequence_id ?? null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1>Sequences</h1>
        <Link href="/sequences/new" className="btn-primary">
          <Plus className="h-4 w-4" aria-hidden /> New sequence
        </Link>
      </div>
      <QueryView
        q={q}
        loading="Loading sequences"
        empty={
          <Empty
            title="No sequences yet"
            hint="The seed adds the default ones on first boot. You can also write your own with New sequence."
          />
        }
      >
        {(list) => {
          const on = list
            .filter((s) => s.active)
            .sort((a, b) => Number(b.id === mainId) - Number(a.id === mainId))
          const off = list.filter((s) => !s.active)
          return (
            <div className="space-y-6">
              <section>
                <h2 className="mb-2">Running</h2>
                {on.length === 0 ? (
                  <p className="text-stone-600">
                    Nothing is on. Open Turned off below and switch one on.
                  </p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {on.map((s) => (
                      <SequenceCard key={s.id} seq={s} main={s.id === mainId} />
                    ))}
                  </div>
                )}
              </section>
              {on.some((s) => s.id === mainId) ? <Readiness /> : null}
              {off.length > 0 ? (
                <details className="card">
                  <summary className="min-h-tap cursor-pointer py-2 text-lg font-medium">
                    Turned off ({off.length})
                  </summary>
                  <div className="mt-3 space-y-6">
                    {CHANNEL_ORDER.filter((ch) => off.some((s) => s.channel === ch)).map((ch) => (
                      <ChannelGroup
                        key={ch}
                        channel={ch}
                        items={off.filter((s) => s.channel === ch)}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          )
        }}
      </QueryView>
    </div>
  )
}

function ChannelGroup({ channel, items }: { channel: Channel; items: Sequence[] }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2">
        <ChannelIcon channel={channel} className="text-stone-500" /> {CHANNEL_LABEL[channel]}
      </h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((s) => (
          <SequenceCard key={s.id} seq={s} />
        ))}
      </div>
    </section>
  )
}

/** The channels a sequence's steps use, in order, without repeats in a row. */
function stepChannels(seq: Sequence): Channel[] {
  const out: Channel[] = []
  for (const s of seq.steps) if (out[out.length - 1] !== s.channel) out.push(s.channel)
  return out.length > 0 ? out : [seq.channel]
}

function SequenceCard({ seq, main = false }: { seq: Sequence; main?: boolean }) {
  const flow = stepChannels(seq)
  const toggle = useAction((active: boolean) => updateSequence(seq.id, { active }), {
    success: (r) => (r.active ? `${r.name} is on` : `${r.name} is paused`),
    invalidate: [['sequences'], ['readiness']],
  })
  return (
    <article className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-medium leading-tight">{seq.name}</h3>
        <Link
          href={`/sequences/${encodeURIComponent(seq.id)}`}
          className="btn-secondary min-w-tap shrink-0 px-2"
          aria-label={`Edit ${seq.name}`}
        >
          <Pencil className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      {flow.length > 1 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-stone-700">
          {flow.map((ch, i) => (
            <span key={`${ch}-${i}`} className="flex items-center gap-1.5">
              {i > 0 ? <ArrowRight className="h-4 w-4 text-stone-400" aria-hidden /> : null}
              <ChannelIcon channel={ch} className="text-stone-500" /> {CHANNEL_LABEL[ch]}
            </span>
          ))}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {main ? <Badge tone="green">New leads go here</Badge> : null}
        <Badge tone="blue">{PERSONA_LABEL[seq.persona]}</Badge>
        <Badge tone="amber">{triggerLabel(seq.trigger)}</Badge>
        <Badge>{plural(seq.steps.length, 'step')}</Badge>
      </div>
      {seq.description ? <p className="text-sm text-stone-600">{seq.description}</p> : null}
      <div className="mt-auto flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm text-stone-600">
          <Users className="h-4 w-4" aria-hidden />
          {seq.enrolled_count === undefined ? '–' : seq.enrolled_count} in it
        </span>
        <div className="w-40">
          <Toggle
            checked={seq.active}
            onChange={(v) => void toggle.run(v)}
            label={seq.active ? 'Active' : 'Paused'}
            disabled={toggle.busy}
          />
        </div>
      </div>
      {toggle.notBuilt ? <NotBuilt /> : null}
    </article>
  )
}
