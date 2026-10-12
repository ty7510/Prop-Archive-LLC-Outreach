import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.ts'

describe('parseEnv', () => {
  it("accepts Prop Archive's Claude secret names", () => {
    const e = parseEnv({ Claude_API: 'k1', Claude_Workspace_ID: 'w1' })
    expect(e.ANTHROPIC_API_KEY).toBe('k1')
    expect(e.ANTHROPIC_WORKSPACE_ID).toBe('w1')
  })

  it('prefers ANTHROPIC_API_KEY and ignores blank values', () => {
    const e = parseEnv({ ANTHROPIC_API_KEY: ' ', Claude_API: 'k2', CLAUDE_API_KEY: 'k3' })
    expect(e.ANTHROPIC_API_KEY).toBe('k2')
    expect(parseEnv({ ANTHROPIC_API_KEY: 'a', Claude_API: 'b' }).ANTHROPIC_API_KEY).toBe('a')
    expect(parseEnv({}).ANTHROPIC_API_KEY).toBeUndefined()
  })
})
