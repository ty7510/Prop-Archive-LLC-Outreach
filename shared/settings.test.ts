import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  SettingsSchema,
  deepMerge,
  mergeSettings,
} from './settings.ts'

describe('DEFAULT_SETTINGS', () => {
  it('matches spec section 7', () => {
    expect(DEFAULT_SETTINGS.autopilot_on).toBe(false)
    expect(DEFAULT_SETTINGS.live_mode).toBe(false)
    expect(DEFAULT_SETTINGS.owner_name).toBe('Theo Young')
    expect(DEFAULT_SETTINGS.owner_email).toBe('theo@proparchive.biz')
    expect(DEFAULT_SETTINGS.from_name).toBe('Theo at Prop Archive')
    expect(DEFAULT_SETTINGS.from_email).toBe('theo@proparchive.biz')
    expect(DEFAULT_SETTINGS.reply_to).toBe('theo@proparchive.biz')
    expect(DEFAULT_SETTINGS.physical_address).toBe('')
    expect(DEFAULT_SETTINGS.site_url).toBe('https://proparchive.app')
    expect(DEFAULT_SETTINGS.demo_url).toBe('https://proparchive.app/demo')
    expect(DEFAULT_SETTINGS.beta_url).toBe('https://proparchive.app/?beta=1')
    expect(DEFAULT_SETTINGS.target_zips).toEqual([
      '19104',
      '19121',
      '19122',
      '19139',
      '19143',
      '19146',
      '19125',
    ])
    expect(DEFAULT_SETTINGS.min_props).toBe(3)
    expect(DEFAULT_SETTINGS.max_props).toBe(20)
    expect(DEFAULT_SETTINGS.min_icp_score).toBe(50)
    expect(DEFAULT_SETTINGS.personas).toEqual(['maya', 'ray', 'denise'])
    expect(DEFAULT_SETTINGS.channels).toEqual({
      email: true,
      mail: false,
      linkedin: true,
      instagram: false,
      call: true,
    })
    expect(DEFAULT_SETTINGS.daily_caps).toEqual({
      email: 20,
      mail: 10,
      linkedin: 15,
      instagram: 10,
      call: 10,
    })
    expect(DEFAULT_SETTINGS.send_window).toEqual({
      tz: 'America/New_York',
      days: [1, 2, 3, 4, 5],
      start: '08:30',
      end: '17:00',
    })
    expect(DEFAULT_SETTINGS.max_new_leads_per_day).toBe(50)
    expect(DEFAULT_SETTINGS.enrichment.providers).toEqual([
      'li_license',
      'claude_research',
      'hunter',
      'apollo',
      'pdl',
    ])
    expect(DEFAULT_SETTINGS.enrichment.monthly_credit_cap).toEqual({
      hunter: 50,
      apollo: 100,
      pdl: 50,
      claude_research: 200,
    })
    expect(DEFAULT_SETTINGS.sequence_by_persona.maya.email).toBeNull()
    expect(DEFAULT_SETTINGS.sequence_by_persona.denise.call).toBeNull()
    expect(DEFAULT_SETTINGS.email_provider).toBe('smtp')
    expect(DEFAULT_SETTINGS.mail_provider).toBe('print')
    expect(DEFAULT_SETTINGS.notify_owner_on_reply).toBe(true)
    expect(DEFAULT_SETTINGS.human_queue_webhook_url).toBe('')
    expect(DEFAULT_SETTINGS.webhook_secret).toBe('')
  })

  it('lists every key', () => {
    expect(SETTINGS_KEYS).toContain('live_mode')
    expect(SETTINGS_KEYS).toContain('sequence_by_persona')
    expect(SETTINGS_KEYS.length).toBe(Object.keys(DEFAULT_SETTINGS).length)
  })
})

describe('mergeSettings', () => {
  it('returns defaults for an empty patch', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('merges nested objects and replaces arrays', () => {
    const s = mergeSettings({ channels: { mail: true }, target_zips: ['19146'] })
    expect(s.channels).toEqual({ ...DEFAULT_SETTINGS.channels, mail: true })
    expect(s.target_zips).toEqual(['19146'])
    expect(s.daily_caps).toEqual(DEFAULT_SETTINGS.daily_caps)
  })

  it('merges two levels deep for sequence_by_persona', () => {
    const s = mergeSettings({ sequence_by_persona: { ray: { email: 'seq1' } } })
    expect(s.sequence_by_persona.ray.email).toBe('seq1')
    expect(s.sequence_by_persona.ray.call).toBeNull()
    expect(s.sequence_by_persona.maya).toEqual(DEFAULT_SETTINGS.sequence_by_persona.maya)
  })

  it('drops unknown keys', () => {
    const s = mergeSettings({ bogus: 1 }) as unknown as Record<string, unknown>
    expect('bogus' in s).toBe(false)
  })

  it('merges onto a given base', () => {
    const base = mergeSettings({ owner_name: 'A', min_props: 5 })
    const s = mergeSettings({ owner_name: 'B' }, base)
    expect(s.owner_name).toBe('B')
    expect(s.min_props).toBe(5)
  })

  it('throws on invalid values', () => {
    expect(() => mergeSettings({ min_icp_score: 101 })).toThrow()
    expect(() => mergeSettings({ send_window: { start: '8:30am' } })).toThrow()
    expect(() => mergeSettings({ target_zips: ['abcde'] })).toThrow()
    expect(() => mergeSettings({ email_provider: 'pigeon' })).toThrow()
    expect(() => mergeSettings({ personas: ['bob'] })).toThrow()
    expect(() => mergeSettings({ human_queue_webhook_url: 'not a url' })).toThrow()
  })

  it('accepts an empty webhook url and a real one', () => {
    expect(mergeSettings({ human_queue_webhook_url: '' }).human_queue_webhook_url).toBe('')
    expect(
      mergeSettings({ human_queue_webhook_url: 'https://example.com/hook' })
        .human_queue_webhook_url,
    ).toBe('https://example.com/hook')
  })

  it('links and the webhook must be https with a host', () => {
    expect(() => mergeSettings({ human_queue_webhook_url: 'http://example.com/hook' })).toThrow()
    expect(() => mergeSettings({ site_url: 'http://proparchive.app' })).toThrow()
    expect(() => mergeSettings({ demo_url: 'javascript:alert(1)' })).toThrow()
    expect(() => mergeSettings({ beta_url: 'file:///etc/passwd' })).toThrow()
    expect(() => mergeSettings({ site_url: 'https://' })).toThrow()
    expect(mergeSettings({ site_url: ' https://proparchive.app/ ' }).site_url).toBe(
      'https://proparchive.app/',
    )
  })
})

describe('deepMerge', () => {
  it('does not mutate the base', () => {
    const base = { a: { b: 1, c: 2 }, d: [1, 2] }
    const out = deepMerge(base, { a: { b: 9 }, d: [3] })
    expect(out).toEqual({ a: { b: 9, c: 2 }, d: [3] })
    expect(base).toEqual({ a: { b: 1, c: 2 }, d: [1, 2] })
  })
  it('ignores undefined patch values', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 })
  })
})

describe('SettingsSchema', () => {
  it('parses a full round trip', () => {
    const parsed = SettingsSchema.parse(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
    expect(parsed).toEqual(DEFAULT_SETTINGS)
  })
})
