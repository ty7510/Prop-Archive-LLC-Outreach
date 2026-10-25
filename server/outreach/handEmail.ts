// The email Theo sends by hand (2026-10-16: "a linkedin message then a printout i will mail in a
// folder with my business card then a email; all hand sent by me but not written by me"). Claude
// writes it for this person in the cold-email house style (the prop-archive-cold-email skill), the
// rules are checked again in code, and Theo proofs and edits it on his card. Open in Gmail puts it
// in a new Gmail message and he presses Send himself: the app never sends it.
import { z } from 'zod'
import type { Settings } from '../../shared/settings.ts'
import type { Lead } from '../db/schema.ts'
import { copyProblems } from './copyRules.ts'
import type { Llm } from './deps.ts'
import { BANNED, cleanNote, noteFacts } from './linkedinNote.ts'
import { companyName, letterVars, personFirstName } from './printout.ts'
import type { TemplateVars } from './templates.ts'

export const EMAIL_WORDS = { min: 50, max: 150 } as const
/** A follow-up is shorter: they already had the first email. */
export const FOLLOW_UP_WORDS = { min: 25, max: 100 } as const

export interface HandEmail {
  subject: string
  body: string
}

/** What this email is: whether the printout is on its way, and whether they had an email before. */
export interface EmailContext {
  mailed: boolean
  followUp: boolean
}

const HandEmailSchema = z.object({ subject: z.string(), body: z.string() })

/** Theo emailed them on an earlier round and they did not answer: a short, new follow-up. */
function followUpSystem(mailed: boolean): string {
  const parts = [
    '"Hi <first name>," on its own line, or just "Hi," when there is no first name.',
    'One line saying this follows his email from last month, with no guilt and no pressure.',
    'One new reason it might matter to them, picked from the facts: one concrete moment in their week that Prop Archive makes easier. Do not repeat a whole pitch.',
    ...(mailed
      ? [
          'One short line saying he also mailed them a short overview and his card. Never say when it arrives.',
        ]
      : []),
    "The ask, one sentence: a 15-minute look, and that a one-word no is fine if it's not a fit right now.",
    'The last line before his name says the "Join the beta" button and the link to proparchive.app are in his signature below.',
    '"Theo" on its own line.',
  ]
  return [
    'You write one short follow-up email from Theo to one Philadelphia landlord or property manager. Theo emailed them about a month ago and they did not answer. Theo reads it, then sends it himself from Gmail.',
    'Prop Archive is one place for a small landlord or manager to keep leases and documents, repair requests and rent, with a portal each for tenants, owners and contractors.',
    'The body, in this order, 35 to 80 words:',
    ...parts.map((p, i) => `${i + 1}. ${p}`),
    'The subject: 2 to 6 words, low pressure, no clickbait, no numbers.',
    'Rules:',
    '- Name their company once when one is given and it is not just their own name.',
    '- The facts are only for choosing the situation. Never state a count, an address, a license, a violation, a sale or anything else that shows they were looked up. Never invent anything.',
    '- Sound like one person typing fast: contractions, plain words. No exclamation marks, no emoji, no links (just say proparchive.app), no numbers except "15 minutes", no em-dash character.',
    '- Never write: I hope, reach out, came across, quick question, circling back, touching base, checking in, bumping this, synergy, leverage, solution.',
    '- Never mention prices, discounts, customers, user numbers, awards, pitch competitions, money raised, contracts or paperwork, and never say the beta is new, empty or waiting for its first user.',
  ].join('\n')
}

export function emailSystem(context: EmailContext): string {
  if (context.followUp) return followUpSystem(context.mailed)
  const mailed = context.mailed
  const parts = [
    '"Hi <first name>," on its own line, or just "Hi," when there is no first name.',
    'The first sentence names a problem an owner like them really has, picked from the facts. It is about them, not Theo.',
    'One or two lines on what Prop Archive does about that problem. No feature list and no workflow: leave them curious enough to want the 15 minutes.',
    'One line on why Theo: Prop Archive is his second company (he ran his first for five years), and he grew up around landlords, realtors and property managers.',
    ...(mailed
      ? [
          'One short line saying he also mailed them a short overview and his card. Never say when it arrives.',
        ]
      : []),
    "The beta, in these words or very close: free while we're in beta, beta members get six months free at launch, and there's nothing to sign. Write the number as the word six.",
    'The ask, one sentence: a 15-minute look.',
    'The last line before his name says the "Join the beta" button and the link to proparchive.app are in his signature below.',
    '"Theo" on its own line.',
  ]
  return [
    'You write one cold email from Theo to one Philadelphia landlord or property manager. Theo reads it, then sends it himself from Gmail.',
    'Prop Archive is one place for a small landlord or manager to keep leases and documents, repair requests and rent, with a portal each for tenants, owners and contractors.',
    'The body, in this order, 70 to 120 words:',
    ...parts.map((p, i) => `${i + 1}. ${p}`),
    'The subject: 3 to 8 words about their situation, low pressure, no clickbait, no numbers.',
    'Rules:',
    '- Name their company once when one is given and it is not just their own name.',
    '- The facts are only for choosing the situation. Never state a count, an address, a license, a violation, a sale or anything else that shows they were looked up. Never invent anything.',
    '- Sound like one person typing fast: contractions, plain words. No exclamation marks, no emoji, no links (just say proparchive.app), no numbers except "15 minutes", no em-dash character.',
    '- Never write: I hope, reach out, came across, quick question, circling back, touching base, checking in, synergy, leverage, solution.',
    '- Never mention prices, discounts, customers, user numbers, awards, pitch competitions, money raised, contracts or paperwork, and never say the beta is new, empty or waiting for its first user.',
  ].join('\n')
}

/** Why a subject line cannot go out as written. Empty when it is fine. */
export function subjectProblems(subject: string): string[] {
  const s = subject.trim()
  if (!s) return ['the subject is empty']
  const problems: string[] = []
  const words = s.split(/\s+/).length
  if (words < 2 || words > 10) problems.push(`the subject is ${words} words; use 3 to 8`)
  if (/[!\d]/.test(s)) problems.push('the subject has a number or an exclamation mark')
  const lower = s.toLowerCase()
  for (const phrase of BANNED) {
    if (lower.includes(phrase)) problems.push(`the subject says "${phrase}"`)
  }
  return problems
}

export function emailProblems(
  email: HandEmail,
  words: { min: number; max: number } = EMAIL_WORDS,
): string[] {
  const problems = [...subjectProblems(email.subject), ...copyProblems(email.body, words)]
  if (!/proparchive\.app/i.test(email.body)) {
    problems.push('it does not point to proparchive.app in his signature')
  }
  return problems
}

/** Theo's own email, used when Claude is not there or breaks the rules. */
export function fallbackEmail(vars: TemplateVars, context: EmailContext): HandEmail {
  const first = personFirstName(vars)
  const company = companyName(vars)
  const mailed = context.mailed
  if (context.followUp) {
    return {
      subject: 'Following up on Prop Archive',
      body: [
        first ? `Hi ${first},` : 'Hi,',
        `Following up on my email from last month. If repairs, leases or rent ever pile up at the worst times${company ? ` at ${company}` : ''}, Prop Archive keeps all three in one place, so fewer things land on your phone.${mailed ? ' I mailed you a short overview and my card too.' : ''}`,
        "Worth a 15-minute look? If it's not a fit right now, a one-word no is fine too.",
        'If you\'d like to look around first, the "Join the beta" button and the link to proparchive.app are both in my signature below.',
        'Theo',
      ].join('\n\n'),
    }
  }
  return {
    subject: company
      ? `Leases, repairs and rent at ${company}`
      : 'Leases, repairs and rent in one place',
    body: [
      first ? `Hi ${first},` : 'Hi,',
      'If your leases live in one folder, repair requests in your texts and rent in a spreadsheet, you know how much of the week goes to keeping it all straight.',
      'Prop Archive puts it in one place, with a portal each for tenants, owners and contractors, so fewer things land on your phone.',
      `This is my second company, and I grew up around landlords, realtors and property managers.${mailed ? ' I mailed you a short overview and my card too.' : ''}`,
      "It's free while we're in beta, beta members get six months free at launch, and there's nothing to sign. Worth a 15-minute look?",
      'If you\'d like to look around first, the "Join the beta" button and the link to proparchive.app are both in my signature below.',
      'Theo',
    ].join('\n\n'),
  }
}

/** The opt-out line and the mailing address every commercial email needs (CAN-SPAM). */
export function emailFooter(settings: Pick<Settings, 'physical_address'>): string {
  const lines = ['Not for you? Reply "stop" and I won\'t email you again.']
  const address = settings.physical_address.trim()
  if (address) lines.push(`Prop Archive LLC, ${address}`)
  return lines.join('\n')
}

export function withFooter(body: string, settings: Pick<Settings, 'physical_address'>): string {
  return `${body.trim()}\n\n${emailFooter(settings)}`
}

/** The email written for them; null when there is no model or two tries break a rule. */
export async function writeHandEmail(
  lead: Pick<Lead, 'persona' | 'owner_kind' | 'enrichment'>,
  vars: TemplateVars,
  context: EmailContext,
  llm: Llm | null,
): Promise<HandEmail | null> {
  if (!llm) return null
  const words = context.followUp ? FOLLOW_UP_WORDS : EMAIL_WORDS
  const facts = noteFacts(lead, letterVars(vars))
  const prompt = [
    `Facts about this person:\n${facts.join('\n') || '(none)'}`,
    context.followUp
      ? 'Write the subject and the body of the follow-up.'
      : 'Write the subject and the body.',
  ].join('\n\n')
  let ask = prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: HandEmail | null
    try {
      out = await llm.structured(ask, HandEmailSchema, {
        system: emailSystem(context),
        maxTokens: 700,
      })
    } catch {
      return null
    }
    if (!out) return null
    const email = { subject: cleanNote(out.subject), body: cleanNote(out.body) }
    const problems = emailProblems(email, words)
    if (problems.length === 0) return email
    ask = `${prompt}\n\nYour last email broke the rules (${problems.join('; ')}):\nSubject: ${email.subject}\n\n${email.body}\n\nWrite it again.`
  }
  return null
}
