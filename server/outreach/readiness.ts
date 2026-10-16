// "Is the sequence ready to run?" One line per thing Theo has to set, each with the fix.
// Backs GET /api/settings/readiness and the checklist on the Settings and Sequences pages.
import { appPasswordProblem, isGoogleMailHost, type SendingInbox } from '../../shared/settings.ts'
import type { ReadinessItem } from '../../shared/types.ts'
import { usageReport } from '../enrich/usage.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'
import { pickEmailProvider } from './email.ts'
import { mainSequence } from './enroll.ts'
import {
  canRead,
  canSend,
  googleSignedIn,
  googleSignInFix,
  loginFix,
  loginProblem,
  refreshGoogleAccount,
  replySyncFailures,
} from './inboxes.ts'

/**
 * Can a lead open the links in our messages? A private Replit deployment answers every request
 * from outside with a redirect to replit.com, so unsubscribe and booking links would not work.
 */
export async function linksArePublic(deps: OutreachDeps): Promise<boolean | null> {
  let url: URL
  try {
    url = new URL('/api/health', deps.baseUrl)
  } catch {
    return null
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return null
  try {
    const res = await deps.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (res.status >= 300 && res.status < 400) return false
    return res.ok
  } catch {
    return null
  }
}

function inboxNames(inboxes: SendingInbox[]): string {
  return inboxes.map((i) => i.email).join(', ')
}

const CLAUDE_CHECK_TTL_MS = 30 * 60_000
/** Busy, rate limited or unreachable: check again soon instead of reporting it for 30 minutes. */
const CLAUDE_RETRY_MS = 60_000
const CLAUDE_CHECK_TIMEOUT_MS = 15_000
/** The answer: ok, the fix, and a label when the default one would mislead (a working key, no credits). */
type ClaudeCheck = { ok: boolean; fix: string; label?: string }
let claudeCache: ({ at: number; ttl: number } & ClaudeCheck) | null = null

/** For tests: forget the cached Claude answer. */
export function resetClaudeCheck(): void {
  claudeCache = null
}

function statusOf(err: unknown, msg: string): number | null {
  const s = (err as { status?: unknown }).status
  if (typeof s === 'number') return s
  const m = /^(\d{3})\b/.exec(msg)
  return m ? Number(m[1]) : null
}

/**
 * Is the Claude key there AND accepted? A key that is present can still be refused (an
 * organization key without a workspace, a key copied in part), and then nothing that uses Claude
 * works. One tiny request: a clear answer is remembered for 30 minutes, a passing problem for one.
 */
export async function claudeKeyCheck(deps: OutreachDeps): Promise<ClaudeCheck> {
  if (!deps.env.ANTHROPIC_API_KEY || !deps.llm) {
    return {
      ok: false,
      fix: 'Add the Claude key in Replit Secrets as CLAUDE_API_KEY, then Publish.',
    }
  }
  const secret = deps.env.ANTHROPIC_KEY_SECRET ?? 'CLAUDE_API_KEY'
  const now = deps.now().getTime()
  if (claudeCache && now - claudeCache.at < claudeCache.ttl) return claudeCache
  let result: ClaudeCheck
  let ttl = CLAUDE_CHECK_TTL_MS
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), CLAUDE_CHECK_TIMEOUT_MS)
    })
    try {
      await Promise.race([deps.llm.text('Reply with the word ok.', { maxTokens: 16 }), timeout])
    } finally {
      clearTimeout(timer)
    }
    result = { ok: true, fix: '' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = statusOf(err, msg)
    if (/not scoped to a workspace|anthropic-workspace-id/i.test(msg)) {
      result = {
        ok: false,
        fix: secret.match(/WORK_SPACE|Workspace/i)
          ? `${secret} holds an organization key. Put the workspace ID there instead (it starts with wrkspc_), then Publish.`
          : 'Claude needs the workspace for this organization key: add a secret WORK_SPACE_CLAUDE with the workspace ID (it starts with wrkspc_), then Publish.',
      }
    } else if (status === 402 || /credit balance/i.test(msg)) {
      ttl = CLAUDE_RETRY_MS
      result = {
        ok: false,
        // The key works: Anthropic took it and answered. Say so, so it does not read as "not connected".
        label: `Claude key connected (${secret}), but its Anthropic account has no credits`,
        fix: `Anthropic accepted the key in ${secret} and answered that the credit balance is too low, so research finds nothing and new leads wait. Credits only count in the organization the key was made in: at console.anthropic.com pick that organization (top left; Settings > API keys lists the key), then add credits under Settings > Billing. This checks again within a minute. No Publish needed.`,
      }
    } else if (status === 401 || status === 403 || /invalid x-api-key/i.test(msg)) {
      result = {
        ok: false,
        fix: `Claude refused the key in ${secret}. Copy the whole key again into ${secret} in Replit Secrets, then Publish.`,
      }
    } else {
      ttl = CLAUDE_RETRY_MS
      result = {
        ok: false,
        fix: 'Claude is busy or could not be reached just now. This checks again in a minute.',
      }
    }
  }
  claudeCache = { at: now, ttl, ...result }
  return result
}

export async function sequenceReadiness(deps: OutreachDeps): Promise<ReadinessItem[]> {
  const settings = await getSettings(deps.db)
  const gmailInboxes = settings.sending_inboxes.filter(
    (i) => i.active && isGoogleMailHost(i.smtp_host),
  )
  const google = gmailInboxes.length > 0 ? await refreshGoogleAccount(deps) : null
  // A Gmail inbox that is not signed in with Google yet: Google sign-in is the fix to offer.
  const gmailNotSignedIn = gmailInboxes.find((i) => !googleSignedIn(i))
  const senders = settings.sending_inboxes.filter(canSend)
  const readers = settings.sending_inboxes.filter(canRead)
  const main = await mainSequence(deps.db, settings)
  const publicLinks = await linksArePublic(deps)
  const envSender = pickEmailProvider(deps, settings) !== null
  // With email off (Theo writes to people himself) the app only needs LinkedIn and postcards.
  const emailOn = settings.channels.email
  const channelsOn = (
    emailOn ? (['email', 'linkedin', 'mail'] as const) : (['linkedin', 'mail'] as const)
  ).filter((c) => !settings.channels[c])
  const claude = await claudeKeyCheck(deps)
  const research = (await usageReport(settings, deps.now(), deps.db)).providers.find(
    (p) => p.provider === 'claude_research',
  )
  const researchFull = !!research && research.cap !== null && research.used >= research.cap
  const refused = senders.find((i) => loginProblem(i) !== null)
  // A Gmail inbox not signed in with Google whose saved password can never be an app password:
  // Gmail will refuse it, so it is not a way to send even before the first refusal is seen.
  const doomed = senders.find(
    (i) =>
      isGoogleMailHost(i.smtp_host) &&
      !googleSignedIn(i) &&
      appPasswordProblem(i.smtp_host, i.smtp_pass) !== null,
  )
  const unread = replySyncFailures()[0]

  const emailItems: ReadinessItem[] = [
    {
      key: 'inbox',
      ok: (senders.length > 0 || envSender) && !refused && !doomed,
      required: true,
      label:
        senders.length > 0
          ? `Sending from ${inboxNames(senders)}`
          : 'A warmed inbox to send the emails from',
      fix: refused
        ? isGoogleMailHost(refused.smtp_host)
          ? loginFix(refused)
          : (appPasswordProblem(refused.smtp_host, refused.smtp_pass) ?? loginFix(refused))
        : doomed
          ? `Gmail will refuse the saved password for ${doomed.email}, so nothing can send yet. ${googleSignInFix(doomed.email, google ?? undefined)}`
          : gmailNotSignedIn && senders.length === 0
            ? googleSignInFix(gmailNotSignedIn.email, google ?? undefined)
            : 'Add each warmed inbox under Sending inboxes with its app password, then press Test.',
    },
    {
      key: 'replies',
      ok: (readers.length > 0 || deps.imap !== null) && !unread,
      required: true,
      label: 'Replies are read, so a lead who answers gets nothing more',
      fix: unread
        ? `Reading replies in ${unread.label} failed (${unread.error}). Follow-up emails wait until it works, so nobody who answered gets another email. ${isGoogleMailHost(settings.sending_inboxes.find((i) => i.email === unread.label)?.smtp_host ?? '') ? ` ${loginFix({ email: unread.label, smtp_host: 'smtp.gmail.com' })}` : ' A refused login needs a new app password under Sending inboxes.'}`
        : 'Fill in the IMAP server on each inbox (Gmail: imap.gmail.com, Outlook: outlook.office365.com).',
    },
  ]

  return [
    ...(emailOn ? emailItems : []),
    {
      key: 'address',
      ok: settings.physical_address.trim() !== '',
      required: true,
      label: emailOn
        ? 'Your business mailing address, printed in every email and on the postcards'
        : 'Your business mailing address, printed on the postcards',
      fix: emailOn
        ? 'Add it under You in Settings. The law requires it in cold email.'
        : 'Add it under You in Settings, so a postcard has a return address.',
    },
    {
      key: 'links',
      ok: publicLinks !== false,
      required: emailOn,
      label:
        publicLinks === null
          ? 'Unsubscribe and booking links (checked on the published app)'
          : 'Unsubscribe and booking links open for leads',
      fix: 'In Replit, open Publishing and make the app public. Your app password still protects every page except the links leads click.',
    },
    {
      key: 'sequence',
      ok: main !== null,
      required: true,
      label: 'The sequence is on and new leads go into it',
      fix: 'Turn on the main sequence on the Sequences page.',
    },
    {
      key: 'channels',
      ok: channelsOn.length === 0,
      required: true,
      label: emailOn
        ? 'Email, LinkedIn and Postcards are switched on'
        : 'LinkedIn and Postcards are switched on (the app sends no email)',
      fix: `Switch on ${channelsOn.join(', ') || 'them'} under Channels in Settings.`,
    },
    {
      key: 'linkedin',
      ok: settings.my_linkedin_url.trim() !== '',
      required: false,
      label: 'Your LinkedIn profile, shown on every LinkedIn task',
      fix: 'Paste your LinkedIn profile link under Your accounts.',
    },
    {
      key: 'enrich',
      ok: claude.ok,
      required: false,
      label: claude.label ?? 'Claude key, so enrichment searches the web for emails and profiles',
      fix: claude.fix,
    },
    {
      key: 'research_cap',
      ok: !researchFull,
      required: false,
      label: research
        ? `Research this month: ${research.used}${research.cap !== null ? ` of ${research.cap}` : ''} people looked up`
        : 'Research this month',
      fix: "This month's research is used up, so nobody new gets a LinkedIn profile found and the LinkedIn list stops growing. Raise Claude research under Enrichment in Settings (about a dollar or two of Anthropic credit per person), wait for next month, or look people up yourself under Find more people on LinkedIn on the Go page.",
    },
    {
      key: 'autopilot',
      ok: settings.autopilot_on,
      required: true,
      label: 'Autopilot is on, so the app works the sequence every send window',
      fix: 'Open Go and switch on Autopilot.',
    },
    {
      key: 'live',
      ok: settings.live_mode,
      required: true,
      label: emailOn
        ? 'Live mode is on, so emails really go out'
        : 'Live mode is on, so your LinkedIn notes and postcards come up each day',
      fix: 'Turn on Live mode at the bottom of Settings once everything above is green.',
    },
  ]
}
