// Settings > Sending inboxes: the warmed addresses the sequence emails from, each with a Test button.
import { useState } from 'react'
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import { SECRET_MASK, type SendingInbox } from '@shared/settings'
import type { InboxTestResult } from '@shared/types'
import { errorMessage, testInbox } from '../api.ts'
import { Field, Toggle } from './Field.tsx'

/** Server settings for the common hosts. "Other" leaves the fields to fill in by hand. */
const PRESETS = {
  google: {
    label: 'Google Workspace or Gmail',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    imap_host: 'imap.gmail.com',
    imap_port: 993,
  },
  microsoft: {
    label: 'Microsoft 365 or Outlook',
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    imap_host: 'outlook.office365.com',
    imap_port: 993,
  },
  zoho: {
    label: 'Zoho Mail',
    smtp_host: 'smtp.zoho.com',
    smtp_port: 465,
    imap_host: 'imap.zoho.com',
    imap_port: 993,
  },
} as const
type PresetKey = keyof typeof PRESETS

function presetOf(inbox: SendingInbox): PresetKey | 'other' {
  for (const [key, p] of Object.entries(PRESETS) as [PresetKey, (typeof PRESETS)[PresetKey]][]) {
    if (inbox.smtp_host === p.smtp_host) return key
  }
  return 'other'
}

function newInbox(fromName: string): SendingInbox {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `inbox-${Date.now()}`
  return {
    id,
    from_name: fromName,
    email: '',
    ...PRESETS.google,
    smtp_user: '',
    smtp_pass: '',
    daily_limit: 30,
    active: true,
  }
}

export default function InboxEditor({
  inboxes,
  defaultFromName,
  onChange,
}: {
  inboxes: SendingInbox[]
  defaultFromName: string
  onChange: (next: SendingInbox[]) => void
}) {
  function update(idx: number, patch: Partial<SendingInbox>) {
    onChange(inboxes.map((inbox, i) => (i === idx ? { ...inbox, ...patch } : inbox)))
  }
  return (
    <div className="space-y-4">
      {inboxes.length === 0 ? (
        <p className="text-stone-600">
          No inboxes yet. Add each warmed address you bought. The sequence takes turns between them.
        </p>
      ) : null}
      {inboxes.map((inbox, i) => (
        <InboxCard
          key={inbox.id}
          inbox={inbox}
          number={i + 1}
          onChange={(patch) => update(i, patch)}
          onRemove={() => onChange(inboxes.filter((_, j) => j !== i))}
        />
      ))}
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onChange([...inboxes, newInbox(defaultFromName)])}
        disabled={inboxes.length >= 20}
      >
        <Plus className="h-4 w-4" aria-hidden /> Add an inbox
      </button>
    </div>
  )
}

function InboxCard({
  inbox,
  number,
  onChange,
  onRemove,
}: {
  inbox: SendingInbox
  number: number
  onChange: (patch: Partial<SendingInbox>) => void
  onRemove: () => void
}) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<InboxTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const preset = presetOf(inbox)
  // The server keeps a saved password only while the servers and login stay the same, so a change
  // here clears it and the app password has to be typed again.
  const retypePassword = inbox.smtp_pass === ''
  function changeServer(patch: Partial<SendingInbox>) {
    onChange(inbox.smtp_pass === SECRET_MASK ? { ...patch, smtp_pass: '' } : patch)
  }

  async function runTest() {
    setTesting(true)
    setResult(null)
    setTestError(null)
    try {
      setResult(await testInbox(inbox))
    } catch (err) {
      setTestError(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="rounded-xl border border-stone-200 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-medium">
          Inbox {number}
          {inbox.email ? <span className="font-normal text-stone-500">: {inbox.email}</span> : null}
        </h3>
        <div className="w-48">
          <Toggle
            checked={inbox.active}
            onChange={(active) => onChange({ active })}
            label={inbox.active ? 'Sending' : 'Paused'}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email address">
          <input
            className="input"
            type="email"
            value={inbox.email}
            placeholder="theo@getproparchive.com"
            onChange={(e) => {
              const email = e.target.value.trim()
              // The login is the address for every common host; keep them together until edited.
              const userFollows = !inbox.smtp_user || inbox.smtp_user === inbox.email
              if (userFollows) changeServer({ email, smtp_user: email })
              else onChange({ email })
            }}
          />
        </Field>
        <Field label="From name" hint="What leads see in their inbox">
          <input
            className="input"
            value={inbox.from_name}
            placeholder="Theo Young"
            onChange={(e) => onChange({ from_name: e.target.value })}
          />
        </Field>
        <Field label="Email host">
          <select
            className="input"
            value={preset}
            onChange={(e) => {
              const key = e.target.value as PresetKey | 'other'
              if (key === 'other') changeServer({ smtp_host: '', imap_host: '' })
              else {
                const { label: _label, ...servers } = PRESETS[key]
                changeServer(servers)
              }
            }}
          >
            {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
              <option key={k} value={k}>
                {PRESETS[k].label}
              </option>
            ))}
            <option value="other">Other (type the servers)</option>
          </select>
        </Field>
        <Field
          label="App password"
          hint={
            retypePassword && inbox.email
              ? 'Type the app password (needed again after the server or login changes).'
              : 'Not your normal password. Google: Account > Security > App passwords. Stays on the server.'
          }
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={inbox.smtp_pass === SECRET_MASK ? '' : inbox.smtp_pass}
            placeholder={inbox.smtp_pass === SECRET_MASK ? 'Saved (type to replace)' : ''}
            onChange={(e) => onChange({ smtp_pass: e.target.value || SECRET_MASK })}
          />
        </Field>
        <Field label="Login" hint="Usually the email address">
          <input
            className="input"
            value={inbox.smtp_user}
            onChange={(e) => changeServer({ smtp_user: e.target.value.trim() })}
          />
        </Field>
        <Field label="Emails per day from this inbox" hint="Warmed inboxes: 20 to 40">
          <input
            className="input"
            type="number"
            min={0}
            max={500}
            value={inbox.daily_limit}
            onChange={(e) => onChange({ daily_limit: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
        {preset === 'other' ? (
          <>
            <Field label="SMTP server (sending)">
              <input
                className="input"
                value={inbox.smtp_host}
                placeholder="smtp.example.com"
                onChange={(e) => changeServer({ smtp_host: e.target.value.trim() })}
              />
            </Field>
            <Field label="SMTP port" hint="465 or 587">
              <input
                className="input"
                type="number"
                value={inbox.smtp_port}
                onChange={(e) => changeServer({ smtp_port: Number(e.target.value) || 587 })}
              />
            </Field>
            <Field label="IMAP server (reading replies)">
              <input
                className="input"
                value={inbox.imap_host}
                placeholder="imap.example.com"
                onChange={(e) => changeServer({ imap_host: e.target.value.trim() })}
              />
            </Field>
            <Field label="IMAP port" hint="Usually 993">
              <input
                className="input"
                type="number"
                value={inbox.imap_port}
                onChange={(e) => changeServer({ imap_port: Number(e.target.value) || 993 })}
              />
            </Field>
          </>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void runTest()}
          disabled={testing || !inbox.email}
        >
          {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Test login
        </button>
        <button type="button" className="btn-secondary" onClick={onRemove}>
          <Trash2 className="h-4 w-4" aria-hidden /> Remove
        </button>
      </div>
      {testError ? <p className="mt-2 text-red-700">{testError}</p> : null}
      {result ? (
        <ul className="mt-2 space-y-1">
          <TestLine ok={result.smtp.ok} text={result.smtp.message} />
          <TestLine ok={result.imap.ok} text={result.imap.message} />
        </ul>
      ) : null}
    </div>
  )
}

function TestLine({ ok, text }: { ok: boolean; text: string }) {
  const Icon = ok ? CheckCircle2 : XCircle
  return (
    <li className={ok ? 'flex gap-2 text-emerald-700' : 'flex gap-2 text-red-700'}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="break-words">{text}</span>
    </li>
  )
}
