// "Is the sequence ready to run?" One line per thing Theo has to set, each with the fix.
// Backs GET /api/settings/readiness and the checklist on the Settings and Sequences pages.
import type { SendingInbox } from '../../shared/settings.ts'
import type { ReadinessItem } from '../../shared/types.ts'
import { getSettings } from '../lib/settings.ts'
import type { OutreachDeps } from './deps.ts'
import { pickEmailProvider } from './email.ts'
import { mainSequence } from './enroll.ts'
import { canRead, canSend } from './inboxes.ts'

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

export async function sequenceReadiness(deps: OutreachDeps): Promise<ReadinessItem[]> {
  const settings = await getSettings(deps.db)
  const senders = settings.sending_inboxes.filter(canSend)
  const readers = settings.sending_inboxes.filter(canRead)
  const main = await mainSequence(deps.db, settings)
  const publicLinks = await linksArePublic(deps)
  const envSender = pickEmailProvider(deps, settings) !== null
  const channelsOn = (['email', 'linkedin', 'mail'] as const).filter((c) => !settings.channels[c])

  return [
    {
      key: 'inbox',
      ok: senders.length > 0 || envSender,
      required: true,
      label:
        senders.length > 0
          ? `Sending from ${inboxNames(senders)}`
          : 'A warmed inbox to send the emails from',
      fix: 'Add each warmed inbox under Sending inboxes with its app password, then press Test.',
    },
    {
      key: 'replies',
      ok: readers.length > 0 || deps.imap !== null,
      required: true,
      label: 'Replies are read, so a lead who answers gets nothing more',
      fix: 'Fill in the IMAP server on each inbox (Gmail: imap.gmail.com, Outlook: outlook.office365.com).',
    },
    {
      key: 'address',
      ok: settings.physical_address.trim() !== '',
      required: true,
      label: 'Your business mailing address, printed in every email and on the postcards',
      fix: 'Add it under You in Settings. The law requires it in cold email.',
    },
    {
      key: 'links',
      ok: publicLinks !== false,
      required: true,
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
      fix: 'Turn on "Email, LinkedIn, then mail" on the Sequences page.',
    },
    {
      key: 'channels',
      ok: channelsOn.length === 0,
      required: true,
      label: 'Email, LinkedIn and Postcards are switched on',
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
      ok: deps.env.ANTHROPIC_API_KEY !== undefined,
      required: false,
      label: 'Claude key, so enrichment searches the web for emails and profiles',
      fix: 'Add the Claude_API secret in Replit (and Claude_Workspace_ID for an organization key), then Publish.',
    },
    {
      key: 'autopilot',
      ok: settings.autopilot_on,
      required: true,
      label: 'Autopilot is on, so the app works the sequence every send window',
      fix: 'Press Autopilot at the top of the page.',
    },
    {
      key: 'live',
      ok: settings.live_mode,
      required: true,
      label: 'Live mode is on, so emails really go out',
      fix: 'Turn on Live mode at the bottom of Settings once everything above is green.',
    },
  ]
}
