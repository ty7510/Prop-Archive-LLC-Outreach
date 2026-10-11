import { describe, expect, it } from 'vitest'
import { makeContext, makeLead, testEnv } from '../testing.ts'
import {
  buildResearchParams,
  buildResearchPrompt,
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

const found: ResearchResult = {
  full_name: 'Ray Torres',
  company: 'Torres Property Group LLC',
  website: 'https://torrespg.com',
  linkedin_url: 'https://www.linkedin.com/in/raytorres',
  instagram_url: null,
  business_email: 'ray@torrespg.com',
  business_phone: '(215) 555-0199',
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

  it('uses the spec shape: model, effort low, json schema format, web search with max_uses 5', () => {
    const params = buildResearchParams('hello')
    expect(params.model).toBe(RESEARCH_MODEL)
    expect(params.model).toBe('claude-opus-5-5')
    expect(params.max_tokens).toBe(RESEARCH_MAX_TOKENS)
    expect(params.output_config?.effort).toBe('low')
    expect(params.output_config?.format?.type).toBe('json_schema')
    const schema = params.output_config?.format?.schema as Record<string, unknown>
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      [
        'business_email',
        'business_phone',
        'company',
        'confidence',
        'full_name',
        'instagram_url',
        'linkedin_url',
        'sources',
        'website',
      ].sort(),
    )
    expect(params.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }])
    expect(params.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(ResearchSchema.safeParse(found).success).toBe(true)
  })
})

describe('mapResearchResult', () => {
  it('maps fields; email is unverified, phone type unknown', () => {
    const r = mapResearchResult(found, makeLead({ owner_kind: 'llc' }), 1)
    expect(r).toMatchObject({
      full_name: 'Ray Torres',
      owner_kind: 'person',
      company: 'Torres Property Group LLC',
      website: 'https://torrespg.com',
      linkedin_url: 'https://www.linkedin.com/in/raytorres',
      email: 'ray@torrespg.com',
      email_status: 'unknown',
      phone: '(215) 555-0199',
      phone_type: 'unknown',
      confidence: 0.8,
      credits_used: 1,
    })
    expect(r.instagram_url).toBeUndefined()
  })

  it('drops profile links that are not on the right site and clamps confidence', () => {
    const r = mapResearchResult(
      { ...found, linkedin_url: 'https://example.com/ray', confidence: 7 },
      makeLead(),
      1,
    )
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
    const r = await p.enrich(makeLead({ company: 'Torres Property Group LLC' }), ctx())
    expect(seen).toHaveLength(1)
    expect(seen[0]?.output_config?.effort).toBe('low')
    expect(r.email).toBe('ray@torrespg.com')
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
    expect(pausedForever.seen).toHaveLength(3)
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
