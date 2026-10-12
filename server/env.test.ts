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

describe('the workspace secret', () => {
  it('uses a workspace ID as the header with the organization key', () => {
    const e = parseEnv({ CLAUDE_API_KEY: 'sk-ant-org', WORK_SPACE_CLAUDE: 'wrkspc_123' })
    expect(e.ANTHROPIC_API_KEY).toBe('sk-ant-org')
    expect(e.ANTHROPIC_WORKSPACE_ID).toBe('wrkspc_123')
  })

  it('uses a workspace-scoped key as the key, with no workspace header', () => {
    const e = parseEnv({ CLAUDE_API_KEY: 'sk-ant-org', WORK_SPACE_CLAUDE: 'sk-ant-workspace' })
    expect(e.ANTHROPIC_API_KEY).toBe('sk-ant-workspace')
    expect(e.ANTHROPIC_WORKSPACE_ID).toBeUndefined()
  })

  it('reads Claude_Workspace_ID too', () => {
    const e = parseEnv({ CLAUDE_API_KEY: 'sk-ant-org', Claude_Workspace_ID: 'wrkspc_9' })
    expect(e.ANTHROPIC_WORKSPACE_ID).toBe('wrkspc_9')
  })
})
