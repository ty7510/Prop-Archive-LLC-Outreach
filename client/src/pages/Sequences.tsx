// Sequences: cards grouped by channel, plus the edit view at /sequences/new and /sequences/:id.
import { Link, Route, Switch, useParams } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { Plus, Pencil, Users } from 'lucide-react'
import type { Channel } from '@shared/types'
import type { Sequence } from '../types.ts'
import { listSequences, updateSequence } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { Badge, Toggle } from '../components/Field.tsx'
import NotBuilt from '../components/NotBuilt.tsx'
import { Empty, QueryView } from '../components/QueryState.tsx'
import { ChannelIcon } from '../components/ChannelIcons.tsx'
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
        {(list) => (
          <div className="space-y-6">
            {CHANNEL_ORDER.filter((ch) => list.some((s) => s.channel === ch)).map((ch) => (
              <ChannelGroup key={ch} channel={ch} items={list.filter((s) => s.channel === ch)} />
            ))}
          </div>
        )}
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

function SequenceCard({ seq }: { seq: Sequence }) {
  const toggle = useAction((active: boolean) => updateSequence(seq.id, { active }), {
    success: (r) => (r.active ? `${r.name} is on` : `${r.name} is paused`),
    invalidate: [['sequences']],
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
      <div className="flex flex-wrap gap-1.5">
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
