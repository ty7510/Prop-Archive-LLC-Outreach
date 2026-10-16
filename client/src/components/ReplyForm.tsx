// "They replied": Theo logs that someone wrote back (on LinkedIn, by phone, by email, by mail).
// Nothing more goes to them after this, and the reply shows on their timeline.
import { useState } from 'react'
import { MessageCircleReply } from 'lucide-react'
import type { Channel } from '@shared/types'
import { leadOutcome } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'

const WHERE: { channel: Channel; label: string }[] = [
  { channel: 'linkedin', label: 'LinkedIn' },
  { channel: 'call', label: 'Phone' },
  { channel: 'email', label: 'Email' },
  { channel: 'mail', label: 'Mail' },
]

export default function ReplyForm({
  leadId,
  person,
  channel = 'linkedin',
  onSaved,
  className,
}: {
  leadId: string
  person: string
  /** Where they most likely answered: the channel Theo reached them on. */
  channel?: Channel
  onSaved?: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [where, setWhere] = useState<Channel>(
    WHERE.some((w) => w.channel === channel) ? channel : 'linkedin',
  )
  const [note, setNote] = useState('')
  const save = useAction(
    () => leadOutcome(leadId, { kind: 'replied', channel: where, note: note.trim() || undefined }),
    {
      success: `${person} marked as replied. Nothing more goes to them.`,
      invalidate: [['queue'], ['todo'], ['autopilot'], ['activity'], ['leads'], ['lead', leadId]],
      onSuccess: () => {
        setOpen(false)
        onSaved?.()
      },
    },
  )

  if (!open) {
    return (
      <button type="button" className={className ?? 'btn-secondary'} onClick={() => setOpen(true)}>
        <MessageCircleReply className="h-4 w-4" aria-hidden /> They replied
      </button>
    )
  }
  return (
    <form
      className="w-full space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save.run()
      }}
    >
      <fieldset>
        <legend className="mb-1 text-sm text-stone-700">Where did {person} write back?</legend>
        <div className="flex flex-wrap gap-2">
          {WHERE.map((w) => (
            <label
              key={w.channel}
              className="flex min-h-tap cursor-pointer items-center gap-2 rounded-lg bg-white px-3 ring-1 ring-stone-200"
            >
              <input
                type="radio"
                name={`reply-where-${leadId}`}
                checked={where === w.channel}
                onChange={() => setWhere(w.channel)}
              />
              {w.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm text-stone-700">
        What did they say? (optional)
        <textarea
          className="input mt-1 min-h-[72px] py-2"
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={save.busy}>
          Save reply
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}
