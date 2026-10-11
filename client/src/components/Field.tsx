// Form bits used by Settings and the sequence editor: labelled field, toggle switch, chips.
import clsx from 'clsx'
import { X } from 'lucide-react'

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-sm text-stone-500">{hint}</span> : null}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  size = 'md',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  description?: string
  disabled?: boolean
  size?: 'md' | 'xl'
}) {
  const xl = size === 'xl'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'flex w-full items-center gap-4 rounded-xl text-left disabled:opacity-50',
        xl ? 'flex-col items-center gap-3 py-2 text-center' : 'min-h-tap py-1',
      )}
    >
      <span
        className={clsx(
          'relative inline-flex shrink-0 items-center rounded-full transition',
          xl ? 'h-16 w-32' : 'h-8 w-14',
          checked ? 'bg-emerald-600' : 'bg-stone-300',
        )}
        aria-hidden
      >
        <span
          className={clsx(
            'absolute rounded-full bg-white shadow transition',
            xl ? 'h-14 w-14' : 'h-6 w-6',
            xl ? (checked ? 'left-[66px]' : 'left-1') : checked ? 'left-7' : 'left-1',
          )}
        />
      </span>
      <span className={clsx(xl && 'text-2xl font-semibold')}>
        <span className="block font-medium">{label}</span>
        {description ? <span className="block text-sm text-stone-500">{description}</span> : null}
      </span>
    </button>
  )
}

export function Chip({
  children,
  active = false,
  onClick,
  onRemove,
  title,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  onRemove?: () => void
  title?: string
}) {
  const base = clsx(
    'inline-flex min-h-[40px] items-center gap-1 rounded-full border px-4 text-base',
    active
      ? 'border-emerald-600 bg-emerald-600 text-white'
      : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-100',
  )
  if (onRemove) {
    return (
      <span className={clsx(base, 'pr-1')} title={title}>
        {children}
        <button
          type="button"
          onClick={onRemove}
          className="ml-1 rounded-full p-1.5 hover:bg-black/10"
          aria-label={`Remove ${typeof children === 'string' ? children : ''}`.trim()}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </span>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={base} aria-pressed={active} title={title}>
        {children}
      </button>
    )
  }
  return (
    <span className={base} title={title}>
      {children}
    </span>
  )
}

export function Badge({
  children,
  tone = 'stone',
}: {
  children: React.ReactNode
  tone?: 'stone' | 'green' | 'blue' | 'amber' | 'red' | 'purple'
}) {
  const tones: Record<string, string> = {
    stone: 'bg-stone-100 text-stone-700',
    green: 'bg-emerald-100 text-emerald-800',
    blue: 'bg-sky-100 text-sky-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-violet-100 text-violet-800',
  }
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-left text-sm font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

export function Section({
  title,
  intro,
  children,
  id,
}: {
  title: string
  intro?: string
  children: React.ReactNode
  id?: string
}) {
  return (
    <section id={id} className="card space-y-4">
      <div>
        <h2>{title}</h2>
        {intro ? <p className="mt-1 text-stone-600">{intro}</p> : null}
      </div>
      {children}
    </section>
  )
}
