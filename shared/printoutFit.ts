// How full the two printout pages are, worked out without a browser: the same page geometry as
// PRINTOUT_CSS (shared/printout.ts) and Roboto's widths (printoutFontWidths.ts), line by line. Page
// one is the letter written for each person with about Theo under it; page two is what Prop Archive
// is and what you get. The server uses this to size the part Claude writes to the room page one
// leaves (Theo, 2026-10-25: "make sure when AI auto generates the document for printing ... it never
// generates it to be too long for the document format"); Settings uses it to say how much room the
// closing and bio leave and whether page two fits at a comfortable size. The print page's fit
// script stays the last word in the browser.
//
// It errs long, never short: kerning and breaks after hyphens are left out, so a paragraph here is
// never narrower or shorter than Chrome on Windows or a Mac sets it, and 'widest' covers Chrome on
// Linux too (checked against Chrome on random pages at every size the fit script tries: never
// shorter). printoutFit.test.ts keeps these numbers in step with PRINTOUT_CSS; change one and the
// test says to change the other.

import {
  DEFAULT_PRINTOUT_BIO,
  DEFAULT_PRINTOUT_OVERVIEW,
  featureItems,
  PRINTOUT_STATS,
} from './printout.ts'
import { ROBOTO_CHARS, ROBOTO_WIDTHS } from './printoutFontWidths.ts'

/** What decides how full the pages are. The bands and footers are fixed and play no part. */
export interface PrintoutFitParts {
  heading: string
  body: string
  overview: string
  /** Page two's "What you get", one item per paragraph. */
  features: string
  bio: string
  closing: string
  ownerName: string
  /** Theo's photo is on page one: the bio runs beside it, in a narrower column. */
  photo: boolean
}

/** What decides how full page one is. */
export type PageOneParts = Pick<
  PrintoutFitParts,
  'heading' | 'body' | 'closing' | 'bio' | 'ownerName' | 'photo'
>
/** What decides how full page two is. */
export type PageTwoParts = Pick<PrintoutFitParts, 'overview' | 'features'>

/** Page one (the letter written for them, about Theo) or page two (what Prop Archive is, what you get). */
export type PageNumber = 1 | 2

type Weight = 400 | 500 | 700

const PT_PER_IN = 72
const PX = 0.75

/**
 * The pages in points, from PRINTOUT_CSS. Each flow is what is left of the 10.98 in page under its
 * band (1.62 in on page one, 0.8 in on page two) and the rule (0.13 in) and over the footer
 * (0.66 in), less its padding. The fit script calls a page too long once its flow overflows by more
 * than a pixel.
 */
export const PAGE = {
  width: 8.5 * PT_PER_IN,
  height: 10.98 * PT_PER_IN,
  band: 1.62 * PT_PER_IN,
  band2: 0.8 * PT_PER_IN,
  rule: 0.13 * PT_PER_IN,
  foot: 0.66 * PT_PER_IN,
  padTop: 0.2 * PT_PER_IN,
  padBottom: 0.16 * PT_PER_IN,
  padSide: 0.47 * PT_PER_IN,
} as const

/** The flow's text column, in points. */
export const FLOW_WIDTH = PAGE.width - 2 * PAGE.padSide

/** The height each page's flow contents may take before the page counts as too long, in points. */
export function flowRoom(page: PageNumber): number {
  const band = page === 1 ? PAGE.band : PAGE.band2
  return PAGE.height - band - PAGE.rule - PAGE.foot - PAGE.padTop - PAGE.padBottom + PX
}

/** Page one's room: the letter, where the part written for them goes. */
export const FLOW_ROOM = flowRoom(1)

/**
 * The flow's type, in ems of its font size, from PRINTOUT_CSS: line heights, margins, the gap
 * between its blocks, the headings, the fact boxes, what you get, the photo and the signature.
 */
export const FLOW = {
  lineHeight: 1.42,
  paragraphGap: 0.55,
  blockGap: 0.95,
  heading: { size: 1.55, lineHeight: 1.18, padBottom: 0.32, marginBottom: 0.75 },
  stats: { marginTop: 0.9, gap: 0.6, padTop: 0.85, padBottom: 0.75, padSide: 0.4, border: PX },
  statValue: { size: 1.08, lineHeight: 1.2 },
  statBar: { height: 2 * PX, margin: 0.6 },
  statLabel: { size: 0.78, lineHeight: 1.3 },
  features: { rowGap: 1, columnGap: 1.5, bar: 3 * PX, pad: 0.75 },
  featureTitle: { size: 1.05, lineHeight: 1.25, marginBottom: 0.2 },
  featureText: { size: 0.95, lineHeight: 1.42 },
  divider: 2 * PX,
  photo: { width: 11, height: 12.3, gap: 1.6 },
  bioName: { size: 1.15, lineHeight: 1.25, marginBottom: 0.5 },
  sign: { line: 0.4 * PT_PER_IN, nameSize: 0.9, nameLineHeight: 1.35 },
} as const

/** The sizes the print page's fit script tries, largest first, in points (11.5 down to 8.5). */
export const FIT_SIZES: readonly number[] = Array.from({ length: 13 }, (_, i) => 11.5 - i * 0.25)
export const LARGEST_SIZE = 11.5
export const SMALLEST_SIZE = 8.5
/**
 * The size the part Claude writes is planned for: the letter fits at 10 pt or larger, which reads
 * comfortably, and the fit script still has room to go smaller if Chrome sets it longer.
 */
export const PLANNED_SIZE = 10

const widths = new Map<Weight, Map<string, number>>(
  ([400, 500, 700] as const).map((w) => [
    w,
    new Map([...ROBOTO_CHARS].map((ch, i) => [ch, ROBOTO_WIDTHS[w][i] ?? 1000])),
  ]),
)

/**
 * How much wider than Roboto's exact widths Chrome on Linux may set a line: it hints letters to
 * the pixel, which at some sizes sets a line up to 6% wider (measured at every eighth of a point
 * from 8.5 to 11.5, 2026-10-25). Chrome on Windows and on a Mac places letters at their exact widths,
 * less kerning, so 'exact' is what Theo's printer gets and 'widest' is the most any Chrome sets.
 */
export const WIDTH_ALLOWANCE = 1.06

/** How letters are counted: as Chrome on Windows and Macs sets them, or the widest any Chrome does. */
export type Measure = 'exact' | 'widest'

const ALLOWANCE: Record<Measure, number> = { exact: 1, widest: WIDTH_ALLOWANCE }

/** Width of `text` at `size` pt, in points. A letter Roboto lacks counts as a full em. */
export function textWidth(
  text: string,
  size: number,
  weight: Weight = 400,
  measure: Measure = 'exact',
): number {
  const table = widths.get(weight)!
  let w = 0
  for (const ch of text) w += table.get(ch) ?? 1000
  return (w / 1000) * size * ALLOWANCE[measure]
}

/**
 * How many lines `text` takes in a column `width` points wide at `size` pt: each line filled
 * word by word, as Chrome fills it, breaking only at spaces. A single line break stays a break.
 */
export function lineCount(
  text: string,
  size: number,
  width: number,
  weight: Weight = 400,
  measure: Measure = 'exact',
): number {
  const space = textWidth(' ', size, weight, measure)
  let lines = 0
  for (const hard of text.split('\n')) {
    const words = hard.split(/\s+/).filter(Boolean)
    lines += 1
    let used = 0
    for (const word of words) {
      const w = textWidth(word, size, weight, measure)
      if (used === 0) used = w
      else if (used + space + w <= width + 1e-6) used += space + w
      else {
        lines += 1
        used = w
      }
    }
  }
  return lines
}

/** The paragraphs of a part, as paragraphsHtml splits them. */
function paragraphs(text: string): string[] {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Lines and heights at one size and measure: the pieces both pages are built from. */
function typesetter(size: number, measure: Measure) {
  const lines = (text: string, at: number, width: number, weight: Weight = 400) =>
    lineCount(text, at, width, weight, measure)
  return {
    lines,
    /**
     * A run of paragraphs. The last one keeps its bottom margin when something follows it in the
     * same block (`lastMargin`).
     */
    run(text: string, width: number, lastMargin = false): number {
      const list = paragraphs(text)
      if (list.length === 0) return 0
      const count = list.reduce((n, para) => n + lines(para, size, width), 0)
      const gaps = list.length - (lastMargin ? 0 : 1)
      return count * FLOW.lineHeight * size + gaps * FLOW.paragraphGap * size
    },
    heading(text: string): number {
      const h = FLOW.heading
      const own = h.size * size
      const count = text.trim() ? lines(text, own, FLOW_WIDTH, 700) : 1
      return count * h.lineHeight * own + h.padBottom * own + h.marginBottom * own
    },
  }
}

/** About Theo at `size` pt, in points: the heading, his name and role, the bio beside his photo. */
function aboutHeight(
  p: Pick<PrintoutFitParts, 'bio' | 'ownerName' | 'photo'>,
  size: number,
  t: ReturnType<typeof typesetter>,
): number {
  const ph = FLOW.photo
  const bioWidth = p.photo ? FLOW_WIDTH - (ph.width + ph.gap) * size : FLOW_WIDTH
  const owner = p.ownerName.trim()
  const nameSize = FLOW.bioName.size * size
  const name = owner
    ? t.lines(`${owner}, Founder & CEO`, nameSize, bioWidth, 700) *
        FLOW.bioName.lineHeight *
        nameSize +
      FLOW.bioName.marginBottom * nameSize
    : 0
  return (
    t.heading(`About ${owner.split(/\s+/)[0] || 'me'}`) +
    Math.max(p.photo ? ph.height * size : 0, name + t.run(p.bio, bioWidth))
  )
}

/**
 * Page one's blocks at `size` pt, in points: the heading and the part written for them, Theo's
 * closing, his signature, the divider and about Theo.
 */
export function pageOneBlocks(
  p: PageOneParts,
  size: number,
  measure: Measure = 'exact',
): { them: number; close: number; sign: number; divider: number; about: number; gaps: number } {
  const t = typesetter(size, measure)
  const them = t.heading(p.heading) + t.run(p.body, FLOW_WIDTH)
  const close = t.run(p.closing, FLOW_WIDTH)
  const sign = Math.max(FLOW.sign.line, 2 * FLOW.sign.nameLineHeight * FLOW.sign.nameSize * size)
  // .op-them, .op-close, .op-sign, the divider, .op-about.
  return {
    them,
    close,
    sign,
    divider: FLOW.divider,
    about: aboutHeight(p, size, t),
    gaps: 4 * FLOW.blockGap * size,
  }
}

/**
 * Page two's blocks at `size` pt, in points: what Prop Archive is (with its four fact boxes) and
 * what you get. With no items in what you get, that block goes.
 */
export function pageTwoBlocks(
  p: PageTwoParts,
  size: number,
  measure: Measure = 'exact',
): { what: number; get: number; gaps: number } {
  const t = typesetter(size, measure)

  // What Prop Archive is: its heading, the overview and the four fact boxes in one row, as tall
  // as the tallest box. The overview's last bottom margin and the boxes' top margin meet, and the
  // larger one stands.
  const st = FLOW.stats
  const boxInner = (FLOW_WIDTH - 3 * st.gap * size) / 4 - 2 * st.padSide * size - 2 * st.border
  const valueSize = FLOW.statValue.size * size
  const labelSize = FLOW.statLabel.size * size
  const box =
    2 * st.border +
    (st.padTop + st.padBottom) * size +
    FLOW.statBar.height +
    2 * FLOW.statBar.margin * size +
    Math.max(
      ...PRINTOUT_STATS.map(
        (stat) =>
          t.lines(stat.value, valueSize, boxInner, 700) * FLOW.statValue.lineHeight * valueSize +
          t.lines(stat.label, labelSize, boxInner) * FLOW.statLabel.lineHeight * labelSize,
      ),
    )
  const overviewMargin = paragraphs(p.overview).length ? FLOW.paragraphGap * size : 0
  const what =
    t.heading('What Prop Archive is') +
    t.run(p.overview, FLOW_WIDTH, true) -
    overviewMargin +
    Math.max(overviewMargin, st.marginTop * size) +
    box

  // What you get: two columns; each item a bar, its bold title and the line under it. A row is as
  // tall as its taller item.
  const items = featureItems(p.features)
  const f = FLOW.features
  const column = (FLOW_WIDTH - f.columnGap * size) / 2
  const inner = column - f.bar - f.pad * size
  const titleSize = FLOW.featureTitle.size * size
  const textSize = FLOW.featureText.size * size
  const itemHeight = (item: { title: string; text: string }) =>
    t.lines(item.title, titleSize, inner, 700) * FLOW.featureTitle.lineHeight * titleSize +
    FLOW.featureTitle.marginBottom * titleSize +
    (item.text ? t.lines(item.text, textSize, inner) * FLOW.featureText.lineHeight * textSize : 0)
  let grid = 0
  for (let i = 0; i < items.length; i += 2) {
    const row = items.slice(i, i + 2).map(itemHeight)
    grid += Math.max(...row) + (i > 0 ? f.rowGap * size : 0)
  }
  const get = items.length ? t.heading('What you get') + grid : 0

  // .op-what and .op-get: one gap between them when both are there.
  return { what, get, gaps: items.length ? FLOW.blockGap * size : 0 }
}

/** A page's flow contents at `size` pt, in points: what the fit script measures. */
export function flowHeight(
  p: PrintoutFitParts,
  size: number,
  measure: Measure = 'exact',
  page: PageNumber = 1,
): number {
  if (page === 1) {
    const b = pageOneBlocks(p, size, measure)
    return b.them + b.close + b.sign + b.divider + b.about + b.gaps
  }
  const b = pageTwoBlocks(p, size, measure)
  return b.what + b.get + b.gaps
}

/** One page fits its sheet at `size` pt. */
export function pageFitsAt(
  p: PrintoutFitParts,
  size: number,
  page: PageNumber,
  measure: Measure = 'exact',
): boolean {
  return flowHeight(p, size, measure, page) <= flowRoom(page)
}

/** Both pages fit their sheets at `size` pt. */
export function fitsAt(p: PrintoutFitParts, size: number, measure: Measure = 'exact'): boolean {
  return pageFitsAt(p, size, 1, measure) && pageFitsAt(p, size, 2, measure)
}

/**
 * Both pages fit by the smallest size even in the Chrome that sets text widest: the fit script will
 * always find a size at which each page prints on its sheet, whatever browser Theo prints from.
 */
export function fitsInAnyChrome(p: PrintoutFitParts): boolean {
  return fitsAt(p, SMALLEST_SIZE, 'widest')
}

/**
 * The size the print page's fit script will settle on for one page (each page fits on its own),
 * or null when even 8.5 pt is too long for it.
 */
export function fittedSize(
  p: PrintoutFitParts,
  page: PageNumber,
  measure: Measure = 'exact',
): number | null {
  return FIT_SIZES.find((size) => pageFitsAt(p, size, page, measure)) ?? null
}

const NO_PARTS: PrintoutFitParts = {
  heading: '',
  body: '',
  overview: '',
  features: '',
  bio: '',
  closing: '',
  ownerName: '',
  photo: false,
}

/** The size page two settles on, or null when even 8.5 pt is too long for it. */
export function pageTwoSize(p: PageTwoParts, measure: Measure = 'exact'): number | null {
  return fittedSize({ ...NO_PARTS, ...p }, 2, measure)
}

/**
 * The average width of a word and the space after it at `size` pt, in Theo's own copy (the default
 * overview and bio): for turning lines of room into words.
 */
function averageWordWidth(size: number, measure: Measure): number {
  const sample = `${DEFAULT_PRINTOUT_OVERVIEW} ${DEFAULT_PRINTOUT_BIO}`.split(/\s+/).filter(Boolean)
  const space = textWidth(' ', size, 400, measure)
  return (textWidth(sample.join(' '), size, 400, measure) + space) / sample.length
}

/**
 * The room page one (the letter and about Theo) leaves for the part written for this person at
 * `size` pt: whole
 * lines, and about how many words of two paragraphs fill them, allowing half a line for each
 * paragraph's last line running short. The words are what to ask for; whether a part fits is then
 * measured (pageFitsAt), never taken from this.
 */
export function bodyRoom(
  p: Omit<PageOneParts, 'body'>,
  size: number,
  measure: Measure = 'exact',
): { lines: number; words: number } {
  const paragraphCount = 2
  const empty = flowHeight({ ...NO_PARTS, ...p, body: '' }, size, measure, 1)
  const gaps = (paragraphCount - 1) * FLOW.paragraphGap * size
  const lines = Math.max(0, Math.floor((FLOW_ROOM - empty - gaps) / (FLOW.lineHeight * size)))
  const perLine = FLOW_WIDTH / averageWordWidth(size, measure)
  return { lines, words: Math.max(0, Math.floor((lines - paragraphCount / 2) * perLine)) }
}
