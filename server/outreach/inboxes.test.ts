import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SECRET_MASK, type SendingInbox } from '../../shared/settings.ts'
import { SendingInboxSchema } from '../../shared/settings.ts'
import { testDeps } from './deps.ts'
import {
  inboxProvider,
  isPrivateAddress,
  ipv6Groups,
  maskSettings,
  pickInbox,
  resolveMailHost,
  restoreInboxSecrets,
} from './inboxes.ts'

function inbox(email: string, patch: Partial<SendingInbox> = {}): SendingInbox {
  return {
    id: email,
    from_name: '',
    email,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_user: email,
    smtp_pass: 'secret',
    imap_host: '',
    imap_port: 993,
    daily_limit: 2,
    active: true,
    ...patch,
  }
}

describe('pickInbox', () => {
  it('picks the usable inbox with the fewest sends today, under its limit', () => {
    const a = inbox('a@x.com')
    const b = inbox('b@x.com')
    const counts = new Map([[inboxProvider(a), 1]])
    expect(pickInbox([a, b], counts)?.email).toBe('b@x.com')
    counts.set(inboxProvider(b), 2)
    expect(pickInbox([a, b], counts)?.email).toBe('a@x.com')
    counts.set(inboxProvider(a), 2)
    expect(pickInbox([a, b], counts)).toBeNull()
  })

  it('skips paused inboxes and inboxes without a password or server', () => {
    const counts = new Map<string, number>()
    expect(
      pickInbox(
        [
          inbox('off@x.com', { active: false }),
          inbox('nopass@x.com', { smtp_pass: '' }),
          inbox('nohost@x.com', { smtp_host: '' }),
        ],
        counts,
      ),
    ).toBeNull()
  })
})

describe('inbox passwords in the settings API', () => {
  it('never shows a stored password', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      sending_inboxes: [inbox('a@x.com'), inbox('b@x.com', { smtp_pass: '' })],
    }
    const shown = maskSettings(settings)
    expect(shown.sending_inboxes.map((i) => i.smtp_pass)).toEqual([SECRET_MASK, ''])
    expect(settings.sending_inboxes[0]!.smtp_pass).toBe('secret') // the stored copy is untouched
  })

  it('keeps the stored password for a masked or blank one, replaces it otherwise', () => {
    const current = [inbox('a@x.com'), inbox('b@x.com')]
    const incoming = [
      { ...inbox('a@x.com'), smtp_pass: SECRET_MASK },
      { ...inbox('b@x.com'), smtp_pass: 'new-one' },
      { ...inbox('c@x.com'), smtp_pass: '' },
    ]
    const restored = restoreInboxSecrets(current, incoming) as SendingInbox[]
    expect(restored.map((i) => i.smtp_pass)).toEqual(['secret', 'new-one', ''])
  })
})

describe('a stored password only goes where it was meant to', () => {
  it('drops the stored password when a masked inbox comes back with another server or login', () => {
    const current = [inbox('a@x.com')]
    for (const change of [
      { smtp_host: 'smtp.evil-example.com' },
      { smtp_port: 587 },
      { smtp_user: 'someone@x.com' },
      { imap_host: 'imap.evil-example.com' },
    ]) {
      const [restored] = restoreInboxSecrets(current, [
        { ...inbox('a@x.com'), ...change, smtp_pass: SECRET_MASK },
      ]) as SendingInbox[]
      expect(restored!.smtp_pass, JSON.stringify(change)).toBe('')
    }
  })

  it('only accepts public mail server names on mail ports', () => {
    const base = { id: 'x', email: 'a@x.com' }
    for (const smtp_host of ['localhost', '127.0.0.1', '10.0.0.5', 'mail.corp', 'nodot']) {
      expect(SendingInboxSchema.safeParse({ ...base, smtp_host }).success, smtp_host).toBe(false)
    }
    expect(SendingInboxSchema.safeParse({ ...base, smtp_host: 'smtp.gmail.com' }).success).toBe(
      true,
    )
    expect(SendingInboxSchema.safeParse({ ...base, smtp_port: 22 }).success).toBe(false)
    expect(SendingInboxSchema.safeParse({ ...base, imap_port: 6379 }).success).toBe(false)
  })

  it('refuses a server name that resolves to a private address, and pins a public one', async () => {
    const deps = (addresses: string[] | Error) =>
      ({
        ...testDeps(null as never),
        lookupHost: async () => {
          if (addresses instanceof Error) throw addresses
          return addresses
        },
      }) as ReturnType<typeof testDeps>
    expect(await resolveMailHost(deps(['10.1.2.3']), 'smtp.example.com')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/private/),
    })
    // One private answer among public ones is enough to refuse.
    expect((await resolveMailHost(deps(['142.250.1.108', '::1']), 'smtp.example.com')).ok).toBe(
      false,
    )
    expect(await resolveMailHost(deps(new Error('ENOTFOUND')), 'smtp.nope.com')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/not found/),
    })
    expect(await resolveMailHost(deps(['142.250.1.108']), 'smtp.gmail.com')).toEqual({
      ok: true,
      address: '142.250.1.108',
    })
    expect((await resolveMailHost(deps(['142.250.1.108']), '10.0.0.1')).ok).toBe(false)
    // IPv6 first in the answer: still connect over IPv4 (Replit cannot reach IPv6).
    expect(
      await resolveMailHost(deps(['2607:f8b0:4002:c06::6d', '142.250.9.109']), 'smtp.gmail.com'),
    ).toEqual({ ok: true, address: '142.250.9.109' })
  })

  it('blocks every address that is not the public internet, in any spelling', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '198.18.0.1',
      '192.0.2.1',
      '203.0.113.7',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fd00::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1', // loopback written in hex inside IPv6
      '::127.0.0.1',
      '64:ff9b::a00:1', // NAT64 of 10.0.0.1
      '2002:a00:1::1', // 6to4 of 10.0.0.1
      '2001:0:4136:e378::1', // Teredo
      '2001:db8::1',
      'not-an-ip',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '142.250.1.108', '2607:f8b0:4004:c1b::6c', '2a00:1450::5']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it('parses IPv6 in its compressed and dotted forms', () => {
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(ipv6Groups('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1])
    expect(ipv6Groups('2607:f8b0::6c')).toEqual([0x2607, 0xf8b0, 0, 0, 0, 0, 0, 0x6c])
    expect(ipv6Groups('1::2::3')).toBeNull()
    expect(ipv6Groups('12345::1')).toBeNull()
  })
})

describe('the Claude key check', () => {
  it('names the fix when Claude refuses an organization key, and remembers the answer', async () => {
    const { claudeKeyCheck, resetClaudeCheck } = await import('./readiness.ts')
    resetClaudeCheck()
    let calls = 0
    const deps = {
      ...testDeps(null as never),
      env: { ...testDeps(null as never).env, ANTHROPIC_API_KEY: 'sk-test' },
      llm: {
        text: async () => {
          calls++
          throw new Error(
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}',
          )
        },
        structured: async () => null,
      },
    } as ReturnType<typeof testDeps>
    const first = await claudeKeyCheck(deps)
    expect(first.ok).toBe(false)
    expect(first.fix).toMatch(/organization key/)
    expect(first.fix).toMatch(/workspace/)
    await claudeKeyCheck(deps)
    expect(calls).toBe(1) // cached for 30 minutes
    resetClaudeCheck()
  })

  it('says how to add the key when there is none', async () => {
    const { claudeKeyCheck, resetClaudeCheck } = await import('./readiness.ts')
    resetClaudeCheck()
    const r = await claudeKeyCheck({ ...testDeps(null as never), llm: null })
    expect(r).toMatchObject({ ok: false, fix: expect.stringMatching(/CLAUDE_API_KEY/) })
  })
})
