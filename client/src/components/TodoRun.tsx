// The to-do list as a pop-up, one person at a time: their card with every step. When the last step
// is done they move to Complete and the next person comes up by themselves.
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { TodoPerson } from '@shared/types'
import { usePinnedIndex } from '../hooks/usePinnedIndex.ts'
import { Modal } from './Confirm.tsx'
import TodoCard from './TodoCard.tsx'

export default function TodoRun({
  open,
  onClose,
  people,
  footer,
  gmailUser,
}: {
  open: boolean
  onClose: () => void
  /** The live list: a person drops out when their last step is done. */
  people: TodoPerson[]
  /** The lines under every email, and the Gmail account Open in Gmail writes from. */
  footer: string
  gmailUser: string
}) {
  const { at, current: person, go } = usePinnedIndex(people, (p) => p.lead_id, open)

  return (
    <Modal open={open} onClose={onClose} title="Your to-do list" wide>
      {person ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-stone-600">
              Person {at + 1} of {people.length}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={at === 0}
                onClick={() => go(at - 1)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden /> Back
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={at >= people.length - 1}
                onClick={() => go(at + 1)}
              >
                Next person <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
          <TodoCard key={person.lead_id} person={person} footer={footer} gmailUser={gmailUser} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-stone-700">
            All done for now. Everyone you finished is under Complete, and new people show up on
            weekdays.
          </p>
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
