// Modal dialog. Used for confirms (Live mode, Start sequence) and the lead panel on phones.
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-stone-900/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={clsx(
          'max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl outline-none sm:rounded-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-m-2 rounded-lg p-2 text-stone-500 hover:bg-stone-100"
            aria-label="Close"
          >
            <X className="h-6 w-6" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  danger = false,
  busy = false,
  disabled = false,
  children,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  /** Nothing would happen on confirm (for example no lead can be started). */
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-3 text-stone-700">{children}</div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} className="btn-secondary" disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={danger ? 'btn-danger' : 'btn-primary'}
          disabled={busy || disabled}
        >
          {busy ? 'Working' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
