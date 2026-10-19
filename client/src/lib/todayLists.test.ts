import { describe, expect, it } from 'vitest'
import type { TodoPerson, TodoStep } from '@shared/types'
import { isTodayTab, todayLists } from './todayLists.ts'

function step(
  message_id: string,
  channel: TodoStep['channel'],
  status: TodoStep['status'] = 'waiting',
): TodoStep {
  return {
    message_id,
    kind: channel === 'linkedin' ? 'linkedin_connect' : channel === 'mail' ? 'postcard' : 'email',
    channel,
    status,
    body: 'words',
    subject: null,
    to_address: null,
    found_by_app: false,
    printout: channel === 'mail',
    problems: [],
  }
}

function person(lead_id: string, steps: TodoStep[], extra: Partial<TodoPerson> = {}): TodoPerson {
  return {
    lead_id,
    person: lead_id,
    company: null,
    property_count: 0,
    city: null,
    phone: null,
    email: null,
    round: 1,
    steps,
    linkedin_missing: null,
    added_at: '2026-10-19T13:00:00.000Z',
    ...extra,
  }
}

describe('todayLists', () => {
  it('puts each waiting step on its own list, in the order people are on the list', () => {
    const a = person('a', [step('a1', 'linkedin'), step('a2', 'mail'), step('a3', 'email')])
    const b = person('b', [step('b1', 'linkedin', 'done'), step('b2', 'mail')])
    const lists = todayLists([a, b])
    expect(lists.linkedin.map((i) => i.step.message_id)).toEqual(['a1'])
    expect(lists.printouts.map((i) => i.step.message_id)).toEqual(['a2', 'b2'])
    expect(lists.emails.map((i) => i.step.message_id)).toEqual(['a3'])
    expect(lists.emails[0]!.person.lead_id).toBe('a')
    expect(lists.noEmail).toBe(1) // b has no email step
  })

  it('a done or skipped step leaves its list', () => {
    const a = person('a', [step('a1', 'linkedin', 'skipped'), step('a2', 'email', 'done')])
    const lists = todayLists([a])
    expect(lists.linkedin).toEqual([])
    expect(lists.emails).toEqual([])
    expect(lists.noEmail).toBe(0) // they had one
  })

  it('lists people the app could not find on LinkedIn who have no note', () => {
    const lost = person('lost', [step('l1', 'mail')], { linkedin_missing: 'not_found' })
    const noName = person('noname', [step('n1', 'mail')], { linkedin_missing: 'no_name' })
    const withNote = person('note', [step('w1', 'linkedin')], { linkedin_missing: 'not_found' })
    expect(todayLists([lost, noName, withNote]).noLinkedIn.map((p) => p.lead_id)).toEqual(['lost'])
  })

  it('knows its tabs', () => {
    expect(isTodayTab('printouts')).toBe(true)
    expect(isTodayTab('calls')).toBe(false)
    expect(isTodayTab(null)).toBe(false)
  })
})
