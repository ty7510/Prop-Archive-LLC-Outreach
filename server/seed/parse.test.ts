import { describe, expect, it } from 'vitest'
import { findVariables, parseSequenceMarkdown, SequenceParseError } from './parse.ts'

const GOOD = `---
name: Email, Maya, no trigger
channel: email
persona: maya
trigger: none
description: Three emails.
---

## Step 1
delay_days: 0
subject: Repair texts during your work day?

Hi {{first_name}},

{{ai_opener}}
Pain first. Then the fix.

Worth a 15 minute look? {{demo_link}}

## Step 2
delay_days: 3
subject: Tax time with no records
notes: angle shifts to records

Second angle. Join here: {{beta_link}}

## Step 3
delay_days: 8
subject: I'll stop here

Last one. {{site_link}}
`

describe('parseSequenceMarkdown', () => {
  it('parses front matter, steps, meta lines and bodies', () => {
    const seq = parseSequenceMarkdown(GOOD)
    expect(seq.name).toBe('Email, Maya, no trigger')
    expect(seq.channel).toBe('email')
    expect(seq.persona).toBe('maya')
    expect(seq.description).toBe('Three emails.')
    expect(seq.steps).toHaveLength(3)
    expect(seq.steps.map((s) => s.step_index)).toEqual([0, 1, 2])
    expect(seq.steps.map((s) => s.delay_days)).toEqual([0, 3, 8])
    expect(seq.steps[0]?.subject).toBe('Repair texts during your work day?')
    expect(seq.steps[0]?.body.startsWith('Hi {{first_name}},\n\n{{ai_opener}}\nPain first.')).toBe(
      true,
    )
    expect(seq.steps[0]?.body.endsWith('{{demo_link}}')).toBe(true)
    expect(seq.steps[0]?.notes).toBeNull()
    expect(seq.steps[1]?.notes).toBe('angle shifts to records')
    expect(seq.steps[1]?.body).toBe('Second angle. Join here: {{beta_link}}')
    expect(seq.steps[2]?.body).toBe('Last one. {{site_link}}')
  })

  it('stores the "none" trigger as "any" and accepts "any" too', () => {
    expect(parseSequenceMarkdown(GOOD).trigger).toBe('any')
    expect(parseSequenceMarkdown(GOOD.replace('trigger: none', 'trigger: any')).trigger).toBe('any')
    expect(
      parseSequenceMarkdown(GOOD.replace('trigger: none', 'trigger: new_license')).trigger,
    ).toBe('new_license')
    expect(
      parseSequenceMarkdown(GOOD.replace('trigger: none', 'trigger: recent_sale')).trigger,
    ).toBe('recent_sale')
  })

  it('handles Windows line endings', () => {
    const seq = parseSequenceMarkdown(GOOD.replace(/\n/g, '\r\n'))
    expect(seq.steps).toHaveLength(3)
    expect(seq.steps[1]?.body).toBe('Second angle. Join here: {{beta_link}}')
  })

  it('leaves subject null when a step has none', () => {
    const text = `---
name: Postcard
channel: mail
persona: ray
trigger: none
---

## Step 1
delay_days: 0

Short note. {{demo_link}}
`
    const seq = parseSequenceMarkdown(text)
    expect(seq.steps[0]?.subject).toBeNull()
    expect(seq.description).toBeNull()
  })

  it('keeps colons inside the body as body text', () => {
    const text = `---
name: Call
channel: call
persona: denise
trigger: none
---

## Step 1
delay_days: 0

10 second open
"Hi {{first_name}}, this is {{sender_name}}. Two things: texts and dates."
subject: this is body text, not a subject
`
    const seq = parseSequenceMarkdown(text)
    expect(seq.steps[0]?.subject).toBeNull()
    expect(seq.steps[0]?.body).toContain('subject: this is body text')
  })

  it('rejects a file without front matter', () => {
    expect(() => parseSequenceMarkdown('## Step 1\ndelay_days: 0\n\nbody')).toThrow(
      SequenceParseError,
    )
  })

  it('rejects bad enum values with a plain message', () => {
    expect(() => parseSequenceMarkdown(GOOD.replace('channel: email', 'channel: fax'))).toThrow(
      /channel must be one of/,
    )
    expect(() => parseSequenceMarkdown(GOOD.replace('persona: maya', 'persona: bob'))).toThrow(
      /persona must be one of/,
    )
    expect(() => parseSequenceMarkdown(GOOD.replace('trigger: none', 'trigger: csv'))).toThrow(
      /trigger must be one of/,
    )
  })

  it('rejects an unknown front matter key and a missing name', () => {
    expect(() => parseSequenceMarkdown(GOOD.replace('description:', 'colour:'))).toThrow(
      /unknown front matter key/,
    )
    expect(() => parseSequenceMarkdown(GOOD.replace(/name: .*\n/, 'name:\n'))).toThrow(
      /needs a name/,
    )
  })

  it('rejects steps out of order, a missing delay and an empty body', () => {
    expect(() => parseSequenceMarkdown(GOOD.replace('## Step 2', '## Step 3'))).toThrow(
      /numbered 1, 2, 3/,
    )
    expect(() => parseSequenceMarkdown(GOOD.replace('delay_days: 3\n', ''))).toThrow(
      /delay_days is required/,
    )
    expect(() => parseSequenceMarkdown(GOOD.replace('delay_days: 3', 'delay_days: three'))).toThrow(
      /whole number/,
    )
    expect(() => parseSequenceMarkdown(GOOD.replace('Last one. {{site_link}}\n', ''))).toThrow(
      /body is empty/,
    )
  })

  it('rejects text between the front matter and the first step', () => {
    expect(() =>
      parseSequenceMarkdown(GOOD.replace('---\n\n## Step 1', '---\nstray\n## Step 1')),
    ).toThrow(/before the first/)
  })

  it('rejects a file with no steps', () => {
    expect(() => parseSequenceMarkdown(GOOD.slice(0, GOOD.indexOf('## Step 1')))).toThrow(
      /no "## Step 1"/,
    )
  })
})

describe('findVariables', () => {
  it('lists every variable with repeats, ignoring spaces inside the braces', () => {
    expect(findVariables('Hi {{first_name}}, {{ demo_link }} and {{first_name}}')).toEqual([
      'first_name',
      'demo_link',
      'first_name',
    ])
    expect(findVariables('no vars here')).toEqual([])
  })
})
