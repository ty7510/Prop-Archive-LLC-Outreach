// Tiny toast system: a provider at the root, useToast() anywhere. Auto dismiss, big tap targets.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, X } from 'lucide-react'
import clsx from 'clsx'

export type ToastKind = 'ok' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

interface ToastApi {
  ok: (text: string) => void
  error: (text: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++
      setToasts((list) => [...list.slice(-3), { id, kind, text }])
      window.setTimeout(() => dismiss(id), kind === 'ok' ? 4000 : 8000)
    },
    [dismiss],
  )

  const value = useMemo<ToastApi>(
    () => ({ ok: (t) => push('ok', t), error: (t) => push('error', t) }),
    [push],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl px-4 py-3 shadow-lg',
              t.kind === 'ok' ? 'bg-stone-900 text-white' : 'bg-red-700 text-white',
            )}
          >
            {t.kind === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            )}
            <p className="flex-1 text-base">{t.text}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-m-2 rounded-lg p-2 hover:bg-white/10"
              aria-label="Close"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast needs a ToastProvider')
  return ctx
}
