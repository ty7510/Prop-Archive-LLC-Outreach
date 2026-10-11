// Edit one sequence: fields, steps, variable chips, live preview, test send, delete.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, Link } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, Send, Save, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { CHANNELS, SEQUENCE_PERSONAS, SEQUENCE_TRIGGERS } from '@shared/types'
import type {
  Channel,
  SequenceCreate,
  SequencePersona,
  SequenceStepInput,
  SequenceTrigger,
} from '@shared/types'
import type { Sequence } from '../types.ts'
import {
  createSequence,
  deleteSequence,
  previewSequence,
  testSendSequence,
  updateSequence,
  getSettings,
} from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { Chip, Field, Toggle } from './Field.tsx'
import Confirm from './Confirm.tsx'
import NotBuilt from './NotBuilt.tsx'
import { ErrorNote, Loading } from './QueryState.tsx'
import { CHANNEL_LABEL, PERSONA_LABEL, triggerLabel } from '../lib/format.ts'
import { TEMPLATE_VARS, insertAt, renderTemplate, SAMPLE_VARS } from '../lib/template.ts'

interface StepDraft extends SequenceStepInput {
  key: string
}

interface Draft {
  name: string
  channel: Channel
  persona: SequencePersona
  trigger: SequenceTrigger
  active: boolean
  description: string
  steps: StepDraft[]
}

let keyCounter = 0
const newKey = () => `k${++keyCounter}`

function fromSequence(seq: Sequence | undefined): Draft {
  if (!seq) {
    return {
      name: '',
      channel: 'email',
      persona: 'any',
      trigger: 'any',
      active: true,
      description: '',
      steps: [{ key: newKey(), step_index: 0, delay_days: 0, subject: '', body: '', notes: '' }],
    }
  }
  return {
    name: seq.name,
    channel: seq.channel,
    persona: seq.persona,
    trigger: seq.trigger,
    active: seq.active,
    description: seq.description ?? '',
    steps: [...seq.steps]
      .sort((a, b) => a.step_index - b.step_index)
      .map((s) => ({
        key: s.id,
        step_index: s.step_index,
        delay_days: s.delay_days,
        subject: s.subject ?? '',
        body: s.body,
        notes: s.notes ?? '',
      })),
  }
}

function toBody(d: Draft): SequenceCreate {
  return {
    name: d.name.trim(),
    channel: d.channel,
    persona: d.persona,
    trigger: d.trigger,
    active: d.active,
    description: d.description.trim() || null,
    steps: d.steps.map((s, i) => ({
      step_index: i,
      delay_days: Number(s.delay_days) || 0,
      subject: d.channel === 'email' ? (s.subject ?? '').trim() || null : null,
      body: s.body,
      notes: (s.notes ?? '').trim() || null,
    })),
  }
}

export default function SequenceEditor({ sequence }: { sequence?: Sequence }) {
  const [, navigate] = useLocation()
  const [draft, setDraft] = useState<Draft>(() => fromSequence(sequence))
  const saved = useMemo(() => JSON.stringify(toBody(fromSequence(sequence))), [sequence])
  const dirty = JSON.stringify(toBody(draft)) !== saved || !sequence
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Which textarea had focus last, so variable chips know where to insert.
  const focused = useRef<{ idx: number; el: HTMLTextAreaElement | HTMLInputElement } | null>(null)

  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })

  const save = useAction(
    () => (sequence ? updateSequence(sequence.id, toBody(draft)) : createSequence(toBody(draft))),
    {
      success: sequence ? 'Sequence saved' : 'Sequence created',
      invalidate: [['sequences']],
      onSuccess: (r) => {
        if (!sequence) navigate(`/sequences/${encodeURIComponent(r.id)}`, { replace: true })
      },
    },
  )
  const remove = useAction(() => deleteSequence(sequence!.id), {
    success: 'Sequence deleted',
    invalidate: [['sequences']],
    onSuccess: () => navigate('/sequences'),
  })
  const test = useAction(() => testSendSequence(sequence!.id), {
    success: `Test sent to ${settings.data?.owner_email ?? 'you'}`,
  })

  const problems: string[] = []
  if (!draft.name.trim()) problems.push('Give the sequence a name')
  if (draft.steps.length === 0) problems.push('Add at least one step')
  draft.steps.forEach((s, i) => {
    if (!s.body.trim()) problems.push(`Step ${i + 1} needs a body`)
  })

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }
  function updateStep(idx: number, patch: Partial<StepDraft>) {
    setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }))
  }
  function addStep() {
    setDraft((d) => ({
      ...d,
      steps: [
        ...d.steps,
        {
          key: newKey(),
          step_index: d.steps.length,
          delay_days: 3,
          subject: '',
          body: '',
          notes: '',
        },
      ],
    }))
  }
  function removeStep(idx: number) {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== idx) }))
  }
  function insertVar(name: string) {
    const token = `{{${name}}}`
    const f = focused.current
    const idx = f?.idx ?? 0
    const el = f?.el
    const step = draft.steps[idx]
    if (!step) return
    const isSubject = el instanceof HTMLInputElement
    const current = isSubject ? (step.subject ?? '') : step.body
    const start = el?.selectionStart ?? current.length
    const end = el?.selectionEnd ?? start
    const { text, caret } = insertAt(current, token, start, end)
    updateStep(idx, isSubject ? { subject: text } : { body: text })
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
      })
    }
  }

  const notBuilt = save.notBuilt || remove.notBuilt || test.notBuilt

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/sequences" className="btn-secondary">
          <ArrowLeft className="h-4 w-4" aria-hidden /> All sequences
        </Link>
        <h1 className="flex-1 truncate">{sequence ? sequence.name : 'New sequence'}</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Left: fields and steps */}
        <div className="space-y-4 lg:col-span-3">
          <section className="card grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <input
                className="input"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="Maya, new license, email"
              />
            </Field>
            <Field label="Channel">
              <select
                className="input"
                value={draft.channel}
                onChange={(e) => update({ channel: e.target.value as Channel })}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Persona">
              <select
                className="input"
                value={draft.persona}
                onChange={(e) => update({ persona: e.target.value as SequencePersona })}
              >
                {SEQUENCE_PERSONAS.map((p) => (
                  <option key={p} value={p}>
                    {PERSONA_LABEL[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Trigger">
              <select
                className="input"
                value={draft.trigger}
                onChange={(e) => update({ trigger: e.target.value as SequenceTrigger })}
              >
                {SEQUENCE_TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {triggerLabel(t)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Toggle
                checked={draft.active}
                onChange={(v) => update({ active: v })}
                label={draft.active ? 'Active' : 'Paused'}
              />
            </div>
            <Field label="Description" hint="For you, not sent to anyone" className="sm:col-span-2">
              <input
                className="input"
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
              />
            </Field>
          </section>

          <section className="card space-y-3">
            <h2 className="text-base font-semibold text-stone-700">Variables</h2>
            <p className="text-sm text-stone-600">Click one to insert it where your cursor is.</p>
            <div className="flex flex-wrap gap-2">
              {TEMPLATE_VARS.filter(
                (v) => v.name !== 'unsubscribe_link' || draft.channel === 'email',
              ).map((v) => (
                <Chip key={v.name} onClick={() => insertVar(v.name)} title={v.hint}>
                  {`{{${v.name}}}`}
                </Chip>
              ))}
            </div>
          </section>

          {draft.steps.map((s, i) => (
            <section key={s.key} className="card space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-stone-700">Step {i + 1}</h2>
                <button
                  type="button"
                  className="btn-secondary min-w-tap px-2"
                  onClick={() => removeStep(i)}
                  aria-label={`Remove step ${i + 1}`}
                  disabled={draft.steps.length <= 1}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={i === 0 ? 'Send on day' : 'Days after the step before'}>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    className="input"
                    value={s.delay_days}
                    onChange={(e) => updateStep(i, { delay_days: Number(e.target.value) })}
                  />
                </Field>
                {draft.channel === 'email' ? (
                  <Field label="Subject" className="sm:col-span-2">
                    <input
                      className="input"
                      value={s.subject ?? ''}
                      onFocus={(e) => (focused.current = { idx: i, el: e.currentTarget })}
                      onChange={(e) => updateStep(i, { subject: e.target.value })}
                      placeholder="Short and true"
                    />
                  </Field>
                ) : null}
              </div>
              <Field label={draft.channel === 'call' ? 'Call script' : 'Message'}>
                <textarea
                  className="input min-h-[160px] py-2 font-mono text-sm"
                  value={s.body}
                  onFocus={(e) => (focused.current = { idx: i, el: e.currentTarget })}
                  onChange={(e) => updateStep(i, { body: e.target.value })}
                  placeholder="Hi {{first_name}}, ..."
                />
              </Field>
              <Field label="Notes for you">
                <input
                  className="input"
                  value={s.notes ?? ''}
                  onChange={(e) => updateStep(i, { notes: e.target.value })}
                />
              </Field>
              <p className="text-sm text-stone-500">{s.body.length} characters</p>
            </section>
          ))}
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={addStep}
            disabled={draft.steps.length >= 20}
          >
            <Plus className="h-4 w-4" aria-hidden /> Add a step
          </button>
        </div>

        {/* Right: preview */}
        <div className="lg:col-span-2">
          <div className="space-y-3 lg:sticky lg:top-4">
            <Preview draft={draft} sequence={sequence} dirty={dirty} />
          </div>
        </div>
      </div>

      {notBuilt ? <NotBuilt what="Saving, deleting or test sending sequences." /> : null}

      <div className="sticky bottom-0 -mx-4 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={save.busy || problems.length > 0 || !dirty}
            onClick={() => void save.run()}
          >
            {save.busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            {sequence ? 'Save changes' : 'Create sequence'}
          </button>
          {sequence ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={test.busy}
              onClick={() => void test.run()}
              title={dirty ? 'Sends the saved version' : undefined}
            >
              <Send className="h-4 w-4" aria-hidden /> Send me a test
            </button>
          ) : null}
          {sequence ? (
            <button
              type="button"
              className="btn-secondary ml-auto text-red-700"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          ) : null}
          {problems.length > 0 ? (
            <span className="w-full text-sm text-amber-800 sm:w-auto">{problems[0]}</span>
          ) : null}
        </div>
      </div>

      <Confirm
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove.run()}
        title="Delete this sequence?"
        confirmLabel="Delete"
        danger
        busy={remove.busy}
      >
        <p>Leads already in it stop getting steps. Their past messages stay in their timeline.</p>
      </Confirm>
    </div>
  )
}

function Preview({
  draft,
  sequence,
  dirty,
}: {
  draft: Draft
  sequence: Sequence | undefined
  dirty: boolean
}) {
  const [useServer, setUseServer] = useState(true)
  const serverPreview = useQuery({
    queryKey: ['sequence-preview', sequence?.id],
    queryFn: () => previewSequence(sequence!.id),
    enabled: Boolean(sequence) && !dirty && useServer,
  })

  useEffect(() => {
    if (dirty) setUseServer(true)
  }, [dirty])

  const showServer = Boolean(sequence) && !dirty && useServer && !serverPreview.isError
  const local = draft.steps.map((s) => ({
    delay: s.delay_days,
    subject: draft.channel === 'email' && s.subject ? renderTemplate(s.subject, SAMPLE_VARS) : null,
    body: renderTemplate(s.body, SAMPLE_VARS),
  }))

  return (
    <section className="card space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-stone-700">Preview</h2>
        <span className="text-sm text-stone-500">
          {showServer
            ? 'From the server, sample lead'
            : dirty && sequence
              ? 'Unsaved draft, sample values'
              : 'Sample values'}
        </span>
      </div>
      {showServer ? (
        serverPreview.isLoading ? (
          <Loading text="Rendering" />
        ) : (
          <div className="space-y-3">
            {(serverPreview.data ?? []).map((st) => (
              <PreviewStep
                key={st.step_id}
                n={st.step_index + 1}
                delay={st.delay_days}
                subject={st.subject}
                body={st.body}
              />
            ))}
            {serverPreview.data && serverPreview.data.length === 0 ? (
              <p className="text-stone-500">No steps to show.</p>
            ) : null}
          </div>
        )
      ) : (
        <div className="space-y-3">
          {sequence && !dirty && serverPreview.isError ? (
            <ErrorNote error={serverPreview.error} />
          ) : null}
          {local.map((st, i) => (
            <PreviewStep
              key={draft.steps[i]?.key ?? i}
              n={i + 1}
              delay={st.delay}
              subject={st.subject?.text ?? null}
              body={st.body.text}
              missing={[...(st.subject?.missing ?? []), ...st.body.missing]}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function PreviewStep({
  n,
  delay,
  subject,
  body,
  missing = [],
}: {
  n: number
  delay: number
  subject: string | null
  body: string
  missing?: string[]
}) {
  return (
    <article className="rounded-xl border border-stone-200 bg-stone-50 p-3">
      <p className="mb-1 text-sm text-stone-500">
        Step {n}, {n === 1 ? `day ${delay}` : `${delay} days later`}
      </p>
      {subject ? <p className="font-medium">{subject}</p> : null}
      <p
        className={clsx(
          'whitespace-pre-wrap text-sm',
          body.trim() ? 'text-stone-800' : 'text-stone-400',
        )}
      >
        {body.trim() ? body : 'Nothing written yet'}
      </p>
      {missing.length ? (
        <p className="mt-2 text-sm text-amber-800">
          Unknown variables: {missing.map((m) => `{{${m}}}`).join(', ')}
        </p>
      ) : null}
    </article>
  )
}
