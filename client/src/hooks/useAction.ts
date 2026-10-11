// One hook for every button that calls the API: busy flag, toast on success, toast on error,
// and a calm "still being built" flag instead of a toast when the server answers 501.
import { useCallback, useRef, useState } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { errorMessage, isNotBuilt } from '../api.ts'
import { useToast } from '../components/Toast.tsx'

export interface ActionOptions<R> {
  /** Toast text on success. A function gets the result. */
  success?: string | ((result: R) => string)
  onSuccess?: (result: R) => void | Promise<void>
  /** Query keys to invalidate after success. */
  invalidate?: QueryKey[]
  /** Skip the error toast (the caller shows the error inline). */
  quiet?: boolean
}

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>
  busy: boolean
  notBuilt: boolean
  error: string | null
  reset: () => void
}

export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: ActionOptions<R> = {},
): Action<A, R> {
  const toast = useToast()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [notBuilt, setNotBuilt] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Options are read through a ref so a stable `fn` still sees the latest callbacks.
  const optsRef = useRef(opts)
  optsRef.current = opts

  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true)
      setError(null)
      const opts = optsRef.current
      try {
        const result = await fn(...args)
        setNotBuilt(false)
        if (opts.success) {
          toast.ok(typeof opts.success === 'function' ? opts.success(result) : opts.success)
        }
        if (opts.invalidate) {
          await Promise.all(opts.invalidate.map((key) => qc.invalidateQueries({ queryKey: key })))
        }
        await opts.onSuccess?.(result)
        return result
      } catch (err) {
        if (isNotBuilt(err)) {
          setNotBuilt(true)
          return undefined
        }
        const text = errorMessage(err)
        setError(text)
        if (!opts.quiet) toast.error(text)
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [fn, qc, toast],
  )

  const reset = useCallback(() => {
    setNotBuilt(false)
    setError(null)
  }, [])

  return { run, busy, notBuilt, error, reset }
}
