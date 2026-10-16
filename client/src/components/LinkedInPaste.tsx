// No LinkedIn profile on file: search LinkedIn for the person, paste their profile link, and their
// connection note comes up on the Go page (one note per person, within today's goal).
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { saveLinkedInProfile } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'

export function linkedInSearchUrl(person: string, city?: string | null): string {
  const keywords = `${person} ${city?.trim() || 'Philadelphia'}`
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`
}

export default function LinkedInPaste({
  leadId,
  person,
  city,
  onSaved,
}: {
  leadId: string
  person: string
  city?: string | null
  onSaved?: () => void
}) {
  const [url, setUrl] = useState('')
  const save = useAction(() => saveLinkedInProfile(leadId, url), {
    success: (r) =>
      r.queued
        ? `Saved. ${person}'s LinkedIn note is waiting on the Go page.`
        : `Saved. ${person}'s note comes up in the next send window, within your daily goal.`,
    invalidate: [['queue'], ['leads'], ['lead', leadId], ['autopilot']],
    onSuccess: () => {
      setUrl('')
      onSaved?.()
    },
  })
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim()) void save.run()
      }}
    >
      <a
        href={linkedInSearchUrl(person, city)}
        target="_blank"
        rel="noreferrer"
        className="btn-secondary"
      >
        <ExternalLink className="h-4 w-4" aria-hidden /> Search LinkedIn
      </a>
      <input
        className="input min-w-0 flex-1 basis-56"
        placeholder="Paste their profile link"
        aria-label={`LinkedIn profile link for ${person}`}
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={save.busy || !url.trim()}>
        Save
      </button>
    </form>
  )
}
