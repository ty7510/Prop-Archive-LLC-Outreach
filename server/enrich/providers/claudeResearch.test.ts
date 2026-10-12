import { describe, expect, it } from 'vitest'
import type { EnrichContext } from '../types.ts'
import { makeContext, makeLead, testEnv } from '../testing.ts'
import {
  buildResearchParams,
  buildResearchPrompt,
  researchLinks,
  createClaudeResearchProvider,
  mapResearchResult,
  RESEARCH_MAX_TOKENS,
  RESEARCH_MODEL,
  ResearchSchema,
  type ResearchClientFactory,
  type ResearchMessage,
  type ResearchParams,
  type ResearchResult,
} from './claudeResearch.ts'

const RENTALS = ['1022 Pine St', '650 N 54th St']

const found: ResearchResult = {
  full_name: 'Ray Torres',
  company: 'Torres Property Group LLC',
  contacts: [
    {
      field: 'phone',
      value: '(215) 555-0199',
      role: 'owner',
      source_url: 'https://hotpads.com/1022-pine-st-phila-pa-19107/202/pad',
      quote: '1022 Pine St #202, Philadelphia, PA 19107. Contact the owner at (215) 555-0199.',
    },
    {
      field: 'website',
      value: 'https://torrespg.com',
      role: 'owner',
      source_url: 'https://torrespg.com/contact',
      quote: 'Torres Property Group, torrespg.com. Call us at 215-555-0199.',
    },
    {
      field: 'linkedin_url',
      value: 'https://www.linkedin.com/in/raytorres',
      role: 'owner',
      source_url: 'https://www.linkedin.com/in/raytorres',
      quote: 'Ray Torres, Owner at Torres Property Group, Philadelphia',
    },
    {
      field: 'email',
      value: 'ray@torrespg.com',
      role: 'owner',
      source_url: 'https://torrespg.com/contact',
      quote: 'Email Ray Torres at ray@torrespg.com',
    },
    {
      field: 'phone',
      value: '267-616-2054',
      role: 'manager',
      source_url: 'https://www.rent.com/r/650-n-54th-st',
      quote: '650 N 54th St, managed by Next Door Managements, 267-616-2054',
    },
  ],
  mailing_street: null,
  mailing_city: null,
  mailing_state: null,
  mailing_zip: null,
  property_count: null,
  unit_count: null,
  property_details: [],
  confidence: 0.8,
  sources: ['https://torrespg.com/about'],
}

function fakeFactory(script: Partial<ResearchMessage>[]) {
  const seen: ResearchParams[] = []
  let i = 0
  const factory: ResearchClientFactory = () => ({
    async parse(params) {
      seen.push(params)
      const next = script[Math.min(i, script.length - 1)]
      i++
      return { stop_reason: 'end_turn', content: [], parsed_output: null, ...next }
    },
  })
  return { factory, seen }
}

const ctx = () => makeContext({ env: testEnv({ ANTHROPIC_API_KEY: 'sk-test' }) })

describe('buildResearchPrompt and params', () => {
  it('names the owner, the LLC and the facts we know, and forbids guessing', () => {
    const prompt = buildResearchPrompt(
      makeLead({
        company: 'Torres Property Group LLC',
        full_name: 'Ray Torres',
        owner_kind: 'llc',
        property_count: 9,
        zips: ['19143', '19139'],
        mailing_street: '55 Pine St',
        mailing_city: 'Philadelphia',
        mailing_state: 'PA',
        mailing_zip: '19146',
      }),
    )
    expect(prompt).toContain(
      'Find the public business presence of "Torres Property Group LLC Philadelphia landlord/property owner"',
    )
    expect(prompt).toContain('Ray Torres')
    expect(prompt).toContain('This is an LLC')
    expect(prompt).toContain('about 9 rental properties')
    expect(prompt).toContain('19143, 19139')
    expect(prompt).toContain('55 Pine St, Philadelphia, PA, 19146')
  })

  it('lists the rental addresses to search as listings', () => {
    const prompt = buildResearchPrompt(makeLead({ company: 'Glox LLC' }), RENTALS)
    expect(prompt).toContain('- 1022 Pine St, Philadelphia PA')
    expect(prompt).toContain('- 650 N 54th St, Philadelphia PA')
    expect(prompt).toContain('word-for-word quote')
  })

  it('uses the spec shape: model, effort high, json schema format, web search with max_uses 30', () => {
    const params = buildResearchParams('hello')
    expect(params.model).toBe(RESEARCH_MODEL)
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.max_tokens).toBe(RESEARCH_MAX_TOKENS)
    expect(params.output_config?.effort).toBe('high')
    expect(params.output_config?.format?.type).toBe('json_schema')
    const schema = params.output_config?.format?.schema as Record<string, unknown>
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      [
        'company',
        'confidence',
        'contacts',
        'full_name',
        'mailing_street',
        'mailing_city',
        'mailing_state',
        'mailing_zip',
        'property_count',
        'unit_count',
        'property_details',
        'sources',
      ].sort(),
    )
    expect(params.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 30 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 12 },
    ])
    expect(params.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(ResearchSchema.safeParse(found).success).toBe(true)
  })
})

describe('mapResearchResult', () => {
  const lead = () =>
    makeLead({ owner_kind: 'llc', full_name: 'Ray Torres', first_name: 'Ray', last_name: 'Torres' })

  it('saves the owner contacts the sources tie to them, never the manager line', () => {
    const r = mapResearchResult(found, lead(), 1, RENTALS)
    expect(r).toMatchObject({
      full_name: 'Ray Torres',
      owner_kind: 'person',
      company: 'Torres Property Group LLC',
      phone: '2155550199', // verified: the listing at their property shows it
      website: 'https://torrespg.com', // verified: the site shows the verified phone
      linkedin_url: 'https://www.linkedin.com/in/raytorres', // likely: names Ray Torres
      phone_type: 'unknown',
      confidence: 0.8,
      credits_used: 1,
    })
    // The email is only tied by name: likely is not enough for an address the sequence emails.
    expect(r.email).toBeUndefined()
    const raw = r.raw as { checked: { value: string; verdict: string; role: string }[] }
    expect(raw.checked.find((c) => c.role === 'manager')).toMatchObject({
      value: '2676162054',
      verdict: 'verified',
    })
  })

  it('saves an email when the source ties it to their property', () => {
    const withEmail: ResearchResult = {
      ...found,
      contacts: [
        {
          field: 'email',
          value: 'ray@torrespg.com',
          role: 'owner',
          source_url: 'https://www.zumper.com/x',
          quote: '650 N 54th St for rent. Questions: ray@torrespg.com',
        },
      ],
    }
    const r = mapResearchResult(withEmail, lead(), 1, RENTALS)
    expect(r).toMatchObject({ email: 'ray@torrespg.com', email_status: 'unknown' })
  })

  it('drops contacts the quote does not show or nothing ties to the owner, and clamps confidence', () => {
    const r = mapResearchResult(
      {
        ...found,
        confidence: 7,
        contacts: [
          {
            field: 'phone',
            value: '215-555-0111',
            role: 'owner',
            source_url: 'https://hotpads.com/x',
            quote: '1022 Pine St, call 215-555-0999', // a different number
          },
          {
            field: 'linkedin_url',
            value: 'https://www.linkedin.com/in/someone-else',
            role: 'owner',
            source_url: 'https://www.linkedin.com/in/someone-else',
            quote: 'Real estate investor in Philadelphia', // no name, no address
          },
        ],
      },
      lead(),
      1,
      RENTALS,
    )
    expect(r.phone).toBeUndefined()
    expect(r.linkedin_url).toBeUndefined()
    expect(r.confidence).toBe(1)
  })
})

describe('claude_research provider', () => {
  it('is configured only with ANTHROPIC_API_KEY and applies when there is a name or company', () => {
    const p = createClaudeResearchProvider()
    expect(p.isConfigured(testEnv())).toBe(false)
    expect(p.isConfigured(testEnv({ ANTHROPIC_API_KEY: 'k' }))).toBe(true)
    expect(p.applies(makeLead(), ctx())).toBe(false)
    expect(p.applies(makeLead({ company: 'X LLC' }), ctx())).toBe(true)
  })

  it('parses a structured result', async () => {
    const { factory, seen } = fakeFactory([{ stop_reason: 'end_turn', parsed_output: found }])
    const p = createClaudeResearchProvider({ clientFactory: factory })
    const properties = [{ address: '1022 PINE ST' }] as EnrichContext['properties']
    const r = await p.enrich(makeLead({ company: 'Torres Property Group LLC' }), {
      ...ctx(),
      properties,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.output_config?.effort).toBe('high')
    // The rental addresses go into the prompt and tie the listing phone to this owner.
    expect(JSON.stringify(seen[0]?.messages)).toContain('1022 PINE ST')
    expect(r.phone).toBe('2155550199')
    expect(r.credits_used).toBe(1)
  })

  it('returns an empty result on refusal, without throwing', async () => {
    const logged: string[] = []
    const { factory } = fakeFactory([{ stop_reason: 'refusal', parsed_output: null }])
    const p = createClaudeResearchProvider({ clientFactory: factory })
    const r = await p.enrich(
      makeLead({ company: 'X LLC' }),
      makeContext({
        env: testEnv({ ANTHROPIC_API_KEY: 'k' }),
        log: async (_l, event) => void logged.push(event),
      }),
    )
    expect(r.confidence).toBe(0)
    expect(r.email).toBeUndefined()
    expect(r.raw).toEqual({ stop_reason: 'refusal' })
    expect(logged).toContain('enrich.research_refused')
  })

  it('resumes a pause_turn by sending the assistant turn back', async () => {
    const paused: Partial<ResearchMessage> = {
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: 'searching...', citations: null }],
      parsed_output: null,
    }
    const { factory, seen } = fakeFactory([
      paused,
      { stop_reason: 'end_turn', parsed_output: found },
    ])
    const p = createClaudeResearchProvider({ clientFactory: factory })
    const r = await p.enrich(makeLead({ company: 'X LLC' }), ctx())
    expect(seen).toHaveLength(2)
    expect(seen[1]?.messages).toHaveLength(2)
    expect(seen[1]?.messages[1]?.role).toBe('assistant')
    expect(r.full_name).toBe('Ray Torres')
    expect(r.credits_used).toBe(2)
  })

  it('gives up after too many pauses and on max_tokens', async () => {
    const pausedForever = fakeFactory([{ stop_reason: 'pause_turn', parsed_output: null }])
    const p1 = createClaudeResearchProvider({ clientFactory: pausedForever.factory })
    const r1 = await p1.enrich(makeLead({ company: 'X LLC' }), ctx())
    expect(pausedForever.seen).toHaveLength(8)
    expect(r1.confidence).toBe(0)

    const truncated = fakeFactory([{ stop_reason: 'max_tokens', parsed_output: null }])
    const p2 = createClaudeResearchProvider({ clientFactory: truncated.factory })
    const r2 = await p2.enrich(makeLead({ company: 'X LLC' }), ctx())
    expect(r2.raw).toEqual({ stop_reason: 'max_tokens' })
  })

  it('a client error (429/500/timeout) surfaces as a plain rejection for the orchestrator', async () => {
    const factory: ResearchClientFactory = () => ({
      parse: async () => {
        throw new Error('429 rate limited')
      },
    })
    const p = createClaudeResearchProvider({ clientFactory: factory })
    await expect(p.enrich(makeLead({ company: 'X LLC' }), ctx())).rejects.toThrow(/429/)
  })
})

describe('researchLinks', () => {
  it('builds OpenCorporates searches for the LLC and the person', () => {
    expect(
      researchLinks({
        company: 'Third Few Units LLC',
        full_name: 'Jonathan Potter',
        last_name: 'Potter',
      }),
    ).toEqual([
      'https://opencorporates.com/companies/us_pa?q=Third%20Few%20Units%20LLC',
      'https://opencorporates.com/officers?q=Jonathan%20Potter&jurisdiction_code=us_pa',
      'https://elementix.com/investors/pa/jonathan-potter',
    ])
    expect(researchLinks({ company: null, full_name: 'Acme LLC', last_name: null })).toEqual([])
  })

  it('puts the links into the prompt', () => {
    const prompt = buildResearchPrompt(makeLead({ company: 'Glox LLC', owner_kind: 'llc' }))
    expect(prompt).toContain('https://opencorporates.com/companies/us_pa?q=Glox%20LLC')
  })
})
