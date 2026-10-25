// 2026-10-25, Theo: "make sure when AI auto generates the document for printing for the regular
// print out it never generates it to be too long for the document format", then "two pages with the
// full spiel, with a bio and a specified message to them". Page one is the letter written for each
// person with about Theo under it; page two is what Prop Archive is and what you get. The part Claude
// writes is sized to the room page one leaves, checked against the page before it is kept, and cut
// at whole sentences when it still runs long. The fit model these tests lean on was checked against
// Chrome on random pages at every size the print page tries: counting letters the widest any Chrome
// sets them, it was never shorter.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRINTOUT_BIO,
  DEFAULT_PRINTOUT_CLOSING,
  DEFAULT_PRINTOUT_FEATURES,
  DEFAULT_PRINTOUT_OVERVIEW,
  featureItems,
  PRINTOUT_CSS,
  PRINTOUT_FIT_SCRIPT,
  PRINTOUT_LIMITS,
  printoutSection,
} from '../../shared/printout.ts'
import {
  bodyRoom,
  FIT_SIZES,
  fitsInAnyChrome,
  fittedSize,
  FLOW,
  FLOW_ROOM,
  FLOW_WIDTH,
  flowHeight,
  flowRoom,
  lineCount,
  PAGE,
  pageFitsAt,
  pageTwoSize,
  PLANNED_SIZE,
  textWidth,
} from '../../shared/printoutFit.ts'
import { copyProblems, ruleProblems } from './copyRules.ts'
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
  features: DEFAULT_PRINTOUT_FEATURES,
  bio: DEFAULT_PRINTOUT_BIO,
  closing: DEFAULT_PRINTOUT_CLOSING,
  ownerName: 'Theo Young',
  photo: true,
}

/** Theo's Settings at the longest the Settings page lets them be. */
const stretch = (text: string, max: number) => {
  let out = text
  while (out.length < max) out = `${out}\n\n${text}`
  return out.slice(0, max).replace(/\s+\S*$/, '.')
}
const LONG_PAGE: PrintoutPage = {
  ...DEFAULT_PAGE,
  overview: stretch(DEFAULT_PRINTOUT_OVERVIEW, PRINTOUT_LIMITS.overview),
  features: stretch(DEFAULT_PRINTOUT_FEATURES, PRINTOUT_LIMITS.features),
  bio: stretch(DEFAULT_PRINTOUT_BIO, PRINTOUT_LIMITS.bio),
  closing: stretch(DEFAULT_PRINTOUT_CLOSING, PRINTOUT_LIMITS.closing),
}
/** Far past what Settings allows: page one has no room for a part of its own. */
const FULL_PAGE: PrintoutPage = {
  ...LONG_PAGE,
  closing: [1, 2, 3, 4].map(() => LONG_PAGE.bio).join('\n\n'),
}

/** Plain sentences of Theo's copy, many times over: words that pass the house rules. */
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

describe('the fit model keeps in step with the printout pages', () => {
  it('has the page geometry PRINTOUT_CSS draws', () => {
    expect(rule('.onepager')).toContain('width: 8.5in; height: 10.98in;')
    expect(rule('.op-head')).toContain('height: 1.62in;')
    expect(rule('.op-head2')).toContain('height: 0.8in;')
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
    expect(rule('.op-features')).toContain('grid-template-columns: 1fr 1fr; gap: 1em 1.5em;')
    expect(rule('.op-feature')).toContain(
      'border-left: 3px solid var(--op-sky); padding-left: 0.75em;',
    )
    expect(rule('.op-feature b')).toContain(
      'margin-bottom: 0.2em; font-weight: 700; font-size: 1.05em; line-height: 1.25;',
    )
    expect(rule('.op-feature span')).toContain('font-size: 0.95em; line-height: 1.42;')
    expect(rule('.op-divider')).toContain('border-top: 2px solid')
    expect(rule('.op-bio')).toContain('gap: 1.6em;')
    expect(rule('.op-photo')).toContain('width: 11em; height: 12.3em;')
    expect(rule('.op-bio-name')).toContain('margin: 0 0 0.5em; font: 700 1.15em/1.25')
    expect(rule('.op-line')).toContain('height: 0.4in;')
    expect(rule('.op-name')).toContain('font-size: 0.9em; line-height: 1.35;')
    // The model's numbers are the same ones.
    expect([PAGE.width, PAGE.height, PAGE.band, PAGE.band2, PAGE.rule, PAGE.foot]).toEqual(
      [8.5, 10.98, 1.62, 0.8, 0.13, 0.66].map((inches) => inches * 72),
    )
    expect([FLOW.lineHeight, FLOW.paragraphGap, FLOW.blockGap]).toEqual([1.42, 0.55, 0.95])
  })

  it('tries the sizes the print page tries, each page on its own, too long past one pixel', () => {
    expect(PRINTOUT_FIT_SCRIPT).toContain('var size = 11.5;')
    expect(PRINTOUT_FIT_SCRIPT).toContain('size > 8.5')
    expect(PRINTOUT_FIT_SCRIPT).toContain('size -= 0.25;')
    expect(PRINTOUT_FIT_SCRIPT).toContain('flow.scrollHeight > flow.clientHeight + 1')
    expect(FIT_SIZES[0]).toBe(11.5)
    expect(FIT_SIZES.at(-1)).toBe(8.5)
    expect(FIT_SIZES).toHaveLength(13)
    expect(FLOW_ROOM).toBeCloseTo(8.21 * 72 + 0.75)
    expect(flowRoom(2)).toBeCloseTo(9.03 * 72 + 0.75)
  })

  it('draws the blocks the model counts, on the pages it counts them', () => {
    const html = printoutSection({
      ...DEFAULT_PAGE,
      body: 'Hello.',
      photo: undefined,
      preparedFor: ['Dana Smith'],
      date: 'October 25, 2026',
      email: 'theo@proparchive.biz',
      site: 'proparchive.app',
    })
    const [one, two] = html.split(/<section class="onepager">/).slice(1)
    expect(one).toContain('class="op-them"')
    expect(one).toContain('class="op-close"')
    expect(one).toContain('class="op-sign"')
    expect(one).toContain('class="op-divider"')
    expect(one).toContain('class="op-about"')
    expect(one).not.toContain('class="op-what"')
    expect(two).toContain('class="op-what"')
    expect(two).toContain('class="op-get"')
    expect(two!.match(/class="op-feature"/g)).toHaveLength(6)
    expect(two).not.toContain('class="op-about"')
  })
})

describe('the fit model', () => {
  it('measures and wraps like Chrome, erring wide', () => {
    // Roboto at 10 pt.
    expect(textWidth('Prop Archive', 10)).toBeGreaterThan(55)
    expect(textWidth('Prop Archive', 10)).toBeLessThan(62)
    expect(textWidth('Prop Archive', 10, 400, 'widest')).toBeCloseTo(
      textWidth('Prop Archive', 10) * 1.06,
    )
    expect(lineCount('', 10, FLOW_WIDTH)).toBe(1)
    expect(lineCount('One short line.', 10, FLOW_WIDTH)).toBe(1)
    expect(lineCount('One\nTwo', 10, FLOW_WIDTH)).toBe(2)
    const long = wordsOf(120).replace(/\n+/g, ' ')
    const lines = lineCount(long, 10, FLOW_WIDTH)
    expect(lines).toBeGreaterThan(5)
    expect(lines).toBeLessThan(12)
    // Smaller type, never more lines.
    expect(lineCount(long, 8.5, FLOW_WIDTH)).toBeLessThanOrEqual(lines)
  })

  it('splits what you get into a bold title and the line under it', () => {
    const items = featureItems(DEFAULT_PRINTOUT_FEATURES)
    expect(items).toHaveLength(6)
    expect(items[0]).toEqual({
      title: 'Your morning on one screen',
      text: expect.stringContaining('Late rent, open repairs'),
    })
    expect(featureItems('Just a title.')).toEqual([{ title: 'Just a title', text: '' }])
    expect(featureItems('  \n\n ')).toEqual([])
    expect(ruleProblems(DEFAULT_PRINTOUT_FEATURES)).toEqual([])
  })

  it("fits both of Theo's default pages at the largest size, a full part included", () => {
    const parts = { ...DEFAULT_PAGE, body: exactWords(140) }
    expect(fittedSize(parts, 1)).toBe(11.5)
    expect(fittedSize(parts, 2)).toBe(11.5)
    expect(fitsInAnyChrome(parts)).toBe(true)
    // More words only make page one longer; page two never changes with them.
    expect(flowHeight({ ...parts, body: wordsOf(300) }, 10)).toBeGreaterThan(flowHeight(parts, 10))
    expect(flowHeight({ ...parts, body: wordsOf(300) }, 10, 'exact', 2)).toBe(
      flowHeight(parts, 10, 'exact', 2),
    )
    // Counting letters the widest any Chrome sets them only makes a page longer.
    expect(flowHeight(parts, 10, 'widest')).toBeGreaterThanOrEqual(flowHeight(parts, 10))
  })

  it('fits page two with Settings at their longest, in smaller type', () => {
    const size = pageTwoSize(LONG_PAGE)
    expect(size).not.toBeNull()
    expect(size!).toBeLessThan(11.5)
    expect(size!).toBeGreaterThanOrEqual(8.5)
    expect(pageFitsAt({ ...LONG_PAGE, body: '' }, 8.5, 2, 'widest')).toBe(true)
  })

  it('leaves less room on page one as the closing and bio grow', () => {
    const roomy = bodyRoom({ ...DEFAULT_PAGE, photo: false }, PLANNED_SIZE)
    const photo = bodyRoom(DEFAULT_PAGE, PLANNED_SIZE)
    const tight = bodyRoom(LONG_PAGE, PLANNED_SIZE)
    expect(roomy.words).toBeGreaterThanOrEqual(140)
    expect(photo.words).toBeGreaterThanOrEqual(140)
    expect(photo.lines).toBeLessThanOrEqual(roomy.lines)
    expect(tight.lines).toBeLessThan(photo.lines)
    expect(bodyRoom(FULL_PAGE, PLANNED_SIZE).words).toBeLessThan(25)
  })
})

describe('the part Claude writes is sized to page one', () => {
  it('asks for up to 140 words when the page has room for them', () => {
    expect(printoutWordPlan(DEFAULT_PAGE)).toEqual({ size: 10, words: { min: 80, max: 140 } })
    expect(printoutWordPlan(LONG_PAGE)).toEqual({ size: 10, words: { min: 80, max: 140 } })
  })

  it('says there is no room when the rest of page one fills it', () => {
    expect(printoutWordPlan(FULL_PAGE).words.max).toBeLessThan(25)
  })

  it('page two never decides whether the part fits', () => {
    const crowded = {
      ...DEFAULT_PAGE,
      overview: [1, 2, 3, 4].map(() => LONG_PAGE.overview).join('\n\n'),
    }
    expect(pageTwoSize(crowded)).toBeNull()
    const part = exactWords(120)
    expect(printoutFits(crowded, part, PLANNED_SIZE)).toBe(true)
    expect(fitPrintoutText(part, crowded, PLANNED_SIZE)).toBe(part)
  })

  it('cuts a part that runs long at whole sentences until page one fits', () => {
    const long = wordsOf(600)
    expect(printoutFits(LONG_PAGE, long, PLANNED_SIZE)).toBe(false)
    const cut = fitPrintoutText(long, LONG_PAGE, PLANNED_SIZE)
    expect(printoutFits(LONG_PAGE, cut, PLANNED_SIZE)).toBe(true)
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
        expect(fitted).toBe(text)
        expect(printoutFits(page, fitted, plan.size)).toBe(true)
      }
    }
  })

  it('tells Claude the word range and what the two pages already say', async () => {
    const llm = fakeLlm([wordsOf(100)])
    await writePrintout(lead, vars, llm, LONG_PAGE)
    const plan = printoutWordPlan(LONG_PAGE)
    expect(llm.systems[0]).toContain(`${plan.words.min} to ${plan.words.max} words`)
    expect(llm.systems[0]).not.toContain('{words}')
    expect(llm.systems[0]).toContain('two-page')
    expect(llm.systems[0]).toContain('page two has an overview of Prop Archive and what it does')
  })

  it('sends a part that runs past the page back once, then keeps the shorter one', async () => {
    const tooLong = wordsOf(600)
    const good = wordsOf(100)
    const llm = fakeLlm([tooLong, good])
    expect(await writePrintout(lead, vars, llm, LONG_PAGE)).toBe(good)
    expect(llm.prompts[1]).toContain('too long for the page')
    expect(llm.prompts[1]).toContain(`at most ${printoutWordPlan(LONG_PAGE).words.max} words`)
  })

  it('cuts a second try that still runs long instead of printing past the page', async () => {
    const llm = fakeLlm([wordsOf(200), wordsOf(190)])
    const out = await writePrintout(lead, vars, llm, LONG_PAGE)
    expect(out).not.toBeNull()
    const plan = printoutWordPlan(LONG_PAGE)
    expect(printoutFits(LONG_PAGE, out!, plan.size)).toBe(true)
    expect(out!.split(/\n\s*\n/)).toHaveLength(2)
    expect(copyProblems(out!, { min: 70, max: plan.words.max + 20 })).toEqual([])
  })

  it("uses Theo's own words when cutting would leave half a part", async () => {
    // Far too long twice: the cut would keep only their problem, never what changes for them.
    const llm = fakeLlm([wordsOf(600), wordsOf(580)])
    expect(await writePrintout(lead, vars, llm, LONG_PAGE)).toBeNull()
  })

  it('never calls Claude when page one has no room for a part', async () => {
    const llm = fakeLlm([wordsOf(100)])
    expect(await writePrintout(lead, vars, llm, FULL_PAGE)).toBeNull()
    expect(llm.prompts).toHaveLength(0)
  })
})
