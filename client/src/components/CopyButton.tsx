// Copy to clipboard with a short "Copied" confirmation. Falls back to a hidden textarea.
import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import clsx from 'clsx'

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea trick
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function CopyButton({
  text,
  label = 'Copy',
  className,
  compact = false,
}: {
  text: string
  label?: string
  className?: string
  /** Icon only, for rows of fields. */
  compact?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const t = window.setTimeout(() => setState('idle'), 1500)
    return () => window.clearTimeout(t)
  }, [state])

  async function onClick() {
    setState((await copyText(text)) ? 'copied' : 'failed')
  }

  const Icon = state === 'copied' ? Check : Copy
  const shown = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : label
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(compact ? 'btn-secondary min-w-tap px-2' : 'btn-secondary', className)}
      aria-label={compact ? `${label}: ${text}` : undefined}
      title={compact ? shown : undefined}
      disabled={!text}
    >
      <Icon className={clsx('h-4 w-4', state === 'copied' && 'text-emerald-600')} aria-hidden />
      {compact ? <span className="sr-only">{shown}</span> : shown}
    </button>
  )
}
