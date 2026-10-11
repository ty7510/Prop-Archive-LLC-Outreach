import { useState, type FormEvent } from 'react'
import { useLocation } from 'wouter'
import { useQueryClient } from '@tanstack/react-query'
import { ApiRequestError, login } from '../api.ts'

export default function Login() {
  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login({ password })
      await qc.invalidateQueries({ queryKey: ['me'] })
      navigate('/go')
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not log in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1>Prop Archive Outreach</h1>
          <p className="mt-1 text-stone-600">Enter the password to continue.</p>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Password</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy || !password}>
          {busy ? 'Logging in' : 'Log in'}
        </button>
      </form>
    </div>
  )
}
