// Envelope labels: one 4 x 6 in portrait label per page, for a thermal label printer (203 dpi,
// black only), on the envelope that carries the printout. Laid out as a carrier's shipping label:
// a frame round it all; a black band with the mark and PROP ARCHIVE LLC knocked out in white;
// FROM and Theo's return address in small print; a heavy rule; SHIP TO and the person's address
// set large and alone, so a sorting machine finds nothing else near it; a heavy rule; and a strip
// of the date and a reference. One layout feeds the PDF (labelsPdf.ts) and the print page
// (labelSvg below), so the two print the same, line for line.
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { LABEL_MARK } from './labelMark.ts'

/** One envelope label: who it is from and who it goes to. */
export interface EnvelopeLabel {
  /** The return address, Theo's name first. */
  from: string[]
  /** The person's address, their name first. */
  to: string[]
  /** The site under PROP ARCHIVE LLC in the band ("proparchive.app"); empty leaves it off. */
  site: string
  /** The day it is printed, for the strip at the foot ("10/25/2026"). */
  date?: string
  /** A short reference that finds this piece in the outreach list ("PA-7Q2K9M"). */
  ref?: string
}

/** 4 x 6 in, portrait, in PDF points (72 an inch). */
export const LABEL_W = 288
export const LABEL_H = 432

// ---------------------------------------------------------------------------------------------
// The words

/**
 * A field as both the page and the PDF print it: line breaks and runs of spaces inside it become
 * one space, invisible characters go, curly quotes go straight and every dash is a plain hyphen,
 * so no em dash ever prints on a label.
 */
export function cleanLabelText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02B9\u02BB\u02BC]/g, "'")
    .replace(/[\u201C-\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
}

function pairs(list: string): Map<string, string> {
  return new Map(list.split(',').map((pair) => [pair.slice(0, 1), pair.slice(2)]))
}
/** Latin letters that do not come apart into a plain letter and an accent. */
const PLAIN_LATIN = pairs('Đ D,đ d,Ł L,ł l,Ħ H,ħ h,ı i,Ŧ T,ŧ t,Ŀ L,ŀ l,Ŋ N,ŋ n,ĸ k,ſ s')
/** Russian and Ukrainian letters spelt in Latin, lower case (a capital gets a capital). */
const CYRILLIC = pairs(
  'а a,б b,в v,г g,д d,е e,ё yo,ж zh,з z,и i,й y,к k,л l,м m,н n,о o,п p,р r,с s,т t,у u,ф f,' +
    'х kh,ц ts,ч ch,ш sh,щ shch,ъ ,ы y,ь ,э e,ю yu,я ya,є ye,і i,ї yi,ґ g',
)
/** In a Ukrainian name (one with є, і, ї or ґ), г is h and и is y. */
const UKRAINIAN = pairs('г h,и y')
const UKRAINIAN_LETTERS = /[ЄєІіЇїҐґ]/

export interface PrintableText {
  text: string
  /** A letter was swapped for a plainer one or left out. */
  lossy: boolean
}

/**
 * `text` in the letters the PDF's Helvetica can draw (Windows-1252, which has é, ñ, ü, ø, š, ž, œ
 * and the like): a letter it lacks loses its accent (Nguyễn is Nguyen, Ștefan is Stefan), Ł, Đ and
 * a few others become their plain letter, Russian and Ukrainian are spelt in Latin, and anything
 * else (Chinese, Arabic, emoji) is left out, never printed as "?". `lossy` says something changed.
 */
export function printableText(text: string, canPrint: (ch: string) => boolean): PrintableText {
  const chars = [...text]
  const ukrainian = UKRAINIAN_LETTERS.test(text)
  let out = ''
  let lossy = false
  chars.forEach((ch, i) => {
    if (canPrint(ch)) {
      out += ch
      return
    }
    lossy = true
    out += plainLetters(ch, chars[i + 1] ?? '', ukrainian, canPrint)
  })
  return { text: out.replace(/ {2,}/g, ' ').trim(), lossy }
}

function plainLetters(
  ch: string,
  next: string,
  ukrainian: boolean,
  canPrint: (ch: string) => boolean,
): string {
  const latin = PLAIN_LATIN.get(ch)
  if (latin !== undefined) return latin
  const bare = ch.normalize('NFKD').replace(/\p{M}/gu, '')
  if (bare && bare !== ch && [...bare].every(canPrint)) return bare
  const lower = ch.toLowerCase()
  const spelt = (ukrainian ? UKRAINIAN.get(lower) : undefined) ?? CYRILLIC.get(lower)
  if (spelt === undefined) return ''
  if (lower === ch) return spelt
  // A capital: ЖУК (all capitals) is ZHUK, Жук is Zhuk.
  return next && next !== next.toLowerCase()
    ? spelt.toUpperCase()
    : spelt.charAt(0).toUpperCase() + spelt.slice(1)
}

// ---------------------------------------------------------------------------------------------
// The font

/** What the PDF's standard Helvetica can draw, and how wide. */
export interface LabelFont {
  canPrint(ch: string): boolean
  /** Width of `text` at 1 pt, letter by letter: the PDF draws it without kerning. */
  width(text: string, bold: boolean): number
}

let helvetica: Promise<LabelFont> | undefined

/** Helvetica and Helvetica Bold, as pdf-lib's standard fonts know them (no font file needed). */
export function labelFont(): Promise<LabelFont> {
  helvetica ??= (async () => {
    const doc = await PDFDocument.create()
    const regular = await doc.embedFont(StandardFonts.Helvetica)
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    const widths = new Map<string, readonly [number, number]>()
    for (const code of regular.getCharacterSet()) {
      if (code < 0x20) continue
      const ch = String.fromCodePoint(code)
      widths.set(ch, [regular.widthOfTextAtSize(ch, 1), bold.widthOfTextAtSize(ch, 1)])
    }
    return {
      canPrint: (ch) => widths.has(ch),
      width: (text, isBold) => {
        let w = 0
        for (const ch of text) w += widths.get(ch)?.[isBold ? 1 : 0] ?? 0
        return w
      },
    }
  })()
  return helvetica
}

// ---------------------------------------------------------------------------------------------
// The layout

/** What a line of type is, so a test (or a reader) can tell the address from the furniture. */
export type LabelTextKind = 'brand' | 'caption' | 'from' | 'to' | 'meta'

/** A line of type. x is its left edge and y its baseline, in points from the label's top left. */
export interface LabelText {
  text: string
  kind: LabelTextKind
  x: number
  y: number
  size: number
  bold: boolean
  /** Knocked out of the black band. */
  white: boolean
  /** Extra space after each letter, in points. */
  tracking: number
  /** Width as Helvetica draws it, tracking included. */
  width: number
  /** Every letter is one Helvetica has, so `width` is exact and the page may pin the line to it. */
  exact: boolean
}

/** A box: x and y are its top left corner, in points. */
export interface LabelBox {
  x: number
  y: number
  width: number
  height: number
}

export interface LabelArt {
  band: LabelBox & { radius: number }
  mark: LabelBox
  /** Solid black boxes: the frame, the rules between sections and the strip's dividers. */
  rules: LabelBox[]
  texts: LabelText[]
}

/** 0.3 in clear of every edge: a thermal printer can drift, so nothing prints nearer than that. */
const EDGE = 21.6
const INNER = LABEL_W - 2 * EDGE
const INNER_H = LABEL_H - 2 * EDGE
/** Helvetica's capital height and how far its letters reach below the baseline, per point. */
const CAP = 0.718
const DESCENT = 0.21

// A carrier label's furniture: a frame round the whole label, heavy rules between the sections,
// thin rules between the cells of the strip at the foot. Every weight is 2+ dots at 203 dpi.
const FRAME = 1.5
const HEAVY = 3
const THIN = 1
/** Space inside a section, from the frame and the rules. */
const PAD = 9

// The band. The mark is drawn big enough that its thinnest white strokes stay 2+ dots at 203 dpi.
const BAND = { height: 54, pad: 12, gap: 11 }
const MARK_H = 34
/** The company's name as registered, sized down (never under `min`) until it fits the band. */
const WORDMARK = { text: 'PROP ARCHIVE LLC', size: 15, min: 10, tracking: 0.12 }
const SITE = { size: 7.5, tracking: 0.6, gap: 6.5 }

// Section captions, small bold capitals as carriers print them.
const FROM_CAPTION = { text: 'FROM', size: 6.5, tracking: 0.9 }
const SHIP_CAPTION = { text: 'SHIP TO', size: 8.5, tracking: 1.1, gap: 14 }

// Type sizes. A field wraps to `rows` lines at most; past that it ends in an ellipsis.
/**
 * The return address sits in a column right of its caption. A line of it may take three rows, so
 * a long one typed without commas (which would split it) still prints whole, suite and all.
 */
const FROM = { size: 8.5, min: 7, lead: 11 / 8.5, column: 34, rows: 3 }
/**
 * The person's address, indented under SHIP TO when every line fits the indented column at 12 pt,
 * flush with the caption otherwise. A name or company line may take three rows; the street and the
 * city line never wrap (the post office reads the line above the city as the street): the block
 * shrinks for them instead, down to `floor`, the smallest the post office reads well.
 */
const TO = { size: 17, min: 12, floor: 9, lead: 1.24, indent: 18, rows: 3 }
/** Where the person's block sits in the space under SHIP TO (0 top, 1 bottom). */
const TO_PLACE = 0.4

/** The strip at the foot: the date and the reference, each a caption over its value. */
const META = { height: 40, caption: 6, captionTracking: 0.7, value: 10, min: 7, gap: 5.5 }

/** Width of text at 1 pt, for laying out. */
export type Measure = (text: string, bold: boolean) => number

/** A field to set: its words, bold or not, and whether the page may pin it to its exact width. */
interface Field {
  text: string
  bold: boolean
  exact: boolean
}

/** What goes in the strip at the foot of a label. Empty values leave their cell blank. */
export interface LabelMeta {
  date: string
  ref: string
}

function wrap(
  text: string,
  bold: boolean,
  size: number,
  max: number,
  measure: Measure,
  maxRows: number,
): string[] {
  if (!text) return ['']
  const fits = (s: string) => measure(s, bold) * size <= max + 1e-6
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    const next = row ? `${row} ${word}` : word
    if (fits(next)) {
      row = next
      continue
    }
    if (row) rows.push(row)
    row = word
    // A word wider than the label on its own breaks between letters.
    while (!fits(row) && [...row].length > 1) {
      const letters = [...row]
      let cut = letters.length - 1
      while (cut > 1 && !fits(letters.slice(0, cut).join(''))) cut--
      rows.push(letters.slice(0, cut).join(''))
      row = letters.slice(cut).join('')
    }
  }
  rows.push(row)
  if (rows.length <= maxRows) return rows
  let last = rows[maxRows - 1] ?? ''
  while (last && !fits(`${last}…`)) last = [...last].slice(0, -1).join('').trimEnd()
  return [...rows.slice(0, maxRows - 1), `${last}…`]
}

/**
 * A long plain line broken at its commas into address lines, as it would be written by hand:
 * "Close School, Pearlstein Center, 3230 Market St" is three lines, while parts that fit together
 * stay on one line ("1500 Market St, Suite 400"), packed from the end so a suite stays with its
 * street. A line that fits is left alone.
 */
function splitAtCommas(f: Field, size: number, max: number, measure: Measure): Field[] {
  const fits = (s: string) => measure(s, f.bold) * size <= max + 1e-6
  if (f.bold || fits(f.text) || !f.text.includes(',')) return [f]
  const parts = f.text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  // Packed from the end, so the street keeps its suite beside it ("3230 Market St, Suite 402").
  const lines: string[] = []
  for (const part of [...parts].reverse()) {
    const first = lines[0]
    if (first !== undefined && fits(`${part}, ${first}`)) lines[0] = `${part}, ${first}`
    else lines.unshift(part)
  }
  return lines.map((text) => ({ ...f, text }))
}

/** One size for the whole block: as large as allowed, smaller until the widest line fits, then wrap. */
function fit(
  fields: Field[],
  spec: { size: number; min: number; rows: number },
  max: number,
  measure: Measure,
): { size: number; rows: Field[] } {
  const widest = Math.max(0, ...fields.map((f) => measure(f.text, f.bold)))
  const size =
    widest * spec.size <= max ? spec.size : Math.max(spec.min, Math.floor((2 * max) / widest) / 2)
  const rows = fields.flatMap((f) =>
    wrap(f.text, f.bold, size, max, measure, spec.rows).map((text) => ({ ...f, text })),
  )
  return { size, rows }
}

/** The largest half-point size, from `size` down to `min`, at which `text` fits `max`. */
function sizeToFit(
  text: string,
  spec: { size: number; min: number },
  max: number,
  tracking: (size: number) => number,
  measure: Measure,
): number {
  const gaps = Math.max(0, [...text].length - 1)
  let size = spec.size
  while (size > spec.min && measure(text, true) * size + tracking(size) * gaps > max) size -= 0.5
  return size
}

function line(
  f: Field,
  kind: LabelTextKind,
  x: number,
  y: number,
  size: number,
  measure: Measure,
  extra: Partial<Pick<LabelText, 'white' | 'tracking'>> = {},
): LabelText {
  const tracking = extra.tracking ?? 0
  const letters = [...f.text].length
  return {
    text: f.text,
    kind,
    x,
    y,
    size,
    bold: f.bold,
    white: extra.white ?? false,
    tracking,
    width: measure(f.text, f.bold) * size + tracking * Math.max(0, letters - 1),
    exact: f.exact,
  }
}

const furniture = (text: string): Field => ({ text, bold: true, exact: true })

/**
 * Lay out one label as a carrier label is laid out, top to bottom: the black brand band, FROM and
 * the return address, a heavy rule, SHIP TO and the person's address large and alone, a heavy
 * rule, and a strip of the date and a reference. A frame runs round it all. `from` and `to` are
 * set as given; the first line of each is a name, in bold.
 */
export function layoutLabel(
  from: Field[],
  to: Field[],
  site: string,
  meta: LabelMeta,
  measure: Measure,
): LabelArt {
  const texts: LabelText[] = []
  const left = EDGE
  const right = EDGE + INNER
  const bottom = LABEL_H - EDGE
  const rules: LabelBox[] = [
    { x: left, y: EDGE, width: INNER, height: FRAME },
    { x: left, y: bottom - FRAME, width: INNER, height: FRAME },
    { x: left, y: EDGE, width: FRAME, height: INNER_H },
    { x: right - FRAME, y: EDGE, width: FRAME, height: INNER_H },
  ]

  // The band, flush with the frame: the mark, PROP ARCHIVE LLC and the site under it.
  const band = { x: left, y: EDGE, width: INNER, height: BAND.height, radius: 0 }
  const markW = (MARK_H * LABEL_MARK.width) / LABEL_MARK.height
  const mark = {
    x: left + BAND.pad,
    y: EDGE + (BAND.height - MARK_H) / 2,
    width: markW,
    height: MARK_H,
  }
  const wordX = mark.x + markW + BAND.gap
  const wordMax = right - BAND.pad - wordX
  const wordSize = sizeToFit(
    WORDMARK.text,
    WORDMARK,
    wordMax,
    (s) => s * WORDMARK.tracking,
    measure,
  )
  const wordCap = CAP * wordSize
  const group = site ? wordCap + SITE.gap + CAP * SITE.size : wordCap
  const wordY = EDGE + (BAND.height - group) / 2 + wordCap
  texts.push(
    line(furniture(WORDMARK.text), 'brand', wordX, wordY, wordSize, measure, {
      white: true,
      tracking: wordSize * WORDMARK.tracking,
    }),
  )
  if (site) {
    const siteY = wordY + SITE.gap + CAP * SITE.size
    texts.push(
      line(furniture(site), 'brand', wordX, siteY, SITE.size, measure, {
        white: true,
        tracking: SITE.tracking,
      }),
    )
  }

  // FROM: the caption, and the return address in a column beside it.
  const fromX = left + PAD + FROM.column
  const fromMax = right - PAD - fromX
  const fromFields = from.flatMap((f) => splitAtCommas(f, FROM.min, fromMax, measure))
  const ret = fit(fromFields, FROM, fromMax, measure)
  const firstFrom = EDGE + BAND.height + PAD + CAP * Math.max(ret.size, FROM_CAPTION.size)
  texts.push(
    line(
      furniture(FROM_CAPTION.text),
      'caption',
      left + PAD,
      firstFrom,
      FROM_CAPTION.size,
      measure,
      {
        tracking: FROM_CAPTION.tracking,
      },
    ),
  )
  let y = firstFrom
  for (const row of ret.rows) {
    texts.push(line(row, 'from', fromX, y, ret.size, measure))
    y += ret.size * FROM.lead
  }
  const lastFrom = ret.rows.length ? y - ret.size * FROM.lead : firstFrom
  const fromRule = lastFrom + DESCENT * ret.size + PAD
  rules.push({ x: left, y: fromRule, width: INNER, height: HEAVY })

  // The strip at the foot: two cells, each a caption over its value. (No "piece 2 of 5": on a
  // carrier label that reads as more parcels coming to the same person.)
  const metaTop = bottom - META.height
  rules.push({ x: left, y: metaTop - HEAVY, width: INNER, height: HEAVY })
  const cellW = INNER / 2
  const cells: [string, string][] = [
    ['DATE', meta.date],
    ['REF', meta.ref],
  ]
  cells.forEach(([caption, value], i) => {
    const cellX = left + i * cellW
    if (i > 0) rules.push({ x: cellX - THIN / 2, y: metaTop, width: THIN, height: META.height })
    const group = CAP * META.caption + META.gap + CAP * META.value
    const captionY = metaTop + (META.height - FRAME - group) / 2 + CAP * META.caption
    texts.push(
      line(furniture(caption), 'meta', cellX + PAD, captionY, META.caption, measure, {
        tracking: META.captionTracking,
      }),
    )
    if (!value) return
    const valueSize = sizeToFit(
      value,
      { size: META.value, min: META.min },
      cellW - 2 * PAD,
      () => 0,
      measure,
    )
    const valueY = captionY + META.gap + CAP * valueSize
    texts.push(line(furniture(value), 'meta', cellX + PAD, valueY, valueSize, measure))
  })

  // SHIP TO: the caption, and the person's address large, indented and alone under it.
  const shipCaptionY = fromRule + HEAVY + PAD + CAP * SHIP_CAPTION.size
  texts.push(
    line(
      furniture(SHIP_CAPTION.text),
      'caption',
      left + PAD,
      shipCaptionY,
      SHIP_CAPTION.size,
      measure,
      { tracking: SHIP_CAPTION.tracking },
    ),
  )
  // A street too long for one row at 12 pt keeps its number and street on the line above the
  // city; what follows its first comma (the apartment or suite) goes on the line above that, where
  // the post office looks for it when it is not on the street line.
  const flushMax = right - PAD - (left + PAD)
  const streetAt = to.length >= 3 ? to.length - 2 : -1
  const street = streetAt > 0 ? to[streetAt]! : undefined
  const comma = street ? street.text.indexOf(',') : -1
  const toLines: Field[] =
    street && comma > 0 && measure(street.text, street.bold) * TO.min > flushMax + 1e-6
      ? [
          ...to.slice(0, streetAt),
          { ...street, text: street.text.slice(comma + 1).trim() },
          { ...street, text: street.text.slice(0, comma).trim() },
          ...to.slice(streetAt + 1),
        ]
      : to
  const indented = left + PAD + TO.indent
  const widest = (fields: Field[]) => Math.max(0, ...fields.map((f) => measure(f.text, f.bold)))
  const toX = widest(toLines) * TO.min <= right - PAD - indented + 1e-6 ? indented : left + PAD
  const toMax = right - PAD - toX
  // As large as it may be with the widest line on one row, but never under 12 pt for a long name
  // (that wraps instead); the street and city lines are kept whole by going smaller, to the floor.
  const critical = toLines.length > 1 ? toLines.slice(Math.max(1, toLines.length - 2)) : []
  const halfPoints = (w: number) => (w > 0 ? Math.floor((2 * toMax) / w) / 2 : TO.size)
  const zoneTop = shipCaptionY + SHIP_CAPTION.gap
  let toSize = Math.min(
    Math.max(TO.min, Math.min(TO.size, halfPoints(widest(toLines)))),
    Math.max(TO.floor, halfPoints(widest(critical))),
  )
  const setTo = (size: number) => {
    const rows = toLines.flatMap((f) =>
      wrap(f.text, f.bold, size, toMax, measure, TO.rows).map((text) => ({ ...f, text })),
    )
    const blockH = CAP * size + (rows.length - 1) * size * TO.lead
    const zoneBottom = metaTop - HEAVY - PAD - DESCENT * size
    return { size, rows, blockH, zoneBottom }
  }
  // Smaller still when the block would run into the strip.
  let person = setTo(toSize)
  while (person.blockH > person.zoneBottom - zoneTop && toSize > TO.floor) {
    toSize -= 0.5
    person = setTo(toSize)
  }
  const lead = person.size * TO.lead
  const top = zoneTop + Math.max(0, person.zoneBottom - zoneTop - person.blockH) * TO_PLACE
  person.rows.forEach((row, i) => {
    texts.push(line(row, 'to', toX, top + CAP * person.size + i * lead, person.size, measure))
  })

  return { band, mark, rules, texts }
}

/** A label laid out for the PDF and for the page. */
export interface LaidOutLabel {
  /** Helvetica's letters only: what the PDF prints. */
  pdf: LabelArt
  /** Every letter as typed: what the print page shows and prints. */
  page: LabelArt
  /** The person's name as typed, for notes on the page. */
  name: string
  /** The PDF had to swap or leave out letters in the person's address. */
  lossy: boolean
  /** ... or in the return address. */
  fromLossy: boolean
}

/**
 * Lay out each label twice: for the PDF in the letters its font has, and for the page with every
 * letter as typed. They match unless a letter had to change for the PDF. A line the PDF cannot
 * print at all (a name in Chinese) stays as a blank line, so the rest of the address keeps its
 * place and the next line is never set in the name's bold.
 */
export async function layoutLabels(labels: EnvelopeLabel[]): Promise<LaidOutLabel[]> {
  const font = await labelFont()
  const pdfMeasure: Measure = (text, bold) => font.width(text, bold)
  const pageMeasure: Measure = (text, bold) => pageWidth(font, text, bold)
  return labels.map((label) => {
    const from = label.from.map(cleanLabelText).filter(Boolean)
    const [name = '', ...rest] = label.to.map(cleanLabelText)
    const to = [name, ...rest.filter(Boolean)]
    const site = cleanLabelText(label.site)
    const asTyped = (texts: string[], boldFirst: boolean): Field[] =>
      texts.map((text, i) => ({
        text,
        bold: boldFirst && i === 0,
        exact: [...text].every((ch) => font.canPrint(ch)),
      }))
    const printable = (fields: Field[]) =>
      fields.map((f) => ({ ...f, text: printableText(f.text, font.canPrint).text, exact: true }))
    const fromFields = asTyped(from, true)
    const toFields = asTyped(to, true)
    const sitePrint = printableText(site, font.canPrint).text
    const plain = (s: string | undefined) =>
      printableText(cleanLabelText(s ?? ''), font.canPrint).text
    const meta: LabelMeta = { date: plain(label.date), ref: plain(label.ref) }
    return {
      pdf: layoutLabel(printable(fromFields), printable(toFields), sitePrint, meta, pdfMeasure),
      page: layoutLabel(fromFields, toFields, sitePrint, meta, pageMeasure),
      name,
      lossy: toFields.some((f) => !f.exact),
      fromLossy: fromFields.some((f) => !f.exact),
    }
  })
}

/**
 * The page's width for `text` at 1 pt: exact for Helvetica's letters, and for the rest never less
 * than the browser draws, so a line never runs off the label.
 */
function pageWidth(font: LabelFont, text: string, bold: boolean): number {
  const chars = [...text]
  const ukrainian = UKRAINIAN_LETTERS.test(text)
  let w = 0
  chars.forEach((ch, i) => {
    if (font.canPrint(ch)) {
      w += font.width(ch, bold)
      return
    }
    const plain = font.width(plainLetters(ch, chars[i + 1] ?? '', ukrainian, font.canPrint), bold)
    if (/\p{Script=Latin}/u.test(ch)) w += plain * 1.05 + 0.02
    else if (/\p{Script=Cyrillic}/u.test(ch))
      w += Math.max(plain, ch === ch.toLowerCase() ? 0.8 : 0.95)
    else w += 1.2
  })
  return w
}

// ---------------------------------------------------------------------------------------------
// The page

const num = (v: number) => String(Math.round(v * 100) / 100)

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The mark once per page, for every label's <use>. Zero size, so it never adds a page. */
export const LABEL_MARK_DEFS = `<svg class="label-defs" width="0" height="0" aria-hidden="true" focusable="false"><symbol id="pa-mark" viewBox="0 0 ${LABEL_MARK.width} ${LABEL_MARK.height}"><path d="${LABEL_MARK.d}"/></symbol></svg>`

/**
 * One label as SVG in points, drawn exactly as the PDF draws it. A line in Helvetica's letters is
 * pinned to Helvetica's width (Arial on Windows has the same widths), so it wraps and fits the same.
 */
export function labelSvg(art: LabelArt, title: string): string {
  const { band, mark } = art
  const rules = art.rules
    .map(
      (r) =>
        `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.width)}" height="${num(r.height)}"/>`,
    )
    .join('')
  const texts = art.texts
    .filter((t) => t.text)
    .map((t) => {
      const attrs = [
        `x="${num(t.x)}"`,
        `y="${num(t.y)}"`,
        `font-size="${num(t.size)}"`,
        t.bold ? 'font-weight="700"' : '',
        t.white ? 'fill="#fff"' : '',
        t.exact ? `textLength="${num(t.width)}" lengthAdjust="spacing"` : '',
      ].filter(Boolean)
      return `<text ${attrs.join(' ')}>${escXml(t.text)}</text>`
    })
    .join('')
  return `<svg class="label-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LABEL_W} ${LABEL_H}" role="img" aria-label="${escXml(title)}"><rect x="${num(band.x)}" y="${num(band.y)}" width="${num(band.width)}" height="${num(band.height)}" rx="${num(band.radius)}"/><use href="#pa-mark" x="${num(mark.x)}" y="${num(mark.y)}" width="${num(mark.width)}" height="${num(mark.height)}" fill="#fff"/>${rules}${texts}</svg>`
}
