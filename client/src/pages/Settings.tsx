// Settings: every section from spec section 7 and 12, a sticky Save bar, Live mode with a confirm.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Loader2, KeyRound, Plus } from 'lucide-react'
import clsx from 'clsx'
import type { Settings as SettingsT } from '@shared/settings'
import { ENRICH_PROVIDER_IDS, type EnrichProviderId } from '@shared/settings'
import {
  CHANNELS,
  PERSONAS,
  type Channel,
  type Persona,
  type ProviderKeyGroup,
  type ProvidersResponse,
} from '@shared/types'
import type { Sequence } from '../types.ts'
import { getProviders, getReadiness, getSettings, listSequences, putSettings } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { useToast } from '../components/Toast.tsx'
import { Badge, Chip, Field, Section, Toggle } from '../components/Field.tsx'
import Confirm from '../components/Confirm.tsx'
import CopyButton from '../components/CopyButton.tsx'
import InboxEditor from '../components/InboxEditor.tsx'
import Readiness from '../components/Readiness.tsx'
import { ErrorNote, Loading } from '../components/QueryState.tsx'
import { CHANNEL_LABEL, PERSONA_LABEL, humanise } from '../lib/format.ts'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const PROVIDER_INFO: Record<
  EnrichProviderId,
  { label: string; hint: string; key: ProviderKeyGroup | null }
> = {
  li_license: {
    label: 'City rental licenses',
    hint: 'Free. Turns an LLC into a person and adds unit counts.',
    key: null,
  },
  claude_research: {
    label: 'Claude web research',
    hint: 'Finds and checks owner contacts on the web. Uses the Claude key; an organization key also needs Claude_Workspace_ID.',
    key: 'anthropic',
  },
  hunter: {
    label: 'Hunter',
    hint: 'Finds and checks work emails when a website is known. Optional; needs a hunter.io account.',
    key: 'hunter',
  },
  apollo: {
    label: 'Apollo',
    hint: 'Best for management companies. Optional; needs an apollo.io account.',
    key: 'apollo',
  },
  pdl: {
    label: 'People Data Labs',
    hint: 'Person lookup by name and company. Optional; needs a peopledatalabs.com account.',
    key: 'pdl',
  },
}

type CapKey = keyof SettingsT['enrichment']['monthly_credit_cap']

function keysOf(s: SettingsT) {
  return Object.keys(s) as (keyof SettingsT)[]
}

/** Top-level keys whose value differs. The PUT sends only these. */
function changedKeys(a: SettingsT, b: SettingsT): Partial<SettingsT> {
  const out: Partial<SettingsT> = {}
  for (const k of keysOf(b)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) (out as Record<string, unknown>)[k] = b[k]
  }
  return out
}

export default function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const providers = useQuery({ queryKey: ['providers'], queryFn: getProviders })
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: listSequences })

  if (q.isLoading) return <Loading text="Loading settings" />
  if (q.isError || !q.data) return <ErrorNote error={q.error} retry={() => void q.refetch()} />
  return <SettingsForm saved={q.data} providers={providers.data} sequences={sequences.data} />
}

function SettingsForm({
  saved,
  providers,
  sequences,
}: {
  saved: SettingsT
  providers: ProvidersResponse | undefined
  sequences: Sequence[] | undefined
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [draft, setDraft] = useState<SettingsT>(saved)
  const [zipInput, setZipInput] = useState('')
  const [liveConfirm, setLiveConfirm] = useState(false)

  // When the server copy changes under us (another tab, live toggle), keep untouched fields fresh.
  useEffect(() => {
    setDraft((d) => ({ ...saved, ...changedKeys(saved, d) }))
  }, [saved])

  useEffect(() => {
    if (window.location.hash === '#danger') {
      document.getElementById('danger')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  const patch = useMemo(() => changedKeys(saved, draft), [saved, draft])
  const dirtyCount = Object.keys(patch).length

  const save = useAction((body: Partial<SettingsT>) => putSettings(body), {
    success: 'Settings saved',
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s)
      void qc.invalidateQueries({ queryKey: ['health'] })
      void qc.invalidateQueries({ queryKey: ['autopilot'] })
      void qc.invalidateQueries({ queryKey: ['readiness'] })
    },
  })

  function set<K extends keyof SettingsT>(key: K, value: SettingsT[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function addZip(raw: string) {
    const z = raw.trim()
    if (!/^\d{5}$/.test(z)) {
      toast.error('A zip is five digits')
      return
    }
    if (!draft.target_zips.includes(z)) set('target_zips', [...draft.target_zips, z])
    setZipInput('')
  }

  async function setLive(next: boolean) {
    const r = await save.run({ live_mode: next })
    if (r) setLiveConfirm(false)
  }

  // The Live switch only saves live_mode, so the confirm must describe the SAVED settings:
  // those are what the next round runs with, whatever is still unsaved in the form.
  // Warmed inboxes from Settings (a saved password shows as the mask, which still counts).
  const sendingInboxes = saved.sending_inboxes.filter(
    (i) => i.active && i.daily_limit > 0 && i.smtp_host && i.smtp_user && i.smtp_pass,
  ).length
  const readingInboxes =
    saved.sending_inboxes.filter((i) => i.imap_host && i.smtp_user && i.smtp_pass).length +
    (providers?.imap ? 1 : 0)
  // Same fallback as the server: an SMTP or Resend secret sends when no inbox can.
  const secretSender = Boolean(providers?.smtp || providers?.resend)
  const mailKeyPresent = draft.mail_provider === 'lob' ? providers?.lob : true
  // The Claude row says whether the key WORKS, from the checklist's live test.
  const readiness = useQuery({ queryKey: ['readiness'], queryFn: getReadiness })
  const claudeItem = readiness.data?.find((r) => r.key === 'enrich')
  const enabledChannels = CHANNELS.filter((c) => saved.channels[c])

  return (
    <div className="space-y-4 pb-24">
      <h1>Settings</h1>

      <Readiness />

      <Section
        title="Who you are"
        intro="Goes on every email. The address is required by law before live email."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Your name">
            <input
              className="input"
              value={draft.owner_name}
              onChange={(e) => set('owner_name', e.target.value)}
            />
          </Field>
          <Field label="Your email" hint="Replies and test sends go here">
            <input
              className="input"
              type="email"
              value={draft.owner_email}
              onChange={(e) => set('owner_email', e.target.value)}
            />
          </Field>
          <Field label="From name">
            <input
              className="input"
              value={draft.from_name}
              onChange={(e) => set('from_name', e.target.value)}
            />
          </Field>
          <Field label="From email">
            <input
              className="input"
              type="email"
              value={draft.from_email}
              onChange={(e) => set('from_email', e.target.value)}
            />
          </Field>
          <Field label="Reply to">
            <input
              className="input"
              type="email"
              value={draft.reply_to}
              onChange={(e) => set('reply_to', e.target.value)}
            />
          </Field>
          <Field
            label="Physical mailing address"
            hint="Printed in the footer of every email"
            className="sm:col-span-2"
          >
            <input
              className={clsx('input', !draft.physical_address.trim() && 'border-amber-400')}
              value={draft.physical_address}
              onChange={(e) => set('physical_address', e.target.value)}
              placeholder="Street, city, state, zip"
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Sending inboxes"
        intro="The warmed addresses the sequence emails from. The app takes turns between them, never sends more than each one's daily limit, and reads replies from each one so a lead who answers gets nothing more. Press Save after adding."
      >
        <InboxEditor
          inboxes={draft.sending_inboxes}
          defaultFromName={draft.owner_name}
          onChange={(next) => set('sending_inboxes', next)}
        />
      </Section>

      <Section
        title="Your accounts for the sequence"
        intro="The app cannot post on LinkedIn, Instagram or Facebook for you. Each day Go lists who to message and what to send, and shows the account to send it from."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Your LinkedIn profile" hint="The account you send connection notes from">
            <input
              className="input"
              value={draft.my_linkedin_url}
              placeholder="https://www.linkedin.com/in/your-name"
              onChange={(e) => set('my_linkedin_url', e.target.value)}
            />
          </Field>
          <Field label="Your Instagram account">
            <input
              className="input"
              value={draft.my_instagram}
              placeholder="@proparchive"
              onChange={(e) => set('my_instagram', e.target.value)}
            />
          </Field>
          <Field label="Your Facebook page or profile">
            <input
              className="input"
              value={draft.my_facebook}
              placeholder="https://www.facebook.com/proparchive"
              onChange={(e) => set('my_facebook', e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section title="Who to target" intro="Philadelphia owners with a few to twenty properties.">
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Zip codes</span>
          <div className="flex flex-wrap gap-2">
            {draft.target_zips.map((z) => (
              <Chip
                key={z}
                onRemove={() =>
                  set(
                    'target_zips',
                    draft.target_zips.filter((x) => x !== z),
                  )
                }
              >
                {z}
              </Chip>
            ))}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                addZip(zipInput)
              }}
            >
              <input
                className="input w-28"
                inputMode="numeric"
                placeholder="Add zip"
                value={zipInput}
                onChange={(e) => setZipInput(e.target.value)}
                aria-label="Add a zip code"
              />
              <button type="submit" className="btn-secondary" disabled={!zipInput.trim()}>
                <Plus className="h-4 w-4" aria-hidden /> Add
              </button>
            </form>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="At least this many properties">
            <input
              type="number"
              min={0}
              className="input"
              value={draft.min_props}
              onChange={(e) => set('min_props', Number(e.target.value))}
            />
          </Field>
          <Field label="At most this many">
            <input
              type="number"
              min={0}
              className="input"
              value={draft.max_props}
              onChange={(e) => set('max_props', Number(e.target.value))}
            />
          </Field>
          <Field label="Minimum fit score" hint="0 to 100">
            <input
              type="number"
              min={0}
              max={100}
              className="input"
              value={draft.min_icp_score}
              onChange={(e) => set('min_icp_score', Number(e.target.value))}
            />
          </Field>
          <Field label="New leads per day" hint="Cap for Find new leads">
            <input
              type="number"
              min={0}
              className="input"
              value={draft.max_new_leads_per_day}
              onChange={(e) => set('max_new_leads_per_day', Number(e.target.value))}
            />
          </Field>
          <Field label="Days between emails" hint="To one person, all their LLCs together">
            <input
              type="number"
              min={0}
              max={60}
              className="input"
              value={draft.min_days_between_emails}
              onChange={(e) => set('min_days_between_emails', Number(e.target.value))}
            />
          </Field>
          <Field label="Days between postcards" hint="One per mailing address">
            <input
              type="number"
              min={0}
              max={365}
              className="input"
              value={draft.days_between_postcards}
              onChange={(e) => set('days_between_postcards', Number(e.target.value))}
            />
          </Field>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Personas</span>
          <div className="flex flex-wrap gap-4">
            {PERSONAS.map((p) => (
              <label key={p} className="flex min-h-tap items-center gap-2">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={draft.personas.includes(p)}
                  onChange={(e) =>
                    set(
                      'personas',
                      e.target.checked
                        ? [...draft.personas, p].filter((x, i, a) => a.indexOf(x) === i)
                        : draft.personas.filter((x) => x !== p),
                    )
                  }
                />
                {PERSONA_LABEL[p]}
              </label>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="To-do list"
        intro="Each weekday the app puts people on the Go page with every step at once: their LinkedIn note, their postcard and a call. When every step is done they move to Complete, and they come back if they have not replied."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="New people per day" hint="Each one gets a LinkedIn note">
            <input
              type="number"
              min={0}
              max={100}
              className="input"
              value={draft.people_per_day}
              onChange={(e) => set('people_per_day', Number(e.target.value))}
            />
          </Field>
          <Field label="Days before they come back" hint="After their last step, if no reply">
            <input
              type="number"
              min={1}
              max={365}
              className="input"
              value={draft.recycle_after_days}
              onChange={(e) => set('recycle_after_days', Number(e.target.value))}
            />
          </Field>
          <Field
            label="LinkedIn searches per month"
            hint="The app finds profiles, about 4 cents each"
          >
            <input
              type="number"
              min={0}
              className="input"
              value={draft.enrichment.linkedin_find_cap}
              onChange={(e) =>
                set('enrichment', {
                  ...draft.enrichment,
                  linkedin_find_cap: Number(e.target.value),
                })
              }
            />
          </Field>
        </div>
        <Toggle
          checked={draft.sequences_on}
          onChange={(v) => set('sequences_on', v)}
          label="Timed sequences instead (the old way)"
          description="On: steps come up one at a time on their day instead of the to-do list."
        />
      </Section>

      <Section
        title="Channels"
        intro="Turn a channel on and set how many per day. LinkedIn, Instagram, calls and postcards are done by you. With Email off the app sends no email and skips the email steps."
      >
        <div className="divide-y divide-stone-100">
          {CHANNELS.map((c) => (
            <div key={c} className="flex flex-wrap items-center gap-3 py-2">
              <div className="w-44 shrink-0">
                <Toggle
                  checked={draft.channels[c]}
                  onChange={(v) => set('channels', { ...draft.channels, [c]: v })}
                  label={CHANNEL_LABEL[c]}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                Per day
                <input
                  type="number"
                  min={0}
                  max={1000}
                  className="input w-24"
                  value={draft.daily_caps[c]}
                  onChange={(e) =>
                    set('daily_caps', { ...draft.daily_caps, [c]: Number(e.target.value) })
                  }
                  aria-label={`${CHANNEL_LABEL[c]} per day`}
                />
              </label>
              {c === 'email' ? (
                sendingInboxes > 0 ? (
                  <Badge tone="green">
                    Sends from {sendingInboxes} warmed {sendingInboxes === 1 ? 'inbox' : 'inboxes'}
                  </Badge>
                ) : saved.sending_inboxes.length > 0 ? (
                  <Badge tone="amber">
                    No inbox can send: switch one on, or type its app password again
                  </Badge>
                ) : secretSender ? (
                  <Badge tone="green">Sends with the email secrets in Replit</Badge>
                ) : (
                  <Badge tone="amber">No sending inbox yet: add one under Sending inboxes</Badge>
                )
              ) : null}
              {c === 'mail' ? (
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  Send with
                  <select
                    className="input w-32"
                    value={draft.mail_provider}
                    onChange={(e) =>
                      set('mail_provider', e.target.value as SettingsT['mail_provider'])
                    }
                  >
                    <option value="print">Print myself</option>
                    <option value="lob">Lob</option>
                  </select>
                  {draft.mail_provider === 'lob' ? (
                    <KeyBadge present={mailKeyPresent} keys={providers?.env_keys.lob} />
                  ) : null}
                </label>
              ) : null}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <span className="block text-sm font-medium text-stone-700">Send window</span>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => (
              <Chip
                key={d}
                active={draft.send_window.days.includes(i)}
                onClick={() =>
                  set('send_window', {
                    ...draft.send_window,
                    days: draft.send_window.days.includes(i)
                      ? draft.send_window.days.filter((x) => x !== i)
                      : [...draft.send_window.days, i].sort(),
                  })
                }
              >
                {d}
              </Chip>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From">
              <input
                type="time"
                className="input"
                value={draft.send_window.start}
                onChange={(e) =>
                  set('send_window', { ...draft.send_window, start: e.target.value })
                }
              />
            </Field>
            <Field label="Until">
              <input
                type="time"
                className="input"
                value={draft.send_window.end}
                onChange={(e) => set('send_window', { ...draft.send_window, end: e.target.value })}
              />
            </Field>
            <Field label="Time zone">
              <input
                className="input"
                value={draft.send_window.tz}
                onChange={(e) => set('send_window', { ...draft.send_window, tz: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </Section>

      <Section
        title="Finding people"
        intro="Providers run in this order and keep going until a lead has every contact field, or none is left to try."
      >
        <div className="divide-y divide-stone-100">
          {ENRICH_PROVIDER_IDS.map((id) => {
            const info = PROVIDER_INFO[id]
            const on = draft.enrichment.providers.includes(id)
            const present = info.key ? providers?.[info.key] : true
            const capKey = id as CapKey
            const hasCap = id in draft.enrichment.monthly_credit_cap
            return (
              <div key={id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-[14rem] flex-1">
                  <Toggle
                    checked={on}
                    onChange={(v) =>
                      set('enrichment', {
                        ...draft.enrichment,
                        providers: ENRICH_PROVIDER_IDS.filter((p) =>
                          p === id ? v : draft.enrichment.providers.includes(p),
                        ),
                      })
                    }
                    label={info.label}
                    description={info.hint}
                  />
                </div>
                {hasCap ? (
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    Per month
                    <input
                      type="number"
                      min={0}
                      className="input w-24"
                      value={draft.enrichment.monthly_credit_cap[capKey]}
                      onChange={(e) =>
                        set('enrichment', {
                          ...draft.enrichment,
                          monthly_credit_cap: {
                            ...draft.enrichment.monthly_credit_cap,
                            [capKey]: Number(e.target.value),
                          },
                        })
                      }
                      aria-label={`${info.label} per month`}
                    />
                  </label>
                ) : null}
                {info.key ? (
                  info.key === 'anthropic' && present && claudeItem ? (
                    claudeItem.ok ? (
                      <Badge tone="green">Key works</Badge>
                    ) : (
                      <Badge tone="amber">
                        Key found but not working: see the checklist at the top
                      </Badge>
                    )
                  ) : (
                    <KeyBadge
                      present={present}
                      keys={providers?.env_keys[info.key]}
                      optional={info.key !== 'anthropic'}
                    />
                  )
                ) : (
                  <Badge tone="green">No key needed</Badge>
                )}
              </div>
            )
          })}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
          <KeyRound className="h-4 w-4" aria-hidden /> Reading replies:
          {readingInboxes > 0 ? (
            <Badge tone="green">
              Read from {readingInboxes} {readingInboxes === 1 ? 'inbox' : 'inboxes'}
            </Badge>
          ) : (
            <Badge tone="amber">
              Not read yet: give each sending inbox its IMAP server and app password, then Test
              login
            </Badge>
          )}
        </p>
      </Section>

      <Section
        title="Which sequence each persona gets"
        intro={
          saved.main_sequence_id
            ? 'Not in use while the main sequence is on: every new lead goes into it. This table applies again if you turn it off.'
            : 'Start sequence and the autopilot pick from this table.'
        }
      >
        {!sequences ? (
          <Loading text="Loading sequences" />
        ) : (
          <div className="grid gap-3">
            {PERSONAS.map((p) => (
              <PersonaRow key={p} persona={p} draft={draft} set={set} sequences={sequences} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Links" intro="Tracked links in messages point here.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Site">
            <input
              className="input"
              type="url"
              value={draft.site_url}
              onChange={(e) => set('site_url', e.target.value)}
            />
          </Field>
          <Field label="Book a demo">
            <input
              className="input"
              type="url"
              value={draft.demo_url}
              onChange={(e) => set('demo_url', e.target.value)}
            />
          </Field>
          <Field label="Join the beta">
            <input
              className="input"
              type="url"
              value={draft.beta_url}
              onChange={(e) => set('beta_url', e.target.value)}
            />
          </Field>
        </div>
        <Toggle
          checked={draft.notify_owner_on_reply}
          onChange={(v) => set('notify_owner_on_reply', v)}
          label="Email me when someone replies"
        />
        <Field
          label="Send ready messages to a webhook"
          hint="Optional. Each LinkedIn, Instagram or call item is posted there once."
        >
          <input
            className="input"
            type="url"
            placeholder="https://"
            value={draft.human_queue_webhook_url}
            onChange={(e) => set('human_queue_webhook_url', e.target.value)}
          />
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Webhook secret</span>
          <div className="flex items-center gap-2">
            <code className="input flex items-center overflow-x-auto whitespace-nowrap text-sm">
              {draft.webhook_secret || '–'}
            </code>
            <CopyButton text={draft.webhook_secret} />
          </div>
          <span className="mt-1 block text-sm text-stone-500">
            The main app sends it in the x-outreach-secret header when someone books or joins.
          </span>
        </div>
      </Section>

      <Section
        id="danger"
        title="Danger"
        intro="Live mode is the switch that lets email and mail go to leads. Test sends and reply notices to your own address go out either way."
      >
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="flex-1">
            <Toggle
              checked={saved.live_mode}
              onChange={(v) => (v ? setLiveConfirm(true) : void setLive(false))}
              label={saved.live_mode ? 'Live mode is on' : 'Live mode is off (dry run)'}
              description={
                saved.live_mode
                  ? 'Email and mail go out in the send window.'
                  : 'Everything is computed and queued, nothing is sent.'
              }
              disabled={save.busy}
            />
          </div>
        </div>
        <p className="text-sm text-stone-600">
          Today's numbers and the daily caps count real rows for the current day in your time zone,
          so they start over by themselves at midnight. Nothing to reset.
        </p>
      </Section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur md:left-60">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={dirtyCount === 0 || save.busy}
            onClick={() => void save.run(patch)}
          >
            {save.busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            Save{dirtyCount ? ` ${dirtyCount} ${dirtyCount === 1 ? 'change' : 'changes'}` : 'd'}
          </button>
          {dirtyCount ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDraft(saved)}
              disabled={save.busy}
            >
              Discard
            </button>
          ) : null}
          {save.error ? <span className="text-sm text-red-700">{save.error}</span> : null}
        </div>
      </div>

      <Confirm
        open={liveConfirm}
        onClose={() => setLiveConfirm(false)}
        onConfirm={() => void setLive(true)}
        title="Turn on Live mode?"
        confirmLabel="Turn on Live mode"
        danger
        busy={save.busy}
      >
        <p>From the next round inside the send window, this goes out without asking you:</p>
        <ul className="list-disc space-y-1 pl-5">
          {saved.channels.email ? (
            <li>
              Email, up to {saved.daily_caps.email} a day,{' '}
              {sendingInboxes > 0 ? (
                `from your ${sendingInboxes} warmed ${sendingInboxes === 1 ? 'inbox' : 'inboxes'}`
              ) : secretSender ? (
                'through the email secrets in Replit'
              ) : (
                <span className="text-red-700">
                  but no inbox can send yet, so sends will fail: add one under Sending inboxes
                </span>
              )}
            </li>
          ) : null}
          {saved.channels.mail ? (
            <li>
              Mail, up to {saved.daily_caps.mail} a day,{' '}
              {saved.mail_provider === 'lob' ? 'through Lob' : 'as letters you print'}
              {mailKeyPresent === false ? (
                <span className="text-red-700"> (key missing, sends will fail)</span>
              ) : null}
            </li>
          ) : null}
          {!saved.channels.email && !saved.channels.mail ? (
            <li>Nothing automatic: email and mail are both off.</li>
          ) : null}
          {enabledChannels.filter((c) => c !== 'email' && c !== 'mail').length ? (
            <li>
              {enabledChannels
                .filter((c) => c !== 'email' && c !== 'mail')
                .map((c) => CHANNEL_LABEL[c])
                .join(', ')}{' '}
              still wait for you in the queue.
            </li>
          ) : null}
        </ul>
        <p>
          Send window: {saved.send_window.days.map((d) => DAYS[d]).join(', ') || 'no days'} from{' '}
          {saved.send_window.start} to {saved.send_window.end} ({saved.send_window.tz}).
        </p>
        <p>
          Sequences that only ever ran in dry run start over from step 1, so the first live round
          really sends.
        </p>
        {!saved.physical_address.trim() ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
            Your physical address is empty. Email will refuse to send until you add it and save.
          </p>
        ) : null}
        {dirtyCount ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
            The list above is what is saved. Your {dirtyCount}{' '}
            {dirtyCount === 1 ? 'unsaved change is' : 'unsaved changes are'} not part of it. Cancel
            and press Save first if you want them to count.
          </p>
        ) : null}
      </Confirm>
    </div>
  )
}

function KeyBadge({
  present,
  keys,
  optional = false,
}: {
  present: boolean | undefined
  keys: string[] | undefined
  /** A paid add-on the app runs fine without: say so quietly instead of asking for a key. */
  optional?: boolean
}) {
  if (present === undefined) return <Badge>Checking</Badge>
  if (present) return <Badge tone="green">Key found</Badge>
  if (optional) return <Badge>Optional, not set up</Badge>
  return (
    <Badge tone="amber">
      Key missing
      {keys && keys.length ? `: add ${keys.join(', ')} in Replit Secrets, then Publish` : ''}
    </Badge>
  )
}

function PersonaRow({
  persona,
  draft,
  set,
  sequences,
}: {
  persona: Persona
  draft: SettingsT
  set: <K extends keyof SettingsT>(key: K, value: SettingsT[K]) => void
  sequences: Sequence[]
}) {
  const row = draft.sequence_by_persona[persona]
  return (
    <div className="rounded-xl border border-stone-200 p-3">
      <p className="mb-2 font-medium">{PERSONA_LABEL[persona]}</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {CHANNELS.map((c: Channel) => {
          const options = sequences.filter(
            (s) => s.channel === c && (s.persona === persona || s.persona === 'any'),
          )
          const chosen = row[c]
          const missing = chosen && !sequences.some((s) => s.id === chosen)
          return (
            <Field key={c} label={CHANNEL_LABEL[c]}>
              <select
                className={clsx('input', missing && 'border-amber-400')}
                value={chosen ?? ''}
                onChange={(e) =>
                  set('sequence_by_persona', {
                    ...draft.sequence_by_persona,
                    [persona]: { ...row, [c]: e.target.value || null },
                  })
                }
              >
                <option value="">None</option>
                {missing ? <option value={chosen}>Missing: {chosen}</option> : null}
                {options.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.persona === 'any' ? ` (${humanise('any persona').toLowerCase()})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )
        })}
      </div>
    </div>
  )
}
