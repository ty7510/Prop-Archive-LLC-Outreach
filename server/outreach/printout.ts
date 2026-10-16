// The printout Theo mails in a folder with his business card (2026-10-16): one letter page. This
// file writes its middle, the part about this person and their company: Claude writes it from the
// same facts as the LinkedIn note, the rules are checked again in code, and without a model (or
// when two tries break the rules) a version for their kind of owner is used. Theo proofs and edits
// every printout before he prints it; the page itself is drawn by shared/printout.ts.
import type { PrintoutParts } from '../../shared/printout.ts'
import type { Settings } from '../../shared/settings.ts'
import type { Lead } from '../db/schema.ts'
import { titleCase } from '../lib/text.ts'
import { copyProblems } from './copyRules.ts'
import type { Llm } from './deps.ts'
import { cleanNote, noteFacts } from './linkedinNote.ts'
import { plainLinks, type TemplateVars } from './templates.ts'

export const PRINTOUT_WORDS = { min: 70, max: 160 } as const

/** Records shout ("FAIRMOUNT RENTALS LLC"); paper should not. */
function quieter(s: string): string {
  const t = s.trim()
  return t && t === t.toUpperCase() ? titleCase(t) : t
}

/** The name fields of the template vars (any of them may be missing). */
export type NameVars = Partial<Record<'company' | 'full_name' | 'first_name', string>>

/** Their company as it reads on paper, or '' when there is none or it is just their name. */
export function companyName(vars: NameVars): string {
  const company = (vars.company ?? '').trim()
  if (!company || company.toLowerCase() === (vars.full_name ?? '').trim().toLowerCase()) return ''
  return quieter(company)
}

function firstNameOf(vars: NameVars): string {
  const first = (vars.first_name ?? '').trim()
  return first && first !== 'there' ? quieter(first) : ''
}

/** The printout's heading: their company when there is one. */
export function printoutHeading(vars: NameVars): string {
  const company = companyName(vars)
  if (company) return `How Prop Archive can help ${company}`
  const first = firstNameOf(vars)
  return first
    ? `${first}, here is how Prop Archive can help`
    : 'How Prop Archive can help with your rentals'
}

type OwnerSize = 'team' | 'full_time' | 'side'

function ownerSize(lead: Pick<Lead, 'persona' | 'property_count'>): OwnerSize {
  if (lead.persona === 'denise' || lead.property_count >= 15) return 'team'
  if (lead.persona === 'ray' || lead.property_count >= 7) return 'full_time'
  return 'side'
}

/** Theo's words for each kind of owner, used when Claude is not there or breaks the rules. */
export const FALLBACK_PRINTOUT: Record<OwnerSize, string> = {
  team: [
    'Running a management company means keeping a team, a list of owners and a lot of tenants on the same page. When leases sit in one inbox, repair requests come in by text and rent lives in a spreadsheet only one person understands, things slip and the phone keeps ringing.',
    'Prop Archive puts all of it in one place. Your team sees every repair from the first message to the finished job, every lease is a search away, and you can see who has paid without opening a spreadsheet. Owners and tenants each get their own portal, so fewer calls land on you.',
  ].join('\n\n'),
  full_time: [
    "When rentals are your full-time work, the hard part usually isn't the buildings. It's everything around them: a lease in one folder, a repair request in a text from last week, rent in a spreadsheet you update at night.",
    "Prop Archive puts all of it in one place. Repairs come in through one door and you can see where each one stands, every lease and document is a search away, and rent is there at a glance. It's built so a small operation can run like a much bigger one.",
  ].join('\n\n'),
  side: [
    "With a few rentals on top of everything else, the work shows up at the worst times: a repair text in the middle of your day, a lease you need and can't find, rent you have to chase at night.",
    "Prop Archive keeps it in one place. Tenants send repairs through their own portal instead of your phone, your leases and documents are a search away, and you can see rent at a glance. It's meant to give you your evenings back.",
  ].join('\n\n'),
}

export function fallbackPrintout(lead: Pick<Lead, 'persona' | 'property_count'>): string {
  return FALLBACK_PRINTOUT[ownerSize(lead)]
}

export const PRINTOUT_SYSTEM = [
  'You write the middle of a printed one-page letter from Theo to one Philadelphia landlord or property manager: the part about them and their company. Theo mails it in a folder with his business card, and he reads it before he prints it.',
  'Below your part the page already has a short overview of Prop Archive, a few lines about Theo and his sign-off. Do not repeat those, do not introduce Theo and do not sign off.',
  'Prop Archive is one place for a small landlord or manager to keep leases and documents, repair requests and rent, with a portal each for tenants, owners and contractors.',
  'Write two short paragraphs, 80 to 140 words in all:',
  '- The first sentence names a problem an owner like them really has, picked from the facts: how many places they run, what kind of company it is, the part of the city. It is about them, not Theo.',
  '- Then what changes for them with Prop Archive: one or two concrete moments in their week that get easier. No feature list, no headings, no bullet points.',
  '- Speak to them as "you". Name their company once when one is given and it is not just their own name.',
  '- The facts are only for choosing the situation. Never state a count, an address, a license, a violation, a sale or anything else that shows they were looked up. Never invent anything about them.',
  '- Sound like one person talking: contractions, plain words. No exclamation marks, no emoji, no links, no numbers, no em-dash character.',
  '- Never write: I hope, reach out, came across, quick question, circling back, touching base, checking in, synergy, leverage, solution.',
  '- Never mention prices, discounts, customers, user numbers, awards, contracts or signing, and never say the beta is new, empty or waiting for its first user.',
  'Return the two paragraphs only, with one blank line between them.',
].join('\n')

/** The part about them, written for them; null when there is no model or two tries break a rule. */
export async function writePrintout(
  lead: Pick<Lead, 'persona' | 'owner_kind' | 'enrichment'>,
  vars: TemplateVars,
  llm: Llm | null,
): Promise<string | null> {
  if (!llm) return null
  const facts = noteFacts(lead, { ...vars, company: companyName(vars) })
  const prompt = [
    `Facts about this person:\n${facts.join('\n') || '(none)'}`,
    'Write the part about them.',
  ].join('\n\n')
  let ask = prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: string | null
    try {
      out = await llm.text(ask, { system: PRINTOUT_SYSTEM, maxTokens: 500 })
    } catch {
      return null
    }
    if (!out) return null
    const text = cleanNote(out)
    const problems = copyProblems(text, PRINTOUT_WORDS)
    if (problems.length === 0) return text
    ask = `${prompt}\n\nYour last version broke the rules (${problems.join('; ')}):\n${text}\n\nWrite it again.`
  }
  return null
}

/** "October 16, 2026" in Theo's time zone. */
export function letterDate(settings: Pick<Settings, 'send_window'>, now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: settings.send_window.tz,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now)
}

/** Everything one page needs: this person's part from the message, the rest from Settings. */
export function printoutParts(
  settings: Settings,
  message: { id: string; subject: string | null; body: string },
  who: { full_name: string | null; company: string | null; first_name?: string | null },
  now: Date,
): PrintoutParts {
  const name = quieter(who.full_name ?? '')
  const company = companyName({ company: who.company ?? '', full_name: name })
  return {
    heading:
      message.subject?.trim() ||
      printoutHeading({
        company: who.company ?? '',
        full_name: name,
        first_name: who.first_name ?? '',
      }),
    body: message.body,
    overview: settings.printout_overview,
    bio: settings.printout_bio,
    closing: settings.printout_closing,
    preparedFor: [name, company].filter(Boolean),
    date: letterDate(settings, now),
    ownerName: settings.owner_name,
    email: settings.reply_to || settings.owner_email,
    site: plainLinks(settings).site_link,
    editHref: `/printout/${encodeURIComponent(message.id)}`,
  }
}
