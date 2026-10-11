export const DEFAULT_DATABASE_URL = 'file:./data/outreach.db'

/** Replit injects a PostgreSQL URL, but this app exclusively uses SQLite/libsql. */
export function resolveDatabaseUrl(value: string | undefined): string {
  const url = value?.trim()
  if (!url || /^postgres(?:ql)?:/i.test(url)) return DEFAULT_DATABASE_URL
  return url
}
