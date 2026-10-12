// Pure parser for content/sequences/*.md. No file system, no database. Owned by the content builder.
//
// File shape:
//   ---
//   name: Email, Maya, no trigger
//   channel: email            (email | mail | linkedin | instagram | call)
//   persona: maya             (maya | ray | denise | any)
//   trigger: none             (new_license | recent_sale | none | any; none is stored as any)
//   description: optional one line
//   ---
//
//   ## Step 1
//   delay_days: 0
//   channel: optional; a step may use another channel than the sequence (email, then LinkedIn, then mail)
//   subject: only email uses this
//   notes: optional, shown to Theo in the editor
//
//   The body. Everything after the meta lines until the next "## Step" heading.
import {
  CHANNELS,
  SEQUENCE_PERSONAS,
  SEQUENCE_TRIGGERS,
  type Channel,
  type SequencePersona,
  type SequenceTrigger,
} from '../../shared/types.ts'

export interface ParsedStep {
  /** 0-based, matches sequence_steps.step_index and the idempotency key. */
  step_index: number
  delay_days: number
  /** The step's own channel. Defaults to the sequence channel. */
  channel: Channel
  subject: string | null
  body: string
  notes: string | null
}

export interface ParsedSequence {
  name: string
  channel: Channel
  persona: SequencePersona
  trigger: SequenceTrigger
  description: string | null
  steps: ParsedStep[]
}

export class SequenceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SequenceParseError'
  }
}

/** Template variables the renderer knows (spec section 10), plus the optional AI first line. */
export const TEMPLATE_VARS = [
  'first_name',
  'full_name',
  'company',
  'property_count',
  'unit_count',
  'neighborhood',
  'trigger_line',
  'demo_link',
  'beta_link',
  'site_link',
  'sender_name',
  'unsubscribe_link',
  'ai_opener',
] as const
export type TemplateVar = (typeof TEMPLATE_VARS)[number]

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** Every {{variable}} name in a template, in order, with repeats. */
export function findVariables(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1]
    if (name) out.push(name)
  }
  return out
}

const FRONT_MATTER_KEYS = new Set(['name', 'channel', 'persona', 'trigger', 'description'])
const STEP_META_RE = /^(delay_days|channel|subject|notes):[ \t]*(.*)$/
const STEP_HEADING_RE = /^##[ \t]+Step[ \t]+(\d+)[ \t]*$/

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value)
}

function parseFrontMatter(lines: string[]): { meta: Record<string, string>; next: number } {
  let i = 0
  while (i < lines.length && lines[i]?.trim() === '') i++
  if (lines[i]?.trim() !== '---') {
    throw new SequenceParseError('file must start with a --- front matter block')
  }
  i++
  const meta: Record<string, string> = {}
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') return { meta, next: i + 1 }
    if (line.trim() === '') continue
    const idx = line.indexOf(':')
    if (idx <= 0) throw new SequenceParseError(`front matter line is not "key: value": ${line}`)
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!FRONT_MATTER_KEYS.has(key))
      throw new SequenceParseError(`unknown front matter key: ${key}`)
    meta[key] = value
  }
  throw new SequenceParseError('front matter block never closed with ---')
}

function parseStep(number: number, lines: string[], sequenceChannel: Channel): ParsedStep {
  let i = 0
  let delay: number | null = null
  let channel: Channel = sequenceChannel
  let subject: string | null = null
  let notes: string | null = null
  // Meta lines sit at the top of the step. Blank lines between them are fine.
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const m = STEP_META_RE.exec(line)
    if (!m) break
    const key = m[1]
    const value = (m[2] ?? '').trim()
    if (key === 'delay_days') {
      if (!/^\d+$/.test(value)) {
        throw new SequenceParseError(
          `Step ${number}: delay_days must be a whole number, got "${value}"`,
        )
      }
      delay = Number(value)
    } else if (key === 'channel') {
      if (!isOneOf(CHANNELS, value)) {
        throw new SequenceParseError(
          `Step ${number}: channel must be one of ${CHANNELS.join(', ')}, got "${value}"`,
        )
      }
      channel = value
    } else if (key === 'subject') {
      subject = value || null
    } else if (key === 'notes') {
      notes = value || null
    }
  }
  if (delay === null) throw new SequenceParseError(`Step ${number}: delay_days is required`)
  const body = lines
    .slice(i)
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
  if (!body) throw new SequenceParseError(`Step ${number}: body is empty`)
  return { step_index: number - 1, delay_days: delay, channel, subject, body, notes }
}

/** Parse one sequence file. Throws SequenceParseError with a plain message on any problem. */
export function parseSequenceMarkdown(text: string): ParsedSequence {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const { meta, next } = parseFrontMatter(lines)

  const name = meta.name?.trim() ?? ''
  if (!name) throw new SequenceParseError('front matter needs a name')
  const channel = meta.channel ?? ''
  if (!isOneOf(CHANNELS, channel)) {
    throw new SequenceParseError(`channel must be one of ${CHANNELS.join(', ')}, got "${channel}"`)
  }
  const persona = meta.persona ?? ''
  if (!isOneOf(SEQUENCE_PERSONAS, persona)) {
    throw new SequenceParseError(
      `persona must be one of ${SEQUENCE_PERSONAS.join(', ')}, got "${persona}"`,
    )
  }
  const rawTrigger = meta.trigger === 'none' ? 'any' : (meta.trigger ?? '')
  if (!isOneOf(SEQUENCE_TRIGGERS, rawTrigger)) {
    throw new SequenceParseError(
      `trigger must be one of new_license, recent_sale, none, got "${meta.trigger ?? ''}"`,
    )
  }

  // Split the rest on "## Step N" headings.
  const sections: { number: number; lines: string[] }[] = []
  let current: { number: number; lines: string[] } | null = null
  for (let i = next; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const h = STEP_HEADING_RE.exec(line)
    if (h) {
      current = { number: Number(h[1]), lines: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      if (line.trim() !== '') {
        throw new SequenceParseError(`text before the first "## Step 1" heading: ${line.trim()}`)
      }
      continue
    }
    current.lines.push(line)
  }
  if (sections.length === 0) throw new SequenceParseError('no "## Step 1" section found')

  const steps = sections.map((s, idx) => {
    if (s.number !== idx + 1) {
      throw new SequenceParseError(
        `steps must be numbered 1, 2, 3 in order; found Step ${s.number}`,
      )
    }
    return parseStep(s.number, s.lines, channel)
  })

  return {
    name,
    channel,
    persona,
    trigger: rawTrigger,
    description: meta.description?.trim() || null,
    steps,
  }
}
