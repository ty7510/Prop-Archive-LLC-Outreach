// A LinkedIn connection note written for one person and their company, from Theo's own note.
// Theo sends it by hand; the app never touches LinkedIn. The house rules for cold copy
// (the prop-archive-cold-email skill) are in the system prompt and checked again in code.
import type { Lead } from '../db/schema.ts'
import { hasEmDash } from '../lib/text.ts'
import type { Llm } from './deps.ts'
import type { TemplateVars } from './templates.ts'

/** A free LinkedIn account allows 200 characters in a connection note. */
export const LINKEDIN_NOTE_MAX = 200

export const LINKEDIN_NOTE_SYSTEM = [
  'You write one LinkedIn connection note from Theo to one Philadelphia landlord or property manager.',
  'Theo runs Prop Archive: one place for a small landlord or manager to keep leases, repairs and rent.',
  'Theo sends the note himself. You are given his own note: keep its ask and its voice, and rewrite it',
  'for this one person and their company.',
  'Rules:',
  `- At most ${LINKEDIN_NOTE_MAX} characters counting spaces. Aim for 140 to 190.`,
  '- Greet them by first name when one is given.',
  '- The first sentence names a problem an owner like them really has, picked from the facts: how many',
  '  places they run, what kind of company it is, the part of the city. It is about them, not Theo.',
  '- Name their company when one is given and it is not just their own name.',
  '- Then at most one short line on what Prop Archive does about it. No feature lists.',
  '- End with one low-pressure ask, like the one in his note.',
  '- The facts are only for choosing the situation. Never state a count, an address, a license, a',
  '  violation, a sale or anything else that shows they were looked up. Never invent anything.',
  '- Sound like one person typing fast: contractions, plain words. No exclamation marks, no emoji,',
  '  no links, no hashtags, no em-dash character.',
  '- Never write: I hope, reach out, came across, quick question, circling back, touching base,',
  '  checking in, synergy, leverage, solution.',
  '- Never mention prices, discounts, customers, user numbers, awards, contracts or signing, and never',
  '  say the beta is new, empty or waiting for its first user.',
  'Return the note only, nothing before or after it.',
].join('\n')

const BANNED = [
  'i hope',
  'reach out',
  'reaching out',
  'came across',
  'quick question',
  'circling back',
  'touching base',
  'checking in',
  'synerg',
  'leverage',
  'solution',
]

/** Why a note cannot go out as written. Empty when it is fine. */
export function noteProblems(note: string): string[] {
  const problems: string[] = []
  if (!note.trim()) problems.push('it is empty')
  if (note.length > LINKEDIN_NOTE_MAX) {
    problems.push(`it is ${note.length} characters; the limit is ${LINKEDIN_NOTE_MAX}`)
  }
  if (/https?:|www\.|\.com\b|\.app\b/i.test(note)) problems.push('it has a link')
  if (note.includes('!')) problems.push('it has an exclamation mark')
  // A number reads as "I looked you up" (a count, an address). "15 minutes" is the one allowed.
  if (/\d/.test(note.replace(/\b15[- ]minutes?\b/gi, ''))) problems.push('it has a number')
  const lower = note.toLowerCase()
  for (const phrase of BANNED) {
    if (lower.includes(phrase)) problems.push(`it says "${phrase}"`)
  }
  return problems
}

/** Model output to a note: one paragraph block, no wrapping quotes, em-dashes made commas. */
export function cleanNote(raw: string): string {
  let text = raw.trim()
  if (/^["“].*["”]$/s.test(text)) text = text.slice(1, -1).trim()
  text = text.replace(/^note:\s*/i, '')
  text = text.replace(/\s*—\s*/g, ', ')
  return text
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function researchDetails(lead: Pick<Lead, 'enrichment'>): string[] {
  const data = lead.enrichment?.claude_research?.data as { property_details?: unknown } | undefined
  const details = Array.isArray(data?.property_details) ? data.property_details : []
  return details
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    .slice(0, 3)
    .map((d) => d.trim().slice(0, 160))
}

const PERSONA: Record<string, string> = {
  maya: 'a few rentals next to a day job',
  ray: 'rentals are their full-time work',
  denise: 'a small management company or team',
}

/** The facts the note may draw on. */
export function noteFacts(
  lead: Pick<Lead, 'persona' | 'owner_kind' | 'enrichment'>,
  vars: TemplateVars,
): string[] {
  const company = (vars.company ?? '').trim()
  const fullName = (vars.full_name ?? '').trim()
  return [
    vars.first_name && vars.first_name !== 'there' ? `first name: ${vars.first_name}` : '',
    company && company.toLowerCase() !== fullName.toLowerCase() ? `company: ${company}` : '',
    lead.owner_kind && lead.owner_kind !== 'unknown' ? `owner kind: ${lead.owner_kind}` : '',
    lead.persona && PERSONA[lead.persona] ? `kind of owner: ${PERSONA[lead.persona]}` : '',
    vars.property_count ? `properties: ${vars.property_count}` : '',
    vars.unit_count ? `units: ${vars.unit_count}` : '',
    vars.neighborhood ? `part of the city: ${vars.neighborhood}` : '',
    vars.trigger_line ? `recent event: ${vars.trigger_line}` : '',
    ...researchDetails(lead).map((d) => `from public records: ${d}`),
  ].filter(Boolean)
}

/**
 * Theo's note rewritten for this person, or null when there is no model, it fails, or two tries
 * still break a rule (the caller then keeps Theo's own note).
 */
export async function writePersonalNote(
  lead: Pick<Lead, 'persona' | 'owner_kind' | 'enrichment'>,
  vars: TemplateVars,
  theosNote: string,
  llm: Llm | null,
): Promise<string | null> {
  if (!llm || !theosNote.trim()) return null
  const prompt = [
    `Theo's note:\n${theosNote.trim()}`,
    `Facts about this person:\n${noteFacts(lead, vars).join('\n') || '(none)'}`,
    'Write the note.',
  ].join('\n\n')
  let ask = prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: string | null
    try {
      out = await llm.text(ask, { system: LINKEDIN_NOTE_SYSTEM, maxTokens: 220 })
    } catch {
      return null
    }
    if (!out) return null
    const note = cleanNote(out)
    const problems = noteProblems(note)
    if (problems.length === 0 && !hasEmDash(note)) return note
    ask = `${prompt}\n\nYour last note broke the rules (${problems.join('; ')}):\n${note}\n\nWrite it again.`
  }
  return null
}
