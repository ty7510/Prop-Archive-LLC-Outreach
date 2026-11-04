// The lead list as one CSV file: every lead on a row, the same order as the Leads page (best ICP
// score first). The first columns use the import's own header names, so the file imports back
// into Prop Archive (or any spreadsheet) as it is; the rest carry status and contact history.
import type { LeadRow } from '../routes/leads.ts'

interface Column {
  header: string
  value: (lead: LeadRow) => string | number | boolean | null | undefined
}

/** "2026-11-04 09:15" in the given time zone, blank when unset. */
function when(iso: string | null, tz: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`
}

function columns(tz: string): Column[] {
  return [
    { header: 'Name', value: (l) => l.display_name },
    { header: 'First name', value: (l) => l.first_name },
    { header: 'Last name', value: (l) => l.last_name },
    { header: 'Company', value: (l) => l.company },
    { header: 'Email Address', value: (l) => l.email },
    { header: 'Email status', value: (l) => l.email_status },
    { header: 'Phone', value: (l) => l.phone },
    { header: 'Phone type', value: (l) => l.phone_type },
    { header: 'Street Address', value: (l) => l.mailing_street },
    { header: 'City', value: (l) => l.mailing_city },
    { header: 'State', value: (l) => l.mailing_state },
    { header: 'Zip', value: (l) => l.mailing_zip },
    { header: 'Address verified', value: (l) => (l.mailing_verified ? 'yes' : '') },
    { header: '# Properties', value: (l) => l.property_count },
    { header: 'Units', value: (l) => l.unit_count },
    { header: 'Zips', value: (l) => l.zips.join(', ') },
    { header: 'LinkedIn', value: (l) => l.linkedin_url },
    { header: 'Instagram', value: (l) => l.instagram_url },
    { header: 'Facebook', value: (l) => l.facebook_url },
    { header: 'Website', value: (l) => l.website },
    { header: 'Status', value: (l) => l.status },
    { header: 'Persona', value: (l) => (l.persona === 'unknown' ? '' : l.persona) },
    { header: 'ICP score', value: (l) => l.icp_score },
    { header: 'Owner kind', value: (l) => (l.owner_kind === 'unknown' ? '' : l.owner_kind) },
    { header: 'Neighborhood', value: (l) => l.neighborhood },
    { header: 'Tags', value: (l) => l.tags.join(', ') },
    { header: 'Notes', value: (l) => l.notes },
    { header: 'Do not contact', value: (l) => (l.do_not_contact ? 'yes' : '') },
    { header: 'Source', value: (l) => l.source },
    { header: 'Last contacted', value: (l) => when(l.last_contacted_at, tz) },
    { header: 'Last replied', value: (l) => when(l.last_replied_at, tz) },
    { header: 'Next action', value: (l) => when(l.next_action_at, tz) },
    { header: 'Created', value: (l) => when(l.created_at, tz) },
    { header: 'Updated', value: (l) => when(l.updated_at, tz) },
  ]
}

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, quote or line break. A cell that starts
 * with "=" or "@" gets a leading apostrophe so a spreadsheet shows it instead of running it as a
 * formula ("+" and "-" are left alone: phone numbers start with them).
 */
export function csvCell(raw: string | number | boolean | null | undefined): string {
  let s = raw == null ? '' : String(raw)
  if (/^[=@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The whole file: a UTF-8 byte order mark (so Excel reads accents), CRLF lines, header first. */
export function leadsCsv(rows: LeadRow[], tz: string): string {
  const cols = columns(tz)
  const lines = [cols.map((c) => csvCell(c.header)).join(',')]
  for (const lead of rows) lines.push(cols.map((c) => csvCell(c.value(lead))).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
