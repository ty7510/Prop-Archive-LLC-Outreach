import { useEffect } from 'react'
import { Link, Redirect, Route, Switch, useLocation } from 'wouter'
import { useQuery } from '@tanstack/react-query'
import { Users, ListOrdered, Settings as SettingsIcon, Play, LogOut } from 'lucide-react'
import clsx from 'clsx'
import { health, logout, me } from './api.ts'
import Login from './pages/Login.tsx'
import Leads from './pages/Leads.tsx'
import Sequences from './pages/Sequences.tsx'
import Settings from './pages/Settings.tsx'
import Go from './pages/Go.tsx'

const NAV = [
  { href: '/leads', label: 'Leads', icon: Users },
  { href: '/sequences', label: 'Sequences', icon: ListOrdered },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
  { href: '/go', label: 'Go', icon: Play },
] as const

function StatusPills() {
  const q = useQuery({ queryKey: ['health'], queryFn: health, refetchInterval: 15_000 })
  const live = q.data?.liveMode ?? false
  const auto = q.data?.autopilotOn ?? false
  return (
    <div className="flex items-center gap-2">
      <span
        className={clsx('pill', live ? 'bg-emerald-600 text-white' : 'bg-stone-200 text-stone-700')}
        title={
          live
            ? 'Email and mail go out in the send window'
            : 'Nothing is sent, everything is queued'
        }
      >
        {live ? 'Live' : 'Dry run'}
      </span>
      <span
        className={clsx('pill', auto ? 'bg-sky-600 text-white' : 'bg-stone-200 text-stone-700')}
      >
        Autopilot {auto ? 'on' : 'off'}
      </span>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation()
  async function onLogout() {
    await logout()
    navigate('/login')
  }
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-stone-200 bg-white md:w-60 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-4 md:block">
          <Link href="/go" className="text-lg font-semibold">
            Prop Archive Outreach
          </Link>
          <div className="md:hidden">
            <StatusPills />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = location.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex min-h-tap flex-1 items-center justify-center gap-2 rounded-lg px-2 text-base font-medium md:flex-none md:justify-start md:gap-3 md:px-3 md:text-lg',
                  active ? 'bg-emerald-50 text-emerald-800' : 'text-stone-700 hover:bg-stone-100',
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="hidden px-3 pb-4 md:mt-auto md:block">
          <button type="button" onClick={onLogout} className="btn-secondary w-full">
            <LogOut className="h-4 w-4" aria-hidden /> Log out
          </button>
        </div>
      </aside>
      <main className="flex-1">
        <header className="hidden items-center justify-end gap-3 border-b border-stone-200 bg-white px-6 py-3 md:flex">
          <StatusPills />
        </header>
        <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
      </main>
    </div>
  )
}

function Protected({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation()
  const q = useQuery({ queryKey: ['me'], queryFn: me, retry: false })
  useEffect(() => {
    if (q.data && !q.data.loggedIn) navigate('/login')
  }, [q.data, navigate])
  if (q.isLoading) return <p className="p-6 text-stone-600">Loading</p>
  if (!q.data?.loggedIn) return null
  return <Shell>{children}</Shell>
}

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/">
        <Redirect to="/go" />
      </Route>
      <Route path="/leads/*?">
        <Protected>
          <Leads />
        </Protected>
      </Route>
      <Route path="/sequences/*?">
        <Protected>
          <Sequences />
        </Protected>
      </Route>
      <Route path="/settings">
        <Protected>
          <Settings />
        </Protected>
      </Route>
      <Route path="/go">
        <Protected>
          <Go />
        </Protected>
      </Route>
      <Route>
        <Protected>
          <div className="card">
            <h1>Page not found</h1>
            <p className="mt-2">
              <Link href="/go" className="text-emerald-700 underline">
                Back to Go
              </Link>
            </p>
          </div>
        </Protected>
      </Route>
    </Switch>
  )
}
