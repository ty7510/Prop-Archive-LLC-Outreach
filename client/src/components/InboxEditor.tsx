// Settings > Sending inboxes: the warmed addresses the sequence emails from, each with a Test button.
import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { appPasswordProblem, SECRET_MASK, type SendingInbox } from '@shared/settings'
import type { GoogleMailStatus, InboxTestResult } from '@shared/types'
import { errorMessage, getGoogleMail, testInbox } from '../api.ts'
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
  const isGoogle = preset === 'google'
  const queryClient = useQueryClient()
  const google = useQuery({
    queryKey: ['google-mail'],
    queryFn: () => getGoogleMail(),
    enabled: isGoogle,
    staleTime: 30_000,
  })
  const [checking, setChecking] = useState(false)
  const signedIn =
    isGoogle &&
    google.data?.state === 'connected' &&
    google.data.email === inbox.email.trim().toLowerCase()
  async function checkGoogle() {
    setChecking(true)
    try {
      queryClient.setQueryData(['google-mail'], await getGoogleMail(true))
      await queryClient.invalidateQueries({ queryKey: ['readiness'] })
    } catch {
      await google.refetch()
    } finally {
      setChecking(false)
    }
  }
  // The server keeps a saved password only while the servers and login stay the same, so a change
  // here clears it and the app password has to be typed again.
  const retypePassword = inbox.smtp_pass === ''
  // Shown as he types: a Google app password is 16 letters, so a normal password is caught here.
  const passwordShape = appPasswordProblem(inbox.smtp_host, inbox.smtp_pass)
  function changeServer(patch: Partial<SendingInbox>) {
    onChange(inbox.smtp_pass === SECRET_MASK ? { ...patch, smtp_pass: '' } : patch)
  }

  async function runTest() {
    setTesting(true)
    setResult(null)
    setTestError(null)
    try {
      setResult(await testInbox(inbox))
      await queryClient.invalidateQueries({ queryKey: ['readiness'] })
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
      {isGoogle ? (
        <GoogleSignIn
          email={inbox.email.trim().toLowerCase()}
          status={google.data}
          loading={google.isLoading}
          error={google.error ? errorMessage(google.error) : null}
          checking={checking}
          onCheck={() => void checkGoogle()}
        />
      ) : null}
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
        {isGoogle ? null : (
          <>
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
              {passwordShape ? <p className="mt-1 text-sm text-red-700">{passwordShape}</p> : null}
            </Field>
            <Field label="Login" hint="Usually the email address">
              <input
                className="input"
                value={inbox.smtp_user}
                onChange={(e) => changeServer({ smtp_user: e.target.value.trim() })}
              />
            </Field>
          </>
        )}
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
      {isGoogle && !signedIn ? (
        <details className="mt-3 rounded-lg border border-stone-200 p-3" open={false}>
          <summary className="cursor-pointer text-stone-700">
            Or use an app password instead (harder)
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
              {passwordShape ? <p className="mt-1 text-sm text-red-700">{passwordShape}</p> : null}
            </Field>
            <Field label="Login" hint="Usually the email address">
              <input
                className="input"
                value={inbox.smtp_user}
                onChange={(e) => changeServer({ smtp_user: e.target.value.trim() })}
              />
            </Field>
          </div>
        </details>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void runTest()}
          disabled={testing || !inbox.email}
        >
          {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}{' '}
          {signedIn ? 'Send a test email' : 'Test login'}
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

/** Settings > Sending inboxes, Google inbox: the Sign in with Google state and how to finish it. */
function GoogleSignIn({
  email,
  status,
  loading,
  error,
  checking,
  onCheck,
}: {
  email: string
  status: GoogleMailStatus | undefined
  loading: boolean
  error: string | null
  checking: boolean
  onCheck: () => void
}) {
  const checkButton = (
    <button type="button" className="btn-secondary" onClick={onCheck} disabled={checking}>
      {checking ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-4 w-4" aria-hidden />
      )}{' '}
      Check again
    </button>
  )
  if (loading) {
    return (
      <Box tone="stone">
        <p className="flex items-center gap-2 text-stone-700">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking Sign in with Google
        </p>
      </Box>
    )
  }
  if (status?.state === 'connected' && status.email === email) {
    return (
      <Box tone="green">
        <p className="flex gap-2 font-medium text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          Signed in with Google as {status.email}. No app password needed.
        </p>
        <p className="mt-1 text-stone-700">
          Emails go out and replies are read through Google. Press Send a test email below to see
          one arrive in this inbox.
        </p>
      </Box>
    )
  }
  const wrongAccount = status?.state === 'connected' && status.email !== email
  return (
    <Box tone="blue">
      <p className="text-lg font-medium text-stone-900">Sign in with Google</p>
      <p className="mt-1 text-stone-700">
        No app password needed. Google sign-in happens in Replit, once:
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-6 text-stone-800">
        <li>In Replit, open this app.</li>
        <li>
          Open <b>All tools</b>, then <b>Integrations</b>, then <b>Gmail</b>, and press{' '}
          <b>Connect</b>.
        </li>
        <li>
          Choose {email ? <b>{email}</b> : 'this inbox address'} and allow everything Google asks.
        </li>
        <li>Come back here and press Check again.</li>
      </ol>
      {wrongAccount ? (
        <p className="mt-2 flex gap-2 text-red-700">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Gmail is connected as {status?.email}, not {email || 'this inbox'}. Reconnect it in Replit
          and choose {email || 'this inbox address'}.
        </p>
      ) : status && status.state !== 'not_connected' && status.state !== 'connected' ? (
        <p className="mt-2 text-red-700">{status.detail}</p>
      ) : error ? (
        <p className="mt-2 text-red-700">{error}</p>
      ) : null}
      <div className="mt-3">{checkButton}</div>
    </Box>
  )
}

function Box({ tone, children }: { tone: 'green' | 'blue' | 'stone'; children: ReactNode }) {
  const cls =
    tone === 'green'
      ? 'border-emerald-300 bg-emerald-50'
      : tone === 'blue'
        ? 'border-sky-300 bg-sky-50'
        : 'border-stone-200 bg-stone-50'
  return <div className={`mb-3 rounded-lg border p-3 ${cls}`}>{children}</div>
}
