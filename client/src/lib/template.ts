// Template variables (spec section 10) and a local renderer used for the draft preview in the
// sequence editor. The server render is the source of truth; this only shows unsaved edits.

export interface TemplateVar {
  name: string
  hint: string
}

export const TEMPLATE_VARS: TemplateVar[] = [
  { name: 'first_name', hint: 'First name, or a plain greeting word when unknown' },
  { name: 'full_name', hint: 'Full name' },
  { name: 'company', hint: 'LLC or business name' },
  { name: 'property_count', hint: 'Number of properties' },
  { name: 'unit_count', hint: 'Number of units' },
  { name: 'neighborhood', hint: 'Neighbourhood from the first zip' },
  { name: 'trigger_line', hint: 'One sentence about the trigger, empty when none' },
  { name: 'ai_opener', hint: 'One AI written first line (needs the Anthropic key)' },
  { name: 'demo_link', hint: 'Tracked link to the demo page' },
  { name: 'beta_link', hint: 'Tracked link to join the beta' },
  { name: 'site_link', hint: 'Tracked link to the site' },
  { name: 'sender_name', hint: 'Your from name' },
  { name: 'unsubscribe_link', hint: 'One click unsubscribe (email only)' },
]

export const SAMPLE_VARS: Record<string, string> = {
  first_name: 'Maya',
  full_name: 'Maya Rivera',
  company: 'Rivera Holdings LLC',
  property_count: '4',
  unit_count: '9',
  neighborhood: 'West Philly',
  trigger_line: 'I saw a new rental license on 52nd Street last month.',
  ai_opener: 'Four rentals in West Philly is a lot of paper to keep straight.',
  demo_link: 'https://proparchive.app/demo',
  beta_link: 'https://proparchive.app/?beta=1',
  site_link: 'https://proparchive.app',
  sender_name: 'Theo at Prop Archive',
  unsubscribe_link: 'https://outreach.example/u/sample',
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Replace {{vars}} with values. Unknown vars render empty and are reported in `missing`. */
export function renderTemplate(
  body: string,
  vars: Record<string, string> = SAMPLE_VARS,
): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = body.replace(VAR_RE, (_m, name: string) => {
    if (name in vars) return vars[name] ?? ''
    if (!missing.includes(name)) missing.push(name)
    return ''
  })
  return { text, missing }
}

/** Variable names used in a body, in order of first appearance. */
export function varsUsed(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(VAR_RE)) {
    const name = m[1]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** Insert text at a caret position; returns the new string and where the caret should land. */
export function insertAt(
  text: string,
  insert: string,
  start: number,
  end: number = start,
): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length))
  const e = Math.max(s, Math.min(end, text.length))
  const next = text.slice(0, s) + insert + text.slice(e)
  return { text: next, caret: s + insert.length }
}
