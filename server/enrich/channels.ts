// Which channels a lead can actually be reached on. Pure. Recomputed after every enrichment.
import type { LeadChannels } from '../../shared/types.ts'
import type { Lead } from '../db/schema.ts'

export type ChannelInput = Pick<
  Lead,
  | 'email'
  | 'email_status'
  | 'phone'
  | 'linkedin_url'
  | 'instagram_url'
  | 'mailing_street'
  | 'mailing_zip'
  | 'mailing_city'
>

/** Settings toggles and suppression are applied later by outreach; this is "do we have a way in". */
export function computeChannels(lead: ChannelInput): LeadChannels {
  const email = Boolean(lead.email) && lead.email_status !== 'invalid'
  const mail = Boolean(lead.mailing_street) && Boolean(lead.mailing_zip || lead.mailing_city)
  return {
    email,
    mail,
    linkedin: Boolean(lead.linkedin_url),
    instagram: Boolean(lead.instagram_url),
    call: Boolean(lead.phone),
  }
}

/** The orchestrator stops calling providers once this is true. */
export function hasEnoughContact(lead: Pick<Lead, 'email' | 'linkedin_url' | 'phone'>): boolean {
  return Boolean(lead.email) && (Boolean(lead.linkedin_url) || Boolean(lead.phone))
}
