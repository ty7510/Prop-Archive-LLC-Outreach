import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SECRET_MASK, type SendingInbox } from '../../shared/settings.ts'
import { inboxProvider, maskSettings, pickInbox, restoreInboxSecrets } from './inboxes.ts'

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
