// No LinkedIn profile on file (Theo, 2026-10-19): no search page and no paste box. One button has
// the app look up their exact profile; when it finds them, their note shows up with "Open their
// LinkedIn" going straight to that profile.
import { UserSearch } from 'lucide-react'
import type { LinkedInFindResult } from '@shared/types'
import { findLinkedIn } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { useToast } from './Toast.tsx'

function sayNotFound(person: string, r: LinkedInFindResult): string {
  if (r.status === 'not_found') return `The app could not find ${person} on LinkedIn.`
  if (r.reason === 'monthly finder limit reached') {
    return "The app has used this month's LinkedIn lookups. Raise the limit in Settings to look again."
  }
  if (r.reason === 'no Claude key') return 'LinkedIn lookups need the Claude key in Replit Secrets.'
  return `The app did not look: ${r.reason ?? 'try again in a few minutes'}.`
}

export default function FindLinkedIn({
  leadId,
  person,
  onFound,
}: {
  leadId: string
  person: string
  onFound?: () => void
}) {
  const toast = useToast()
  const find = useAction(() => findLinkedIn(leadId), {
    invalidate: [['queue'], ['todo'], ['leads'], ['lead', leadId], ['autopilot']],
    onSuccess: (r) => {
      if (r.status === 'found') {
        toast.ok(
          r.queued
            ? `Found ${person}. Their note is on their card with their LinkedIn.`
            : `Found ${person}'s LinkedIn.`,
        )
        onFound?.()
      } else {
        toast.error(sayNotFound(person, r))
      }
    },
  })
  return (
    <button
      type="button"
      className="btn-secondary"
      disabled={find.busy}
      onClick={() => void find.run()}
    >
      <UserSearch className="h-4 w-4" aria-hidden />{' '}
      {find.busy ? 'Looking for them…' : 'Find their LinkedIn'}
    </button>
  )
}
