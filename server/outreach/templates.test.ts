import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'
import { HttpError } from '../lib/http.ts'
import type { Llm } from './deps.ts'
import {
  assertNoEmDash,
  buildVars,
  emailFooter,
  neighborhoodFor,
  renderStepForLead,
  renderTemplate,
  sampleLead,
  tidy,
  trackedLinks,
  triggerLine,
} from './templates.ts'

const settings = { ...DEFAULT_SETTINGS, physical_address: '123 Main St, Philadelphia, PA 19146' }
const ctx = {
  baseUrl: 'https://outreach.test',
  channel: 'email' as const,
  sequenceName: 'Ray Email A',
}

describe('template vars', () => {
  it('maps zips to neighbourhoods and falls back to the city', () => {
    expect(neighborhoodFor(['19104'])).toBe('University City')
    expect(neighborhoodFor(['99999', '19125'])).toBe('Fishtown/Kensington')
    expect(neighborhoodFor([], '19146')).toBe('Point Breeze/Graduate Hospital')
    expect(neighborhoodFor([], '00000')).toBe('Philadelphia')
  })

  it('writes one trigger sentence or nothing', () => {
    expect(triggerLine({ type: 'new_license' })).toMatch(/rental license/)
    expect(triggerLine({ type: 'recent_sale' })).toMatch(/purchase/)
    expect(triggerLine({ type: 'none' })).toBe('')
    expect(triggerLine({ type: 'csv' })).toBe('')
  })

  it('builds every variable for a lead', () => {
    const lead = sampleLead(new Date('2026-10-13T14:00:00Z'))
    const vars = buildVars(lead, settings, ctx)
    expect(vars.first_name).toBe('Ray')
    expect(vars.full_name).toBe('Ray Example')
    expect(vars.company).toBe('Example Properties LLC')
    expect(vars.property_count).toBe('9')
    expect(vars.unit_count).toBe('14')
    expect(vars.neighborhood).toBe('Point Breeze/Graduate Hospital')
    expect(vars.trigger_line).toMatch(/rental license/)
    expect(vars.sender_name).toBe('Theo at Prop Archive')
    expect(vars.demo_link).toBe('https://outreach.test/r/sample-token/demo?c=email&s=ray-email-a')
    expect(vars.beta_link).toBe('https://outreach.test/r/sample-token/beta?c=email&s=ray-email-a')
    expect(vars.site_link).toBe('https://outreach.test/r/sample-token/site?c=email&s=ray-email-a')
    expect(vars.unsubscribe_link).toBe('https://outreach.test/u/sample-token')
  })

  it('falls back to "there" and the company when names are missing', () => {
    const lead = { ...sampleLead(), first_name: null, full_name: null, last_name: null }
    const vars = buildVars(lead, settings, ctx)
    expect(vars.first_name).toBe('there')
    expect(vars.full_name).toBe('Example Properties LLC')
    const zero = { ...lead, property_count: 0, unit_count: 0 }
    expect(buildVars(zero, settings, ctx).property_count).toBe('')
  })

  it('tracked links carry the channel and sequence slug', () => {
    const links = trackedLinks({ unsubscribe_token: 'abc' }, { ...ctx, channel: 'linkedin' })
    expect(links.demo_link).toBe('https://outreach.test/r/abc/demo?c=linkedin&s=ray-email-a')
  })
})

describe('renderTemplate', () => {
  it('replaces known vars and reports unknown ones as empty', () => {
    const r = renderTemplate('Hi {{first_name}}, {{ nope }} you own {{property_count}}.', {
      first_name: 'Ray',
      property_count: '9',
    })
    expect(r.text).toBe('Hi Ray,  you own 9.')
    expect(r.missing).toEqual(['nope'])
  })

  it('tidies blank lines left by empty vars', () => {
    expect(tidy('a\n\n\n\nb  \n')).toBe('a\n\nb')
    const r = renderTemplate('Hi\n\n{{trigger_line}}\n\nBye', { trigger_line: '' })
    expect(r.text).toBe('Hi\n\nBye')
  })
})

describe('renderStepForLead', () => {
  const lead = sampleLead(new Date('2026-10-13T14:00:00Z'))

  it('appends the CAN-SPAM footer to email with the physical address and unsubscribe link', async () => {
    const r = await renderStepForLead(
      { subject: 'Hello {{first_name}}', body: 'Body for {{full_name}}.', channel: 'email' },
      lead,
      settings,
      ctx,
      null,
      { logWarn: false },
    )
    expect(r.subject).toBe('Hello Ray')
    expect(r.body).toContain('Body for Ray Example.')
    expect(r.body).toContain(
      '\n\nTheo at Prop Archive, Prop Archive LLC\n123 Main St, Philadelphia, PA 19146\nNo more emails: https://outreach.test/u/sample-token',
    )
    expect(r.body.endsWith(emailFooter(buildVars(lead, settings, ctx)))).toBe(true)
  })

  it('does not add the footer to human channels', async () => {
    const r = await renderStepForLead(
      { subject: null, body: 'Quick note {{first_name}}', channel: 'linkedin' },
      lead,
      settings,
      { ...ctx, channel: 'linkedin' },
      null,
      { logWarn: false },
    )
    expect(r.subject).toBeNull()
    expect(r.body).toBe('Quick note Ray')
  })

  it('renders {{ai_opener}} empty without a model and uses the model when present', async () => {
    const step = {
      subject: null,
      body: '{{ai_opener}}\n\nMore text.',
      channel: 'linkedin' as const,
    }
    const none = await renderStepForLead(step, lead, settings, ctx, null, { logWarn: false })
    expect(none.body).toBe('More text.')
    const llm: Llm = {
      text: async () => 'Nine places in Point Breeze is a lot of paperwork.',
      structured: async () => null,
    }
    const withAi = await renderStepForLead(step, lead, settings, ctx, llm, { logWarn: false })
    expect(withAi.body).toBe('Nine places in Point Breeze is a lot of paperwork.\n\nMore text.')
  })

  it('reports missing vars', async () => {
    const r = await renderStepForLead(
      { subject: null, body: 'Hi {{whoops}}', channel: 'call' },
      lead,
      settings,
      ctx,
      null,
      { logWarn: false },
    )
    expect(r.missing).toEqual(['whoops'])
    expect(r.body).toBe('Hi')
  })
})

describe('em-dash guard', () => {
  it('refuses a step body, subject, notes, name or description with an em-dash', () => {
    const ok = [{ subject: 'Hi', body: 'Plain - hyphen is fine', notes: null }]
    expect(() => assertNoEmDash(ok, 'Name', 'Desc')).not.toThrow()
    const bad = (steps: Parameters<typeof assertNoEmDash>[0]) => {
      try {
        assertNoEmDash(steps)
        return null
      } catch (e) {
        return e as HttpError
      }
    }
    expect(bad([{ body: 'Oops — here' }])?.status).toBe(400)
    expect(bad([{ body: 'Oops — here' }])?.code).toBe('EM_DASH')
    expect(bad([{ body: 'fine' }, { subject: 'Sub — ject', body: 'ok' }])?.message).toMatch(
      /Step 2/,
    )
    expect(bad([{ body: 'ok', notes: 'n — n' }])?.code).toBe('EM_DASH')
    expect(() => assertNoEmDash([], 'Na — me')).toThrow(HttpError)
    expect(() => assertNoEmDash([], 'Name', 'de — sc')).toThrow(HttpError)
  })
})
