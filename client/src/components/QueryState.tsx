// Shared loading / error / empty / not-built rendering for react-query results.
import { Loader2, RefreshCw } from 'lucide-react'
import { errorMessage, isNotBuilt } from '../api.ts'
import NotBuilt from './NotBuilt.tsx'

export function Loading({ text = 'Loading' }: { text?: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-stone-600" role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {text}
    </p>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center">
      <p className="text-lg text-stone-700">{title}</p>
      {hint ? <p className="mt-1 text-stone-500">{hint}</p> : null}
    </div>
  )
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  if (isNotBuilt(error)) return <NotBuilt />
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-800"
    >
      <p>{errorMessage(error)}</p>
      {retry ? (
        <button type="button" onClick={retry} className="btn-secondary">
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </button>
      ) : null}
    </div>
  )
}

interface QueryLike<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
}

/**
 * Render a query: spinner while loading, calm note when not built, error with retry,
 * else `children(data)`. Pass `empty` to handle empty arrays.
 */
export function QueryView<T>({
  q,
  loading,
  empty,
  isEmpty,
  children,
}: {
  q: QueryLike<T>
  loading?: string
  empty?: React.ReactNode
  isEmpty?: (data: T) => boolean
  children: (data: T) => React.ReactNode
}) {
  if (q.isLoading) return <Loading text={loading} />
  if (q.isError) return <ErrorNote error={q.error} retry={() => q.refetch()} />
  if (q.data === undefined) return null
  if (empty !== undefined) {
    const emptyNow = isEmpty ? isEmpty(q.data) : Array.isArray(q.data) && q.data.length === 0
    if (emptyNow) return <>{empty}</>
  }
  return <>{children(q.data)}</>
}
