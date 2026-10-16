// Today's LinkedIn notes as a pop-up, one person at a time: the note written for them and their
// company, Copy, a button to their LinkedIn (or a box to paste it), then Done or Skip for the next.
// Theo sends every note himself; the app never opens or touches LinkedIn on its own.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Loader2, SkipForward } from 'lucide-react'
import type { LinkedInWanted, Queue, QueueItem } from '@shared/types'
import { queueDone, queueNote, queueSkip } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { ensureHttp } from '../lib/format.ts'
import { Modal } from './Confirm.tsx'
import CopyButton from './CopyButton.tsx'
import LinkedInPaste from './LinkedInPaste.tsx'

/** A free LinkedIn account allows 200 characters in a connection note. */
const NOTE_MAX = 200

const noteKey = (messageId: string) => ['linkedin-note', messageId] as const

export default function LinkedInRun({
  open,
  onClose,
  items,
  wanted,
  today,
}: {
  open: boolean
  onClose: () => void
  /** The LinkedIn notes waiting now (the live queue, so a pasted profile's note joins in). */
  items: QueueItem[]
  /** People with no profile yet, while today's goal is not met. */
  wanted: LinkedInWanted[]
  today?: Queue['today']['linkedin']
}) {
  const qc = useQueryClient()
  // Handled in this run: the queue refetch drops them anyway, this keeps the next one instant.
  const [handled, setHandled] = useState<Set<string>>(new Set())
  const [passed, setPassed] = useState<Set<string>>(new Set())
  const left = useMemo(() => items.filter((i) => !handled.has(i.message_id)), [items, handled])
  const current = left[0]
  const nextUp = left[1]
  const doneToday = today?.done ?? 0
  const goal = today?.goal ?? 0
  const underGoal = goal === 0 || doneToday + left.length < goal
  const person = current ? null : underGoal ? wanted.find((w) => !passed.has(w.lead_id)) : null

  const note = useQuery({
    queryKey: noteKey(current?.message_id ?? ''),
    queryFn: () => queueNote(current!.message_id),
    enabled: open && Boolean(current),
    staleTime: Infinity,
    retry: false,
  })
  // Write the next person's note while Theo sends this one.
  useEffect(() => {
    if (!open || !nextUp) return
    void qc.prefetchQuery({
      queryKey: noteKey(nextUp.message_id),
      queryFn: () => queueNote(nextUp.message_id),
      staleTime: Infinity,
    })
  }, [open, nextUp, qc])

  const finish = (id: string) => setHandled((prev) => new Set(prev).add(id))
  const after = { invalidate: [['queue'], ['autopilot'], ['activity']] }
  const done = useAction(queueDone, { success: 'Marked done', ...after })
  const skip = useAction(queueSkip, { success: 'Skipped', ...after })
  const busy = done.busy || skip.busy

  const body = note.data?.body ?? current?.body ?? ''
  const writing = Boolean(current) && note.isLoading

  return (
    <Modal open={open} onClose={onClose} title="Today's LinkedIn notes">
      <p className="mb-4 text-sm text-stone-600">
        {goal > 0 ? `${doneToday} of ${goal} done today. ` : ''}
        {left.length > 0 ? `${left.length} waiting.` : ''}
      </p>

      {current ? (
        <div className="space-y-4">
          <div>
            <p className="text-lg font-medium">{current.person}</p>
            {current.company ? <p className="text-stone-600">{current.company}</p> : null}
          </div>

          <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
            {writing ? (
              <p className="flex items-center gap-2 text-stone-600">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Writing a note for{' '}
                {current.person}
              </p>
            ) : (
              <p className="whitespace-pre-wrap break-words text-stone-800">{body}</p>
            )}
            {!writing ? (
              <p className="mt-2 text-xs text-stone-500">
                {body.length} of {NOTE_MAX} characters
                {note.data && !note.data.personal ? ', your own note' : ''}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <CopyButton text={writing ? '' : body} label="Copy note" />
            {current.to_address ? (
              <a
                href={ensureHttp(current.to_address)}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary"
              >
                <ExternalLink className="h-4 w-4" aria-hidden /> Open their LinkedIn
              </a>
            ) : null}
          </div>
          {!current.to_address ? (
            <LinkedInPaste leadId={current.lead_id} person={current.person} />
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 pt-4">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                void skip.run(current.message_id).then((r) => r && finish(current.message_id))
              }
            >
              <SkipForward className="h-4 w-4" aria-hidden /> Skip
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || writing}
              onClick={() =>
                void done.run(current.message_id).then((r) => r && finish(current.message_id))
              }
            >
              <Check className="h-4 w-4" aria-hidden /> Sent it, next
            </button>
          </div>
        </div>
      ) : person ? (
        <div className="space-y-4">
          <p className="text-stone-700">
            Find this person on LinkedIn and paste their profile. Their note comes up here next.
          </p>
          <div>
            <p className="text-lg font-medium">{person.person}</p>
            {person.company ? <p className="text-stone-600">{person.company}</p> : null}
          </div>
          <LinkedInPaste
            leadId={person.lead_id}
            person={person.person}
            city={person.city}
            onSaved={() => setPassed((prev) => new Set(prev).add(person.lead_id))}
          />
          <div className="flex justify-end border-t border-stone-200 pt-4">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setPassed((prev) => new Set(prev).add(person.lead_id))}
            >
              <SkipForward className="h-4 w-4" aria-hidden /> Can't find them, next
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-stone-700">That's everyone for now. New notes come up on weekdays.</p>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
