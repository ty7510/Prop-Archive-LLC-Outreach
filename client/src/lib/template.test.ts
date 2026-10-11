import { describe, expect, it } from 'vitest'
import { insertAt, renderTemplate, varsUsed } from './template.ts'

describe('renderTemplate', () => {
  it('fills known variables and tolerates spaces inside the braces', () => {
    const r = renderTemplate('Hi {{first_name}}, you have {{ property_count }} places.', {
      first_name: 'Maya',
      property_count: '4',
    })
    expect(r.text).toBe('Hi Maya, you have 4 places.')
    expect(r.missing).toEqual([])
  })
  it('renders unknown variables empty and reports them once', () => {
    const r = renderTemplate('{{nope}} and {{nope}} and {{first_name}}', { first_name: 'Ray' })
    expect(r.text).toBe(' and  and Ray')
    expect(r.missing).toEqual(['nope'])
  })
  it('uses the sample lead by default', () => {
    expect(renderTemplate('{{sender_name}}').text).toBe('Theo at Prop Archive')
  })
})

describe('varsUsed', () => {
  it('lists each variable once in order', () => {
    expect(varsUsed('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
    expect(varsUsed('plain text')).toEqual([])
  })
})

describe('insertAt', () => {
  it('inserts at the caret and replaces a selection', () => {
    expect(insertAt('Hello world', '{{x}}', 6)).toEqual({ text: 'Hello {{x}}world', caret: 11 })
    expect(insertAt('Hello world', 'there', 6, 11)).toEqual({ text: 'Hello there', caret: 11 })
  })
  it('clamps out of range positions', () => {
    expect(insertAt('ab', 'Z', 99)).toEqual({ text: 'abZ', caret: 3 })
    expect(insertAt('ab', 'Z', -5)).toEqual({ text: 'Zab', caret: 1 })
  })
})
