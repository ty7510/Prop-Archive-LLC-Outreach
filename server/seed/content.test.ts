// Every file in content/sequences must pass these. They are the house rules from docs/COPY.md.
import { beforeAll, describe, expect, it } from 'vitest'
import { PERSONAS } from '../../shared/types.ts'
import { hasEmDash } from '../lib/text.ts'
import { loadSequenceFiles, type SequenceFile } from './content.ts'
import { findVariables, TEMPLATE_VARS, type ParsedStep } from './parse.ts'

const TRIGGERS = ['new_license', 'recent_sale', 'any'] as const
const CHANNELS = ['email', 'mail', 'linkedin', 'call'] as const

/** Words with each {{variable}} counted as one word. */
function wordCount(text: string): number {
  return text
    .replace(/\{\{\s*\w+\s*\}\}/g, 'X')
    .split(/\s+/)
    .filter(Boolean).length
}

/** The text with variables removed, for word checks. */
function prose(text: string): string {
  return text.replace(/\{\{\s*\w+\s*\}\}/g, ' ')
}

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length
}

const BANNED = [
  /circl(e|ing) back/i,
  /touch(ing)? base/i,
  /hope this (email )?finds you well/i,
  /great question/i,
  /i wanted to reach out/i,
  /quick question/i,
  /i came across your/i,
  /checking in/i,
  /synerg/i,
  /leverage/i,
  /solutions? provider/i,
  /just wanted to/i,
]

/** Lines like "the beta opens with my first close" that tell a stranger the pipeline is empty. */
const EMPTY_PIPELINE_TELLS = [/first (user|customer|close)/i, /pre-?launch/i, /hasn'?t started/i]

/** Vanity metrics never go in cold copy. */
const VANITY = [
  /\$\d/,
  /pitch competition/i,
  /\b\d{3,} leads\b/i,
  /followers/i,
  /we raised|fundrais|raised \$/i,
]

let files: SequenceFile[]
let steps: { file: string; channel: string; step: ParsedStep }[]

beforeAll(async () => {
  files = await loadSequenceFiles()
  steps = files.flatMap((f) =>
    f.parsed.steps.map((step) => ({ file: f.file, channel: f.parsed.channel, step })),
  )
})

describe('content/sequences as a set', () => {
  it('has one file per persona, trigger and channel (3 x 3 x 4 = 36)', () => {
    expect(files).toHaveLength(36)
    const seen = new Set<string>()
    for (const f of files) {
      const key = `${f.parsed.persona}/${f.parsed.trigger}/${f.parsed.channel}`
      expect(seen.has(key), `duplicate ${key} in ${f.file}`).toBe(false)
      seen.add(key)
    }
    for (const persona of PERSONAS) {
      for (const trigger of TRIGGERS) {
        for (const channel of CHANNELS) {
          expect(seen.has(`${persona}/${trigger}/${channel}`)).toBe(true)
        }
      }
    }
  })

  it('has unique names', () => {
    const names = files.map((f) => f.parsed.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has no em-dash anywhere, front matter included', () => {
    for (const f of files) expect(hasEmDash(f.text), f.file).toBe(false)
  })

  it('uses only the variables the renderer knows', () => {
    const allowed = new Set<string>(TEMPLATE_VARS)
    for (const { file, step } of steps) {
      for (const v of findVariables(step.body))
        expect(allowed.has(v), `${file}: {{${v}}}`).toBe(true)
      if (step.subject) {
        for (const v of findVariables(step.subject)) {
          expect(allowed.has(v), `${file} subject: {{${v}}}`).toBe(true)
        }
      }
    }
  })

  it('never writes {{unsubscribe_link}} in a body, the footer adds it', () => {
    for (const { file, step } of steps) {
      expect(step.body.includes('unsubscribe_link'), file).toBe(false)
    }
  })

  it('asks once: demo_link or beta_link at most once per message, never both', () => {
    for (const { file, step } of steps) {
      const vars = findVariables(step.body)
      const asks = vars.filter((v) => v === 'demo_link' || v === 'beta_link').length
      expect(asks, `${file} step ${step.step_index + 1}`).toBeLessThanOrEqual(1)
    }
  })

  it('says the words demo and beta at most once each per message', () => {
    for (const { file, step } of steps) {
      const text = prose(step.body)
      expect(
        count(/\bdemo\b/gi, text),
        `${file} step ${step.step_index + 1} "demo"`,
      ).toBeLessThanOrEqual(1)
      expect(
        count(/\bbeta\b/gi, text),
        `${file} step ${step.step_index + 1} "beta"`,
      ).toBeLessThanOrEqual(1)
    }
  })

  it('has no corporate phrases, vanity metrics or empty-pipeline tells', () => {
    for (const { file, step } of steps) {
      const text = `${step.subject ?? ''}\n${step.body}`
      for (const re of [...BANNED, ...EMPTY_PIPELINE_TELLS, ...VANITY]) {
        expect(re.test(text), `${file} step ${step.step_index + 1} matches ${re}`).toBe(false)
      }
    }
  })

  it('uses {{ai_opener}} only in email step 1', () => {
    for (const { file, channel, step } of steps) {
      const has = findVariables(step.body).includes('ai_opener')
      if (channel === 'email' && step.step_index === 0) {
        expect(has, `${file} step 1 should offer {{ai_opener}}`).toBe(true)
      } else {
        expect(has, `${file} step ${step.step_index + 1} must not use {{ai_opener}}`).toBe(false)
      }
    }
  })

  it('uses {{trigger_line}} only in trigger variants', () => {
    for (const f of files) {
      for (const step of f.parsed.steps) {
        const has = findVariables(step.body).includes('trigger_line')
        if (f.parsed.trigger === 'any') expect(has, f.file).toBe(false)
      }
    }
  })

  it('describes the offer with the exact two facts and no permanent benefit', () => {
    for (const { file, step } of steps) {
      expect(/lifetime|forever|locked[- ]in/i.test(step.body), file).toBe(false)
      if (/two months free/i.test(step.body)) {
        expect(step.body, file).toMatch(
          /free while we're in beta, plus two months free after the public launch/i,
        )
      }
    }
  })

  it('never implies paperwork', () => {
    for (const { file, step } of steps) {
      expect(/\b(contract|NDA|sign the|agreement)\b/i.test(step.body), file).toBe(false)
    }
  })
})

describe('email sequences', () => {
  it('have three steps on day 0, 3 and 8, with subjects under 45 chars and bodies under 120 words', () => {
    for (const f of files.filter((x) => x.parsed.channel === 'email')) {
      expect(
        f.parsed.steps.map((s) => s.delay_days),
        f.file,
      ).toEqual([0, 3, 8])
      for (const s of f.parsed.steps) {
        expect(s.subject, `${f.file} step ${s.step_index + 1} has no subject`).toBeTruthy()
        expect((s.subject ?? '').length, `${f.file} subject "${s.subject}"`).toBeLessThan(45)
        expect(wordCount(s.body), `${f.file} step ${s.step_index + 1} words`).toBeLessThan(120)
        expect(s.body.includes('{{first_name}}'), f.file).toBe(true)
      }
    }
  })

  it('name the pain before the product in step 1', () => {
    for (const f of files.filter((x) => x.parsed.channel === 'email')) {
      const body = f.parsed.steps[0]?.body ?? ''
      const pain = body.indexOf('Prop Archive')
      const firstSentenceEnd = body.indexOf('.', body.indexOf('{{ai_opener}}'))
      expect(pain, `${f.file}: Prop Archive shows up before the pain sentence`).toBeGreaterThan(
        firstSentenceEnd,
      )
    }
  })

  it('step 1 asks for the look, step 2 points at the beta, step 3 is a break-up with no ask', () => {
    for (const f of files.filter((x) => x.parsed.channel === 'email')) {
      const [s1, s2, s3] = f.parsed.steps
      expect(findVariables(s1?.body ?? '')).toContain('demo_link')
      expect(findVariables(s2?.body ?? '')).toContain('beta_link')
      const s3vars = findVariables(s3?.body ?? '')
      expect(s3vars).not.toContain('demo_link')
      expect(s3vars).not.toContain('beta_link')
      expect(s3vars).toContain('site_link')
    }
  })
})

describe('postcards', () => {
  it('are one step under 350 characters with a hand-written feel and one link line', () => {
    for (const f of files.filter((x) => x.parsed.channel === 'mail')) {
      expect(f.parsed.steps, f.file).toHaveLength(1)
      const body = f.parsed.steps[0]?.body ?? ''
      expect(body.length, `${f.file} is ${body.length} chars`).toBeLessThan(350)
      expect(findVariables(body)).toContain('demo_link')
      expect(findVariables(body)).toContain('sender_name')
      expect(body.startsWith('{{first_name}},'), f.file).toBe(true)
    }
  })
})

describe('linkedin sequences', () => {
  it('are a connection note under 300 chars, then a message under 100 words with the link', () => {
    for (const f of files.filter((x) => x.parsed.channel === 'linkedin')) {
      expect(f.parsed.steps, f.file).toHaveLength(2)
      const [note, message] = f.parsed.steps
      expect(note?.delay_days).toBe(0)
      expect((note?.body ?? '').length, `${f.file} note length`).toBeLessThan(300)
      expect(findVariables(note?.body ?? '')).not.toContain('demo_link')
      expect(findVariables(note?.body ?? '')).not.toContain('beta_link')
      expect(message?.delay_days ?? 0, f.file).toBeGreaterThan(0)
      expect(wordCount(message?.body ?? ''), `${f.file} message words`).toBeLessThan(100)
      expect(findVariables(message?.body ?? '')).toContain('demo_link')
    }
  })
})

describe('call scripts', () => {
  it('have the 10 second open, three questions, the ask and two objections', () => {
    for (const f of files.filter((x) => x.parsed.channel === 'call')) {
      expect(f.parsed.steps, f.file).toHaveLength(1)
      const body = f.parsed.steps[0]?.body ?? ''
      expect(body, f.file).toMatch(/^10 second open\n/)
      expect(body, f.file).toMatch(/\nThree questions/)
      expect(body, f.file).toMatch(/\n1\. .+\n2\. .+\n3\. .+/)
      expect(body, f.file).toMatch(/\nThe ask\n/)
      expect(count(/\nIf they say "/g, body), `${f.file} objections`).toBe(2)
      expect(findVariables(body)).toContain('demo_link')
      expect(findVariables(body)).toContain('sender_name')
      // The open names the pain and the fix before anything else.
      const open = body.split('\n')[1] ?? ''
      expect(open, f.file).toMatch(/We (put|give) /)
      expect(open, f.file).toMatch(/Do you have two minutes\?"$/)
    }
  })
})

describe('persona voice', () => {
  it("speaks each persona's pain in plain Philadelphia landlord words", () => {
    const byPersona = (p: string) => files.filter((f) => f.parsed.persona === p)
    const text = (fs: SequenceFile[]) =>
      fs.map((f) => f.parsed.steps.map((s) => s.body).join('\n')).join('\n')
    const maya = text(byPersona('maya'))
    expect(maya).toMatch(/repair text/i)
    expect(maya).toMatch(/tax time/i)
    expect(maya).toMatch(/lead cert/i)
    expect(maya).toMatch(/day job|work day|at work/i)
    const ray = text(byPersona('ray'))
    expect(ray).toMatch(/turnover/i)
    expect(ray).toMatch(/contractor/i)
    expect(ray).toMatch(/spreadsheet/i)
    const denise = text(byPersona('denise'))
    expect(denise).toMatch(/office/i)
    expect(denise).toMatch(/per unit|per-unit/i)
    expect(denise).toMatch(/compliance/i)
    expect(denise).toMatch(/staff/i)
  })
})
