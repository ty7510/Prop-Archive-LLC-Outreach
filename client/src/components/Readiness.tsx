// "Ready to run the sequence?" One line per thing still to set, with the fix. Settings and Sequences.
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Circle, XCircle } from 'lucide-react'
import { getReadiness } from '../api.ts'
import { ErrorNote, Loading } from './QueryState.tsx'

export default function Readiness() {
  // Always fresh: each line reflects what you just did on another page.
  const q = useQuery({
    queryKey: ['readiness'],
    queryFn: getReadiness,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorNote error={q.error} retry={() => void q.refetch()} />
  const items = q.data
  const required = items.filter((i) => i.required)
  const done = required.filter((i) => i.ok).length
  return (
    <section className="card space-y-3" aria-labelledby="readiness-title">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="readiness-title">Ready to run the sequence?</h2>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            {q.isFetching ? 'Checking' : 'Check again'}
          </button>
        </div>
        <p className="mt-1 text-stone-600">
          {done === required.length
            ? 'Everything is set. The sequence runs every send window.'
            : `${done} of ${required.length} done. Each line says what to do.`}
        </p>
      </div>
      <ul className="space-y-2">
        {items.map((item) => {
          const Icon = item.ok ? CheckCircle2 : item.required ? XCircle : Circle
          return (
            <li key={item.key} className="flex gap-3">
              <Icon
                className={
                  item.ok
                    ? 'mt-0.5 h-5 w-5 shrink-0 text-emerald-600'
                    : item.required
                      ? 'mt-0.5 h-5 w-5 shrink-0 text-red-600'
                      : 'mt-0.5 h-5 w-5 shrink-0 text-stone-400'
                }
                aria-label={item.ok ? 'Done' : item.required ? 'Needed' : 'Recommended'}
              />
              <div className="min-w-0">
                <p className="break-words font-medium">
                  {item.label}
                  {!item.required && !item.ok ? (
                    <span className="ml-2 text-sm font-normal text-stone-500">recommended</span>
                  ) : null}
                </p>
                {!item.ok ? <p className="break-words text-stone-600">{item.fix}</p> : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
