import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { enrollments, events, leads, suppression } from '../db/schema.ts'
import { HttpError } from '../lib/http.ts'
import { enrollEligible, enrollLead, pickChannels, stopStatusFor } from './enroll.ts'
import { addSuppression, suppressionHits } from './suppression.ts'
import { insertLead, insertSequence, setSettings, setup } from './testFixtures.ts'
import { resolveRedirect, unsubscribeByToken, withUtm } from './tracking.ts'
import { DEFAULT_SETTINGS } from '../../shared/settings.ts'

describe('enrollLead', () => {
  it('creates an active enrollment due now and marks the lead enrolled', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    expect(await enrollLead(deps, lead.id, sequence.id)).toBe(true)
    const [enr] = await db.select().from(enrollments)
    expect(enr).toMatchObject({
      lead_id: lead.id,
      sequence_id: sequence.id,
      status: 'active',
      current_step: 0,
      next_send_at: deps.now().toISOString(),
    })
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.status).toBe('enrolled')
    const evs = await db.select().from(events)
    expect(evs.map((e) => e.kind)).toEqual(['enrolled'])
  })

  it('refuses a second active enrollment in the same sequence', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    await enrollLead(deps, lead.id, sequence.id)
    await expect(enrollLead(deps, lead.id, sequence.id)).rejects.toMatchObject({ status: 409 })
  })

  it('refuses do_not_contact, suppressed, unsubscribed and bounced leads, and inactive sequences', async () => {
    const { db, deps } = await setup()
    const { sequence } = await insertSequence(db)
    const off = await insertSequence(db, { active: false, name: 'Off' })

    const dnc = await insertLead(db, { do_not_contact: true })
    await expect(enrollLead(deps, dnc.id, sequence.id)).rejects.toMatchObject({
      code: 'LEAD_BLOCKED',
    })

    const sup = await insertLead(db)
    await addSuppression(db, 'email', sup.email, 'test')
    await expect(enrollLead(deps, sup.id, sequence.id)).rejects.toMatchObject({
      code: 'LEAD_BLOCKED',
    })

    const unsub = await insertLead(db, { status: 'unsubscribed' })
    await expect(enrollLead(deps, unsub.id, sequence.id)).rejects.toMatchObject({
      code: 'LEAD_BLOCKED',
    })

    const bounced = await insertLead(db, { status: 'bounced' })
    await expect(enrollLead(deps, bounced.id, sequence.id)).rejects.toMatchObject({
      code: 'LEAD_BLOCKED',
    })

    const fine = await insertLead(db)
    await expect(enrollLead(deps, fine.id, off.sequence.id)).rejects.toMatchObject({
      code: 'SEQUENCE_INACTIVE',
    })

    await expect(enrollLead(deps, 'nope', sequence.id)).rejects.toBeInstanceOf(HttpError)
    await expect(enrollLead(deps, fine.id, 'nope')).rejects.toMatchObject({ status: 404 })
  })

  it('a human may re-enrol a lead who replied; the autopilot (quiet) may not', async () => {
    const { db, deps } = await setup()
    const { sequence } = await insertSequence(db)
    const lead = await insertLead(db, { status: 'replied' })
    expect(await enrollLead(deps, lead.id, sequence.id, { quiet: true })).toBe(false)
    expect(await enrollLead(deps, lead.id, sequence.id)).toBe(true)
  })

  it('maps stop reasons to enrollment statuses', () => {
    expect(stopStatusFor('replied')).toBe('stopped_replied')
    expect(stopStatusFor('unsubscribed')).toBe('stopped_unsubscribed')
    expect(stopStatusFor('bounce')).toBe('stopped_bounced')
    expect(stopStatusFor('manual')).toBe('stopped_manual')
    expect(stopStatusFor('do_not_contact')).toBe('stopped_manual')
  })
})

describe('pickChannels', () => {
  it('email first, mail only when there is no email, human channels alongside', () => {
    const base = {
      ...DEFAULT_SETTINGS,
      channels: { email: true, mail: true, linkedin: true, instagram: true, call: true },
    }
    const lead = {
      email: 'a@b.co',
      mailing_street: '1 St',
      channels: { email: true, mail: true, linkedin: true, instagram: false, call: true },
    } as Parameters<typeof pickChannels>[0]
    expect(pickChannels(lead, base)).toEqual(['email', 'linkedin', 'call'])
    const noEmail = { ...lead, email: null, channels: { ...lead.channels, email: false } }
    expect(pickChannels(noEmail, base)).toEqual(['mail', 'linkedin', 'call'])
    const mailOff = { ...base, channels: { ...base.channels, mail: false } }
    expect(pickChannels(noEmail, mailOff)).toEqual(['linkedin', 'call'])
  })
})

describe('enrollEligible', () => {
  it('enrols enriched leads by persona and channel, offsetting human channels by a day', async () => {
    const { db, deps } = await setup()
    const email = await insertSequence(db, { name: 'Ray email', persona: 'ray' })
    const li = await insertSequence(db, { name: 'Ray LI', channel: 'linkedin', persona: 'ray' }, [
      { delay_days: 0, body: 'x' },
    ])
    const mail = await insertSequence(db, { name: 'Ray mail', channel: 'mail', persona: 'ray' }, [
      { delay_days: 0, body: 'x' },
    ])
    await setSettings(db, {
      channels: { mail: true },
      sequence_by_persona: {
        ray: { email: email.sequence.id, linkedin: li.sequence.id, mail: mail.sequence.id },
      },
    })

    const ray = await insertLead(db) // email + linkedin
    const noEmail = await insertLead(db, {
      email: null,
      channels: { email: false, mail: true, linkedin: false, instagram: false, call: true },
    })
    await insertLead(db, { persona: 'maya' }) // no sequences for maya
    await insertLead(db, { icp_score: 10 }) // below min score
    await insertLead(db, { status: 'new' }) // not enriched yet
    await insertLead(db, { do_not_contact: true })
    const already = await insertLead(db)
    await enrollLead(deps, already.id, email.sequence.id)

    const r = await enrollEligible(deps)
    expect(r.enrolled).toBe(2)
    const rows = await db.select().from(enrollments)
    const byLead = (id: string) =>
      rows.filter((e) => e.lead_id === id).map((e) => [e.sequence_id, e.next_send_at])
    expect(byLead(ray.id).sort()).toEqual(
      [
        [email.sequence.id, '2026-10-13T14:00:00.000Z'],
        [li.sequence.id, '2026-10-14T14:00:00.000Z'],
      ].sort(),
    )
    expect(byLead(noEmail.id)).toEqual([[mail.sequence.id, '2026-10-13T14:00:00.000Z']])
    expect(rows).toHaveLength(4) // 2 + 1 + the one made by hand

    // Running again enrols nobody new.
    expect((await enrollEligible(deps)).enrolled).toBe(0)
  })

  it('leaves a lead alone until research has looked for its email and profiles', async () => {
    const { db, deps: base } = await setup()
    const deps = { ...base, env: { ...base.env, ANTHROPIC_API_KEY: 'sk-test' } }
    const email = await insertSequence(db, { name: 'Ray email', persona: 'ray' })
    await setSettings(db, { sequence_by_persona: { ray: { email: email.sequence.id } } })
    const waiting = await insertLead(db, { enrichment: {} })
    const researched = await insertLead(db, {
      enrichment: { claude_research: { fetched_at: '2026-10-13T12:00:00.000Z', data: null } },
    })
    expect((await enrollEligible(deps)).enrolled).toBe(1)
    const rows = await db.select().from(enrollments)
    expect(rows.map((e) => e.lead_id)).toEqual([researched.id])
    expect(rows.some((e) => e.lead_id === waiting.id)).toBe(false)
  })
})

describe('unsubscribe and suppression', () => {
  it('unsubscribe adds an email suppression, stops enrollments and marks the lead', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db)
    const { sequence } = await insertSequence(db)
    const li = await insertSequence(db, { channel: 'linkedin', name: 'LI' }, [
      { delay_days: 0, body: 'x' },
    ])
    await enrollLead(deps, lead.id, sequence.id)
    await enrollLead(deps, lead.id, li.sequence.id)

    expect(await unsubscribeByToken(deps, lead.unsubscribe_token)).toBe(true)
    const sups = await db.select().from(suppression)
    expect(sups).toHaveLength(1)
    expect(sups[0]).toMatchObject({ kind: 'email', value: lead.email })
    const enrs = await db.select().from(enrollments)
    expect(enrs.every((e) => e.status === 'stopped_unsubscribed')).toBe(true)
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.id))
    expect(l!.status).toBe('unsubscribed')
    expect((await db.select().from(events)).some((e) => e.kind === 'unsubscribe')).toBe(true)

    // Idempotent and quiet the second time.
    expect(await unsubscribeByToken(deps, lead.unsubscribe_token)).toBe(true)
    expect(await db.select().from(suppression)).toHaveLength(1)
    expect(await unsubscribeByToken(deps, 'unknown')).toBe(false)

    // The lead can no longer be enrolled.
    await expect(enrollLead(deps, lead.id, sequence.id)).rejects.toMatchObject({
      code: 'LEAD_BLOCKED',
    })
  })

  it('suppressionHits matches email, domain, phone and address', async () => {
    const { db } = await setup()
    await addSuppression(db, 'domain', 'Blocked.com', 'test')
    await addSuppression(db, 'phone', '(215) 555-0199', 'test')
    await addSuppression(db, 'address', '1234 n. broad street|19121', 'test')
    expect(
      await suppressionHits(db, {
        email: 'x@blocked.com',
        phone: null,
        mailing_street: null,
        mailing_zip: null,
      }),
    ).toEqual(['domain'])
    expect(
      await suppressionHits(db, {
        email: null,
        phone: '12155550199',
        mailing_street: null,
        mailing_zip: null,
      }),
    ).toEqual(['phone'])
    expect(
      await suppressionHits(db, {
        email: null,
        phone: null,
        mailing_street: '1234 N Broad St',
        mailing_zip: '19121-0001',
      }),
    ).toEqual(['address'])
    expect(
      await suppressionHits(db, {
        email: 'ok@fine.com',
        phone: '2150000000',
        mailing_street: '9 Other',
        mailing_zip: '19104',
      }),
    ).toEqual([])
    expect(await addSuppression(db, 'domain', 'blocked.com', 'again')).toBe(false)
  })
})

describe('tracked redirect', () => {
  it('appends utm tags and records a click', async () => {
    const { db, deps } = await setup()
    const lead = await insertLead(db)
    const r = await resolveRedirect(deps, {
      token: lead.unsubscribe_token,
      dest: 'demo',
      channel: 'email',
      sequence: 'Ray Email A',
    })
    expect(r?.tracked).toBe(true)
    const url = new URL(r!.url)
    expect(url.origin + url.pathname).toBe('https://proparchive.app/demo')
    expect(url.searchParams.get('utm_source')).toBe('outreach')
    expect(url.searchParams.get('utm_medium')).toBe('email')
    expect(url.searchParams.get('utm_campaign')).toBe('ray-email-a')
    expect(url.searchParams.get('ref')).toBe(lead.id)
    const evs = await db.select().from(events)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'click', lead_id: lead.id })
  })

  it('unknown token still redirects, without a ref, and unknown dest is null', async () => {
    const { deps } = await setup()
    const r = await resolveRedirect(deps, { token: 'nope', dest: 'beta' })
    expect(r?.tracked).toBe(false)
    expect(r?.url.startsWith('https://proparchive.app/?beta=1&')).toBe(true)
    expect(new URL(r!.url).searchParams.get('ref')).toBeNull()
    expect(await resolveRedirect(deps, { token: 'nope', dest: 'elsewhere' })).toBeNull()
  })

  it('withUtm keeps existing query params', () => {
    const u = new URL(
      withUtm('https://x.test/?join=beta', { channel: 'mail', sequence: 's', leadId: 'L' }),
    )
    expect(u.searchParams.get('join')).toBe('beta')
    expect(u.searchParams.get('utm_medium')).toBe('mail')
  })
})
