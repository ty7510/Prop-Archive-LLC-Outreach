// Client view of the server rows. Mirrors server/db/schema.ts field names (spec section 4)
// without importing drizzle into the browser bundle.
import type {
  Channel,
  EmailStatus,
  EnrollmentStatus,
  EventKind,
  LeadChannels,
  LeadEnrichment,
  LeadPersona,
  LeadSource,
  LeadStatus,
  LeadTrigger,
  MessageDirection,
  MessageStatus,
  OwnerKind,
  PhoneType,
  ReplyClassification,
  SequencePersona,
  SequenceTrigger,
} from '@shared/types'

export interface Lead {
  id: string
  created_at: string
  updated_at: string
  source: LeadSource
  status: LeadStatus
  persona: LeadPersona
  icp_score: number
  owner_kind: OwnerKind
  full_name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  email: string | null
  email_status: EmailStatus
  phone: string | null
  phone_type: PhoneType
  linkedin_url: string | null
  instagram_url: string | null
  facebook_url: string | null
  website: string | null
  mailing_street: string | null
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  mailing_verified: boolean
  property_count: number
  unit_count: number
  zips: string[]
  trigger: LeadTrigger
  channels: LeadChannels
  enrichment: LeadEnrichment
  tags: string[]
  notes: string | null
  do_not_contact: boolean
  unsubscribe_token: string
  last_contacted_at: string | null
  last_replied_at: string | null
  next_action_at: string | null
  dedupe_key: string | null
}

export interface Property {
  id: string
  lead_id: string
  address: string | null
  zip: string | null
  category: string | null
  units: number | null
  sale_date: string | null
  sale_price: number | null
  market_value: number | null
  opa_account: string | null
  license_num: string | null
  license_issue_date: string | null
  license_expiry: string | null
  source: LeadSource
}

export interface Enrollment {
  id: string
  lead_id: string
  sequence_id: string
  status: EnrollmentStatus
  current_step: number
  next_send_at: string | null
  started_at: string
  ended_at: string | null
  /** Some servers join the sequence name in; optional. */
  sequence_name?: string | null
}

export interface Message {
  id: string
  lead_id: string
  enrollment_id: string | null
  step_id: string | null
  channel: Channel
  direction: MessageDirection
  status: MessageStatus
  idempotency_key: string
  subject: string | null
  body: string
  to_address: string | null
  provider: string | null
  provider_message_id: string | null
  scheduled_at: string | null
  sent_at: string | null
  error: string | null
  classification: ReplyClassification | null
  created_at: string
}

export interface LeadEvent {
  id: string
  lead_id: string | null
  kind: EventKind
  detail: unknown
  at: string
}

export interface LeadDetail extends Lead {
  properties: Property[]
  enrollments: Enrollment[]
  messages: Message[]
  events: LeadEvent[]
}

export interface SequenceStep {
  id: string
  sequence_id: string
  step_index: number
  delay_days: number
  subject: string | null
  body: string
  channel: Channel
  notes: string | null
}

export interface Sequence {
  id: string
  name: string
  channel: Channel
  persona: SequencePersona
  trigger: SequenceTrigger
  active: boolean
  description: string | null
  created_at: string
  updated_at: string
  steps: SequenceStep[]
  /** How many leads have an active enrollment. Optional until the outreach builder sends it. */
  enrolled_count?: number
}
