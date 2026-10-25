// The printout Theo mails in a folder with his business card (2026-10-16): two letter pages. This
// file writes the top of page one, the part about this person and their company: Claude writes it from the
// same facts as the LinkedIn note, the rules are checked again in code, and without a model (or
// when two tries break the rules) a version for their kind of owner is used. Either way the part is
// sized to the room the rest of page one leaves (shared/printoutFit.ts), so the page always fits its
// sheet (Theo, 2026-10-25). Theo proofs and edits every printout before he prints it; the page
// itself is drawn by shared/printout.ts.
import { isPhotoDataUrl, type PrintoutParts } from '../../shared/printout.ts'
import {
  bodyRoom,
  FIT_SIZES,
  lineCount,
  FLOW_WIDTH,
  pageFitsAt,
  PLANNED_SIZE,
  SMALLEST_SIZE,
  type PrintoutFitParts,
} from '../../shared/printoutFit.ts'
import type { Settings } from '../../shared/settings.ts'
import type { Lead } from '../db/schema.ts'
import { isLlc, titleCase } from '../lib/text.ts'
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

/**
 * Their company as it reads on paper, or '' when there is none or it is just their own name. An
 * owner on record as a company ("Fairmount Rentals LLC") is that company.
 */
export function companyName(vars: NameVars): string {
  const company = (vars.company ?? '').trim()
  const full = (vars.full_name ?? '').trim()
  if (!company) return isLlc(full) ? quieter(full) : ''
  if (company.toLowerCase() === full.toLowerCase() && !isLlc(company)) return ''
  return quieter(company)
}

/**
 * The first name to greet them by, or '' when there is no person's name: for "Fairmount Rentals
 * LLC" the template vars guess "Fairmount", which is not anybody's name.
 */
export function personFirstName(vars: NameVars): string {
  const first = (vars.first_name ?? '').trim()
  if (!first || first === 'there') return ''
  const full = (vars.full_name ?? '').trim()
  if (isLlc(full) && full.split(/\s+/)[0]?.toLowerCase() === first.toLowerCase()) return ''
  return quieter(first)
}

/**
 * The template vars with the name fields made safe for a letter or an email. A company owner's
 * name is their company, so it is given as the company and not as a person's name.
 */
export function letterVars(vars: TemplateVars): TemplateVars {
  const company = companyName(vars)
  const full = quieter(vars.full_name ?? '')
  return {
    ...vars,
    first_name: personFirstName(vars) || 'there',
    company,
    full_name: company && company.toLowerCase() === full.toLowerCase() ? '' : full,
  }
}

/** The printout's heading: their company when there is one. */
export function printoutHeading(vars: NameVars): string {
  const company = companyName(vars)
  if (company) return `How Prop Archive can help ${company}`
  const first = personFirstName(vars)
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
  'You write the letter at the top of a printed two-page piece from Theo to one Philadelphia landlord or property manager: the part about them and their company, on page one. Theo mails it in a folder with his business card, and he reads it before he prints it.',
  'After your part, page one has his closing, his signature and a few lines about him, and page two has an overview of Prop Archive and what it does. Do not repeat those, do not list features, do not introduce Theo and do not sign off.',
  'Prop Archive is one place for a small landlord or manager to keep leases and documents, repair requests and rent, with a portal each for tenants, owners and contractors.',
  'Write two short paragraphs, {words} in all. It is printed on page one with the rest, so never go over the most:',
  '- The first sentence names a problem an owner like them really has, picked from the facts: how many places they run, what kind of company it is, the part of the city. It is about them, not Theo.',
  '- Then what changes for them with Prop Archive: one or two concrete moments in their week that get easier. No feature list, no headings, no bullet points.',
  '- Speak to them as "you". Name their company once when one is given and it is not just their own name.',
  '- The facts are only for choosing the situation. Never state a count, an address, a license, a violation, a sale or anything else that shows they were looked up. Never invent anything about them.',
  '- Sound like one person talking: contractions, plain words. No exclamation marks, no emoji, no links, no numbers, no em-dash character.',
  '- Never write: I hope, reach out, came across, quick question, circling back, touching base, checking in, synergy, leverage, solution.',
  '- Never mention prices, discounts, customers, user numbers, awards, contracts or signing, and never say the beta is new, empty or waiting for its first user.',
  'Return the two paragraphs only, with one blank line between them.',
].join('\n')

/** The rest of the page around the part written for them: what decides how much room it has. */
export type PrintoutPage = Omit<PrintoutFitParts, 'body'>

/** The page as it will print for them: their heading and Theo's Settings. */
export function printoutPage(settings: Settings, heading: string): PrintoutPage {
  return {
    heading,
    overview: settings.printout_overview,
    features: settings.printout_features,
    bio: settings.printout_bio,
    closing: settings.printout_closing,
    ownerName: settings.owner_name,
    photo: isPhotoDataUrl(settings.printout_photo ?? ''),
  }
}

/** Fewest words worth asking Claude for: under this the page has no room for a part of its own. */
const LEAST_WORDS = 25

/**
 * How long the part written for them may be: as many words as fit at the planned 10 pt (never more
 * than the 140 Theo's letters run to). When his overview, bio and closing leave less room than a
 * proper part needs, the page is planned at a smaller size, down to 8.5 pt; `words.max` under
 * LEAST_WORDS means there is no room even then.
 */
export function printoutWordPlan(page: PrintoutPage): {
  size: number
  words: { min: number; max: number }
} {
  // Never more than fits by the smallest size in the Chrome that sets text widest.
  const anyChrome = bodyRoom(page, SMALLEST_SIZE, 'widest').words
  const roomAt = (size: number) => Math.min(140, anyChrome, bodyRoom(page, size).words)
  const proper = 60
  const size =
    FIT_SIZES.find((s) => s <= PLANNED_SIZE && roomAt(s) >= proper) ??
    (roomAt(SMALLEST_SIZE) > 0 ? SMALLEST_SIZE : PLANNED_SIZE)
  const max = roomAt(size)
  return { size, words: { min: Math.min(80, Math.max(LEAST_WORDS, max - 40)), max } }
}

/**
 * Page one fits with this part: at `size` as Chrome on Windows sets it (what Theo prints), and by
 * the smallest size in any Chrome, so it never runs past its sheet. Page two holds only Theo's
 * Settings, so this part never decides whether page two fits (Settings says when it does not).
 */
export function printoutFits(page: PrintoutPage, body: string, size: number): boolean {
  const parts = { ...page, body }
  return pageFitsAt(parts, size, 1) && pageFitsAt(parts, SMALLEST_SIZE, 1, 'widest')
}

/** Short words that end in a dot but do not end a sentence, as in "St. Clair" or "Mr. Lee". */
const ABBREVIATIONS =
  /(?:^|\s)(?:St|Mt|Ft|Mr|Mrs|Ms|Dr|Jr|Sr|No|Ste|Apt|Ave|Blvd|Rd|vs|etc|e\.g|i\.e|[A-Z])\.$/

/** A paragraph split into sentences, never after an abbreviation or an initial. */
function sentences(paragraph: string): string[] {
  const out: string[] = []
  for (const piece of paragraph.split(/(?<=[.!?])\s+(?=\S)/)) {
    const prev = out[out.length - 1]
    if (prev !== undefined && ABBREVIATIONS.test(prev)) out[out.length - 1] = `${prev} ${piece}`
    else out.push(piece)
  }
  return out
}

/**
 * The part fitted to the page: whole sentences come off the end until the page fits at `size`
 * (printoutFits) and it is no longer than `maxWords`, a paragraph going once its last sentence
 * does. Empty when not even its first sentence fits.
 */
export function fitPrintoutText(
  text: string,
  page: PrintoutPage,
  size: number,
  maxWords = Number.POSITIVE_INFINITY,
): string {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => sentences(p.trim()))
    .filter((p) => p.join('').trim())
  const joined = () => paragraphs.map((p) => p.join(' ')).join('\n\n')
  const words = () => joined().split(/\s+/).filter(Boolean).length
  while (paragraphs.length && (!printoutFits(page, joined(), size) || words() > maxWords)) {
    const last = paragraphs[paragraphs.length - 1]!
    last.pop()
    if (last.length === 0) paragraphs.pop()
  }
  return joined()
}

/** Lines the part takes at `size` pt, for telling Claude how far over the page it ran. */
function bodyLines(text: string, size: number): number {
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .reduce((n, p) => n + lineCount(p.trim(), size, FLOW_WIDTH), 0)
}

/**
 * The part about them, written for them and sized to `page`; null when there is no model, the page
 * has no room for a part of its own, or two tries break a rule. A second try that only runs long
 * is cut to fit at whole sentences rather than thrown away, as long as both its paragraphs stay.
 */
export async function writePrintout(
  lead: Pick<Lead, 'persona' | 'owner_kind' | 'enrichment'>,
  vars: TemplateVars,
  llm: Llm | null,
  page: PrintoutPage,
): Promise<string | null> {
  if (!llm) return null
  const plan = printoutWordPlan(page)
  if (plan.words.max < LEAST_WORDS) return null
  const system = PRINTOUT_SYSTEM.replace('{words}', `${plan.words.min} to ${plan.words.max} words`)
  // A few words over is fine while the page still fits: the page is what counts.
  const limits = { min: Math.min(PRINTOUT_WORDS.min, plan.words.min), max: PRINTOUT_WORDS.max }
  const room = bodyRoom(page, plan.size)
  const facts = noteFacts(lead, letterVars(vars))
  const prompt = [
    `Facts about this person:\n${facts.join('\n') || '(none)'}`,
    'Write the part about them.',
  ].join('\n\n')
  let ask = prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: string | null
    try {
      out = await llm.text(ask, { system, maxTokens: 500 })
    } catch {
      return null
    }
    if (!out) return null
    const text = cleanNote(out)
    const rules = copyProblems(text, { min: limits.min, max: Number.MAX_SAFE_INTEGER })
    const fits = printoutFits(page, text, plan.size)
    const long = !fits || copyProblems(text, limits).some((p) => p.includes('the most is'))
    if (rules.length === 0 && !long) return text
    if (attempt === 1) {
      if (rules.length > 0) return null
      // Cut to fit, but only while both its paragraphs stay: without the second one the part
      // names their problem and never says what changes, and Theo's own words read better.
      const cut = fitPrintoutText(text, page, plan.size, plan.words.max + 20)
      const count = (t: string) => t.split(/\n\s*\n/).filter((p) => p.trim()).length
      const whole = count(cut) >= Math.min(2, count(text))
      return whole && copyProblems(cut, { min: limits.min, max: plan.words.max + 20 }).length === 0
        ? cut
        : null
    }
    const problems = [...rules]
    if (long) {
      problems.push(
        `it is too long for the page: it takes ${bodyLines(text, plan.size)} lines and there is room for ${room.lines}; cut it to at most ${plan.words.max} words`,
      )
    }
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

/** "Philadelphia, PA" from "1500 Market St, Philadelphia, PA 19102", for the printout's footer. */
export function cityLine(address: string): string {
  const parts = address
    .split(/,|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const state = parts.length >= 2 ? /^([A-Za-z]{2})\b/.exec(parts[parts.length - 1]!) : null
  const city = parts.length >= 3 ? parts[parts.length - 2]! : ''
  if (state && city && !/\d/.test(city)) return `${city}, ${state[1]!.toUpperCase()}`
  return 'Philadelphia, PA'
}

/** Everything the two pages need: this person's part from the message, the rest from Settings. */
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
    features: settings.printout_features,
    bio: settings.printout_bio,
    closing: settings.printout_closing,
    // Once each: a company owner's name is the company.
    preparedFor: [name, company].filter(
      (v, i, all) => v && all.findIndex((w) => w.toLowerCase() === v.toLowerCase()) === i,
    ),
    date: letterDate(settings, now),
    ownerName: settings.owner_name,
    email: settings.reply_to || settings.owner_email,
    site: plainLinks(settings).site_link,
    city: cityLine(settings.physical_address),
    photo: settings.printout_photo || undefined,
    editHref: `/printout/${encodeURIComponent(message.id)}`,
  }
}
