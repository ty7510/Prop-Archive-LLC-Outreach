// 2026-10-25, Theo: "make sure when AI auto generates the document for printing for the regular
// print out it never generates it to be too long for the document format". The part Claude writes
// is sized to the room the rest of the page leaves, checked against the page before it is kept,
// and cut at whole sentences when it still runs long. The fit model these tests lean on was checked
// against Chrome on 500 random pages at every size the print page tries: it was never shorter.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRINTOUT_BIO,
  DEFAULT_PRINTOUT_CLOSING,
  DEFAULT_PRINTOUT_OVERVIEW,
  PRINTOUT_CSS,
  PRINTOUT_FIT_SCRIPT,
  PRINTOUT_LIMITS,
} from '../../shared/printout.ts'
import {
  bodyRoom,
  FIT_SIZES,
  fitsAt,
  fittedSize,
  FLOW,
  FLOW_ROOM,
  FLOW_WIDTH,
  flowHeight,
  lineCount,
  PAGE,
  PLANNED_SIZE,
  textWidth,
} from '../../shared/printoutFit.ts'
import { copyProblems } from './copyRules.ts'
import type { Llm } from './deps.ts'
import {
  FALLBACK_PRINTOUT,
  fitPrintoutText,
  printoutFits,
  printoutWordPlan,
  writePrintout,
  type PrintoutPage,
} from './printout.ts'

const DEFAULT_PAGE: PrintoutPage = {
  heading: 'How Prop Archive can help Fairmount Rentals',
  overview: DEFAULT_PRINTOUT_OVERVIEW,
  bio: DEFAULT_PRINTOUT_BIO,
  closing: DEFAULT_PRINTOUT_CLOSING,
  ownerName: 'Theo Young',
  photo: true,
}

/** Theo's Settings at the longest the Settings page lets them be. */
const stretch = (text: string, max: number) => {
  let out = text
  while (out.length < max) out = `${out} ${text}`
  return out.slice(0, max).replace(/\s+\S*$/, '.')
}
const LONG_PAGE: PrintoutPage = {
  ...DEFAULT_PAGE,
  overview: stretch(DEFAULT_PRINTOUT_OVERVIEW, PRINTOUT_LIMITS.overview),
  bio: stretch(DEFAULT_PRINTOUT_BIO, PRINTOUT_LIMITS.bio),
  closing: stretch(DEFAULT_PRINTOUT_CLOSING, PRINTOUT_LIMITS.closing),
}

/** A plain sentence of Theo's copy, many times over: words that pass the house rules. */
const SENTENCES = Object.values(FALLBACK_PRINTOUT)
  .join(' ')
  .split(/(?<=[.!?])\s+/)
function wordsOf(count: number): string {
  const out: string[] = []
  for (let i = 0; out.join(' ').split(/\s+/).length < count; i++) {
    out.push(SENTENCES[i % SENTENCES.length]!)
  }
  const half = Math.ceil(out.length / 2)
  return `${out.slice(0, half).join(' ')}\n\n${out.slice(half).join(' ')}`
}

/** Exactly `count` words of Theo's copy in two paragraphs, ending in a full stop. */
function exactWords(count: number): string {
  const words = wordsOf(count + 40)
    .replace(/\n+/g, ' ')
    .split(/\s+/)
    .slice(0, count)
  const half = Math.ceil(count / 2)
  const end = (w: string[]) => `${w.join(' ').replace(/[.,!?]?$/, '')}.`
  return `${end(words.slice(0, half))}\n\n${end(words.slice(half))}`
}

function fakeLlm(texts: string[]): Llm & { prompts: string[]; systems: string[] } {
  const prompts: string[] = []
  const systems: string[] = []
  return {
    prompts,
    systems,
    async text(prompt, opts) {
      prompts.push(prompt)
      systems.push(opts.system ?? '')
      return texts.shift() ?? null
    },
  } as Llm & { prompts: string[]; systems: string[] }
}

const lead = { persona: 'maya' as const, owner_kind: 'person' as const, enrichment: {} }
const vars = { first_name: 'Dana', full_name: 'Dana Smith', company: 'Fairmount Rentals' }

/** One rule's declarations in PRINTOUT_CSS, spaces squeezed. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(PRINTOUT_CSS)
  if (!match) throw new Error(`no rule for ${selector}`)
  return match[1]!.replace(/\s+/g, ' ')
}

describe('the fit model keeps in step with the printout page', () => {
  it('has the page geometry PRINTOUT_CSS draws', () => {
    expect(rule('.onepager')).toContain('width: 8.5in; height: 10.98in;')
    expect(rule('.op-head')).toContain('height: 1.62in;')
    expect(rule('.op-rule')).toContain('height: 0.13in;')
    expect(rule('.op-foot')).toContain('height: 0.66in;')
    expect(rule('.op-flow')).toContain(
      'gap: 0.95em; padding: 0.2in 0.47in 0.16in; font-size: 11.5pt; line-height: 1.42;',
    )
    expect(rule('.op-flow p')).toContain('margin: 0 0 0.55em;')
    expect(rule('.op-h')).toContain('margin: 0 0 0.75em; padding-bottom: 0.32em;')
    expect(rule('.op-h')).toContain('font: 700 1.55em/1.18')
    expect(rule('.op-stats')).toContain('gap: 0.6em; margin-top: 0.9em;')
    expect(rule('.op-stat')).toContain('border: 1px solid')
    expect(rule('.op-stat')).toContain('padding: 0.85em 0.4em 0.75em;')
    expect(rule('.op-stat b')).toContain('font-size: 1.08em; line-height: 1.2;')
    expect(rule('.op-stat i')).toContain('height: 2px; margin: 0.6em auto;')
    expect(rule('.op-stat span')).toContain('font-size: 0.78em; line-height: 1.3;')
    expect(rule('.op-divider')).toContain('border-top: 2px solid')
    expect(rule('.op-bio')).toContain('gap: 1.6em;')
    expect(rule('.op-photo')).toContain('width: 11em; height: 12.3em;')
    expect(rule('.op-bio-name')).toContain('margin: 0 0 0.5em; font: 700 1.15em/1.25')
    expect(rule('.op-line')).toContain('height: 0.4in;')
    expect(rule('.op-name')).toContain('font-size: 0.9em; line-height: 1.35;')
    // The model's numbers are the same ones.
    expect([PAGE.width, PAGE.height, PAGE.band, PAGE.rule, PAGE.foot]).toEqual(
      [8.5, 10.98, 1.62, 0.13, 0.66].map((inches) => inches * 72),
    )
    expect([FLOW.lineHeight, FLOW.paragraphGap, FLOW.blockGap]).toEqual([1.42, 0.55, 0.95])
  })

  it('tries the sizes the print page tries, and counts a page too long past one pixel', () => {
    expect(PRINTOUT_FIT_SCRIPT).toContain('var size = 11.5;')
    expect(PRINTOUT_FIT_SCRIPT).toContain('size > 8.5')
    expect(PRINTOUT_FIT_SCRIPT).toContain('size -= 0.25;')
    expect(PRINTOUT_FIT_SCRIPT).toContain('flow.scrollHeight > flow.clientHeight + 1')
    expect(FIT_SIZES[0]).toBe(11.5)
    expect(FIT_SIZES.at(-1)).toBe(8.5)
    expect(FIT_SIZES).toHaveLength(13)
    expect(FLOW_ROOM).toBeCloseTo(8.21 * 72 + 0.75)
  })
})

describe('the fit model', () => {
  it('measures and wraps like Chrome, erring wide', () => {
    // Roboto at 10 pt, 6% wide for Chrome on Linux.
    expect(textWidth('Prop Archive', 10)).toBeGreaterThan(55)
    expect(textWidth('Prop Archive', 10)).toBeLessThan(65)
    expect(lineCount('', 10, FLOW_WIDTH)).toBe(1)
    expect(lineCount('One short line.', 10, FLOW_WIDTH)).toBe(1)
    expect(lineCount('One\nTwo', 10, FLOW_WIDTH)).toBe(2)
    const long = wordsOf(120).replace(/\n+/g, ' ')
    const lines = lineCount(long, 10, FLOW_WIDTH)
    expect(lines).toBeGreaterThan(6)
    expect(lines).toBeLessThan(12)
    // Smaller type, fewer lines.
    expect(lineCount(long, 8.5, FLOW_WIDTH)).toBeLessThanOrEqual(lines)
  })

  it('fits the default page with as many words as it plans for, at 10 pt or larger', () => {
    const plan = printoutWordPlan(DEFAULT_PAGE)
    const page = { ...DEFAULT_PAGE, body: exactWords(plan.words.max) }
    expect(fitsAt(page, PLANNED_SIZE)).toBe(true)
    expect(fittedSize(page)).toBeGreaterThanOrEqual(PLANNED_SIZE)
    // The flow only grows with more words.
    expect(flowHeight({ ...page, body: wordsOf(300) }, 10)).toBeGreaterThan(flowHeight(page, 10))
    // Counting letters the widest any Chrome sets them only makes the page longer.
    expect(flowHeight(page, 10, 'widest')).toBeGreaterThanOrEqual(flowHeight(page, 10))
  })

  it('leaves less room for the part as the rest of the page grows', () => {
    const roomy = bodyRoom({ ...DEFAULT_PAGE, photo: false }, PLANNED_SIZE)
    const photo = bodyRoom(DEFAULT_PAGE, PLANNED_SIZE)
    const tight = bodyRoom(LONG_PAGE, PLANNED_SIZE)
    expect(roomy.words).toBeGreaterThanOrEqual(140)
    expect(photo.words).toBeLessThan(roomy.words)
    expect(photo.words).toBeGreaterThanOrEqual(90)
    expect(tight.words).toBeLessThan(photo.words)
    expect(tight.lines).toBeLessThan(photo.lines)
  })
})

describe('the part Claude writes is sized to the page', () => {
  it('asks for up to 140 words when the page has room for them', () => {
    expect(printoutWordPlan({ ...DEFAULT_PAGE, photo: false })).toEqual({
      size: 10,
      words: { min: 80, max: 140 },
    })
    // Theo's photo narrows the About column, which leaves fewer words for the part.
    const plan = printoutWordPlan(DEFAULT_PAGE)
    expect(plan.size).toBe(10)
    expect(plan.words.max).toBeGreaterThanOrEqual(90)
    expect(plan.words.max).toBeLessThan(140)
  })

  it('asks for fewer words, or plans smaller type, when Settings run long', () => {
    const plan = printoutWordPlan(LONG_PAGE)
    expect(plan.words.max).toBeLessThan(140)
    expect(plan.words.max).toBeGreaterThanOrEqual(25)
    expect(plan.size).toBeLessThanOrEqual(PLANNED_SIZE)
    expect(plan.size).toBeGreaterThanOrEqual(8.5)
    // The most it asks for fits.
    expect(printoutFits(LONG_PAGE, exactWords(plan.words.max), plan.size)).toBe(true)
  })

  it('says there is no room when Settings alone fill the page', () => {
    const full = {
      ...LONG_PAGE,
      overview: `${LONG_PAGE.overview}\n\n${LONG_PAGE.overview}\n\n${LONG_PAGE.overview}`,
    }
    expect(printoutWordPlan(full).words.max).toBeLessThan(25)
  })

  it('cuts a part that runs long at whole sentences until the page fits', () => {
    const long = wordsOf(400)
    expect(fitsAt({ ...DEFAULT_PAGE, body: long }, PLANNED_SIZE)).toBe(false)
    const cut = fitPrintoutText(long, DEFAULT_PAGE, PLANNED_SIZE)
    expect(printoutFits(DEFAULT_PAGE, cut, PLANNED_SIZE)).toBe(true)
    expect(cut.length).toBeGreaterThan(200)
    expect(long.startsWith(cut.split('\n\n')[0]!)).toBe(true)
    expect(cut).toMatch(/[.!?]$/)
    // A part that fits is left as it is.
    const fine = wordsOf(90)
    expect(fitPrintoutText(fine, DEFAULT_PAGE, PLANNED_SIZE)).toBe(fine)
  })

  it("fits every one of Theo's fallback parts, even with long Settings", () => {
    for (const page of [DEFAULT_PAGE, LONG_PAGE]) {
      const plan = printoutWordPlan(page)
      for (const text of Object.values(FALLBACK_PRINTOUT)) {
        const fitted = fitPrintoutText(text, page, plan.size)
        expect(printoutFits(page, fitted, plan.size)).toBe(true)
      }
    }
  })

  it('tells Claude the word range for this page', async () => {
    const llm = fakeLlm([wordsOf(100)])
    await writePrintout(lead, vars, llm, LONG_PAGE)
    const plan = printoutWordPlan(LONG_PAGE)
    expect(llm.systems[0]).toContain(`${plan.words.min} to ${plan.words.max} words`)
    expect(llm.systems[0]).not.toContain('{words}')
  })

  it('sends a part that runs past the page back once, then keeps the shorter one', async () => {
    const tooLong = wordsOf(400)
    const good = wordsOf(100)
    const llm = fakeLlm([tooLong, good])
    expect(await writePrintout(lead, vars, llm, DEFAULT_PAGE)).toBe(good)
    expect(llm.prompts[1]).toContain('too long for the page')
    expect(llm.prompts[1]).toContain(`at most ${printoutWordPlan(DEFAULT_PAGE).words.max} words`)
  })

  it('cuts a second try that still runs long instead of printing past the page', async () => {
    const llm = fakeLlm([wordsOf(400), wordsOf(380)])
    const out = await writePrintout(lead, vars, llm, LONG_PAGE)
    expect(out).not.toBeNull()
    const plan = printoutWordPlan(LONG_PAGE)
    expect(printoutFits(LONG_PAGE, out!, plan.size)).toBe(true)
    expect(copyProblems(out!, { min: 25, max: plan.words.max + 20 })).toEqual([])
  })

  it('never calls Claude when the page has no room for a part', async () => {
    const full = {
      ...LONG_PAGE,
      overview: `${LONG_PAGE.overview}\n\n${LONG_PAGE.overview}\n\n${LONG_PAGE.overview}`,
    }
    const llm = fakeLlm([wordsOf(100)])
    expect(await writePrintout(lead, vars, llm, full)).toBeNull()
    expect(llm.prompts).toHaveLength(0)
  })
})
