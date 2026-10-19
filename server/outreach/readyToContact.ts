// Who may go on the To do list (Theo, 2026-10-19): only people with all three of an email address,
// a mailing address, and a LinkedIn profile that Enrich found. A LinkedIn link from an imported
// list, pasted by hand, or from the separate LinkedIn lookup does not count.
import { sql, type SQL } from 'drizzle-orm'
import { ENRICH_PROVIDER_IDS } from '../../shared/settings.ts'
import { leads, type Lead } from '../db/schema.ts'

const PROFILE = /linkedin\.com\/((?:in|company)\/[^/?#\s"'\\]+)/gi

/** "in/jane-doe-1a2b" for any spelling of a profile link (scheme, www, trailing slash, query). */
export function linkedInSlug(url: string | null | undefined): string | null {
  const m = /linkedin\.com\/((?:in|company)\/[^/?#\s"'\\]+)/i.exec(url ?? '')
  return m ? m[1]!.toLowerCase() : null
}

/** True when an Enrich provider's saved answer has this lead's LinkedIn profile in it. */
export function linkedInFoundByEnrich(lead: Pick<Lead, 'linkedin_url' | 'enrichment'>): boolean {
  const slug = linkedInSlug(lead.linkedin_url)
  if (!slug) return false
  return ENRICH_PROVIDER_IDS.some((id) => {
    const entry = lead.enrichment?.[id]
    if (!entry) return false
    const text = JSON.stringify(entry.data ?? null)
    for (const m of text.matchAll(PROFILE)) if (m[1]!.toLowerCase() === slug) return true
    return false
  })
}

/** Email, mailing address, and a LinkedIn that Enrich found. */
export function readyToContact(
  lead: Pick<Lead, 'email' | 'email_status' | 'mailing_street' | 'linkedin_url' | 'enrichment'>,
): boolean {
  return (
    Boolean((lead.email ?? '').trim()) &&
    lead.email_status !== 'invalid' &&
    Boolean((lead.mailing_street ?? '').trim()) &&
    linkedInFoundByEnrich(lead)
  )
}

/** readyToContact as a SQL condition on leads, so people who are not ready are never picked. */
export function readyToContactSql(): SQL {
  const providers = sql.join(
    ENRICH_PROVIDER_IDS.map((id) => sql`${id}`),
    sql`, `,
  )
  const slug = sql`lower(substring(${leads.linkedin_url} from 'linkedin\\.com/((?:in|company)/[^/?#[:space:]"''\\\\]+)'))`
  return sql`(
    trim(coalesce(${leads.email}, '')) <> ''
    and ${leads.email_status} <> 'invalid'
    and trim(coalesce(${leads.mailing_street}, '')) <> ''
    and ${slug} is not null
    and exists (
      select 1
      from jsonb_each(coalesce(${leads.enrichment}, '{}'::jsonb)) e,
        regexp_matches(e.value::text, 'linkedin\\.com/((?:in|company)/[^/?#[:space:]"''\\\\]+)', 'gi') m
      where e.key in (${providers}) and lower(m[1]) = ${slug}
    )
  )`
}
