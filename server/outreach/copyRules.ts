// The house rules for the longer things the app writes for Theo to send by hand (the printout and
// the email), checked in code after the model writes them. The same rules as the LinkedIn note
// (linkedinNote.ts) and the prop-archive-cold-email skill.
import { hasEmDash } from '../lib/text.ts'
import { BANNED } from './linkedinNote.ts'

/** Lines that tell a stranger the pipeline is empty, or read as a student showing a trophy. */
const NEVER: readonly RegExp[] = [
  /\$/,
  /\bdiscount/i,
  /\bcontracts?\b/i,
  /\bnda\b/i,
  /\bfirst (user|customer|client)s?\b/i,
  /\bpre-?launch\b/i,
  /\bcompetition/i,
]

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** The house rules alone, without the word count (for proofing Theo's own edits). */
export function ruleProblems(text: string): string[] {
  const problems: string[] = []
  // The one address allowed is proparchive.app, said by name.
  const withoutSite = text.replace(/\bproparchive\.app\b/gi, '')
  if (/https?:|www\.|\.(com|app|net|org|io|co)\b/i.test(withoutSite)) problems.push('it has a link')
  if (text.includes('!')) problems.push('it has an exclamation mark')
  // A number reads as "I looked you up" (a count, an address). "15 minutes" is the one allowed.
  if (/\d/.test(text.replace(/\b15[- ]minutes?\b/gi, ''))) problems.push('it has a number')
  const lower = text.toLowerCase()
  for (const phrase of BANNED) {
    if (lower.includes(phrase)) problems.push(`it says "${phrase}"`)
  }
  for (const re of NEVER) {
    const m = re.exec(text)
    if (m) problems.push(`it says "${m[0]}"`)
  }
  if (hasEmDash(text)) problems.push('it has an em-dash')
  return problems
}

/** Why a piece cannot go to Theo as written. Empty when it is fine. */
export function copyProblems(text: string, words: { min: number; max: number }): string[] {
  const n = wordCount(text)
  if (n === 0) return ['it is empty']
  const problems: string[] = []
  if (n < words.min) problems.push(`it is ${n} words; write at least ${words.min}`)
  if (n > words.max) problems.push(`it is ${n} words; the most is ${words.max}`)
  return [...problems, ...ruleProblems(text)]
}
