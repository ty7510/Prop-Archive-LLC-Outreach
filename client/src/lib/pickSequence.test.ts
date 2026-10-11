import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { NO_CHANNELS } from '@shared/types'
import { pickSequence } from './pickSequence.ts'
import type { Lead, Sequence } from '../types.ts'

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: 'L1',
  created_at: '2026-10-11T00:00:00Z',
  updated_at: '2026-10-11T00:00:00Z',
  source: 'opa',
  status: 'enriched',
  persona: 'maya',
  icp_score: 70,
  owner_kind: 'person',
  full_name: 'Maya Rivera',
  first_name: 'Maya',
  last_name: 'Rivera',
  company: null,
  email: 'maya@example.com',
  email_status: 'valid',
  phone: null,
  phone_type: 'unknown',
  linkedin_url: null,
  instagram_url: null,
  website: null,
  mailing_street: null,
  mailing_city: null,
  mailing_state: null,
  mailing_zip: null,
  mailing_verified: false,
  property_count: 4,
  unit_count: 6,
  zips: ['19139'],
  trigger: { type: 'none' },
  channels: { ...NO_CHANNELS, email: true },
  enrichment: {},
  tags: [],
  notes: null,
  do_not_contact: false,
  unsubscribe_token: 'tok',
  last_contacted_at: null,
  last_replied_at: null,
  next_action_at: null,
  dedupe_key: null,
  ...over,
})

const seq = (id: string, channel: Sequence['channel']): Sequence => ({
  id,
  name: `${channel} ${id}`,
  channel,
  persona: 'maya',
  trigger: 'any',
  active: true,
  description: null,
  created_at: '',
  updated_at: '',
  steps: [],
})

const sequences = [seq('E', 'email'), seq('C', 'call'), seq('K', 'linkedin')]

const settings = {
  ...DEFAULT_SETTINGS,
  sequence_by_persona: {
    ...DEFAULT_SETTINGS.sequence_by_persona,
    maya: { email: 'E', mail: null, linkedin: 'K', instagram: null, call: 'C' },
  },
}

describe('pickSequence', () => {
  it('picks email first when the lead has an email', () => {
    const p = pickSequence(lead(), settings, sequences)
    expect(p.channel).toBe('email')
    expect(p.sequence?.id).toBe('E')
    expect(p.reason).toBe('')
  })
  it('skips channels the lead cannot use', () => {
    const p = pickSequence(lead({ channels: { ...NO_CHANNELS, call: true } }), settings, sequences)
    expect(p.channel).toBe('call')
    expect(p.sequence?.id).toBe('C')
  })
  it('skips channels turned off in settings', () => {
    const off = { ...settings, channels: { ...settings.channels, email: false } }
    const p = pickSequence(
      lead({ channels: { ...NO_CHANNELS, email: true, linkedin: true } }),
      off,
      sequences,
    )
    expect(p.channel).toBe('linkedin')
  })
  it('falls back to the first configured channel when the lead is not enriched yet', () => {
    const p = pickSequence(lead({ channels: NO_CHANNELS }), settings, sequences)
    expect(p.channel).toBe('email')
    expect(p.sequence?.id).toBe('E')
  })
  it('explains when nothing can be picked', () => {
    expect(pickSequence(lead({ do_not_contact: true }), settings, sequences).reason).toMatch(
      /do not contact/i,
    )
    expect(pickSequence(lead({ persona: 'unknown' }), settings, sequences).reason).toMatch(
      /unknown/i,
    )
    expect(pickSequence(lead({ persona: 'ray' }), settings, sequences).reason).toMatch(
      /No sequence set/,
    )
    expect(pickSequence(lead(), settings, []).reason).toMatch(/no longer exists/)
  })
})
