// Calm note shown wherever the API still answers 501 NOT_BUILT. Never an error toast.
import { Hammer } from 'lucide-react'

export default function NotBuilt({ what }: { what?: string }) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-4 py-3 text-stone-600"
    >
      <Hammer className="mt-0.5 h-5 w-5 shrink-0 text-stone-400" aria-hidden />
      <p>
        This part is still being built.
        {what ? <span className="block text-sm text-stone-500">{what}</span> : null}
      </p>
    </div>
  )
}
