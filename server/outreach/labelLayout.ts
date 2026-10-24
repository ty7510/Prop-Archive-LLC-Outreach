// Envelope labels: one 4 x 6 in portrait label per page, for a thermal label printer (203 dpi,
// black only), on the envelope that carries the printout. The top echoes the printout's navy band:
// a black band with the mark and PROP ARCHIVE knocked out in white. Theo's return address sits under
// it in small print, and the person's address is set large and alone in the lower middle, so a
// sorting machine finds nothing else near it. One layout feeds the PDF (labelsPdf.ts) and the print
// page (labelSvg below), so the two print the same, line for line.
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { LABEL_MARK } from './labelMark.ts'

/** One envelope label: who it is from and who it goes to. */
export interface EnvelopeLabel {
  /** The return address, Theo's name first. */
  from: string[]
  /** The person's address, their name first. */
  to: string[]
  /** The site under PROP ARCHIVE in the band ("proparchive.app"); empty leaves it off. */
  site: string
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

/** A line of type. x is its left edge and y its baseline, in points from the label's top left. */
export interface LabelText {
  text: string
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
  rules: LabelBox[]
  texts: LabelText[]
}

/** 0.3 in clear of every edge: a thermal printer can drift, so nothing prints nearer than that. */
const EDGE = 21.6
const INNER = LABEL_W - 2 * EDGE
/** Helvetica's capital height and how far its letters reach below the baseline, per point. */
const CAP = 0.718
const DESCENT = 0.21

// The band. The mark is drawn big enough that its thinnest white strokes stay 2+ dots at 203 dpi.
const BAND = { height: 54, radius: 3, pad: 12, gap: 11 }
const MARK_H = 34
const WORDMARK = { text: 'PROP ARCHIVE', size: 15, tracking: 1.8 }
const SITE = { size: 7.5, tracking: 0.6, gap: 6.5 }
/** The thin rule under the band, after the light-blue rule under the printout's band. */
const BAND_RULE = { gap: 3, weight: 1 }

// Type sizes. A field wraps to two lines at most; past that it ends in an ellipsis.
const FROM = { size: 8.5, min: 7, lead: 11 / 8.5, top: 17 }
const TO = { size: 17, min: 12, lead: 1.24 }
const MAX_ROWS = 2
/** Where the person's block sits in the space under the return address (0 top, 1 bottom). */
const TO_PLACE = 0.45
/** Breathing room between the return address and the person's address, at the least. */
const TO_GAP = 30

/** Width of text at 1 pt, for laying out. */
export type Measure = (text: string, bold: boolean) => number

/** A field to set: its words, bold or not, and whether the page may pin it to its exact width. */
interface Field {
  text: string
  bold: boolean
  exact: boolean
}

function wrap(text: string, bold: boolean, size: number, max: number, measure: Measure): string[] {
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
  if (rows.length <= MAX_ROWS) return rows
  let last = rows[MAX_ROWS - 1] ?? ''
  while (last && !fits(`${last}…`)) last = [...last].slice(0, -1).join('').trimEnd()
  return [...rows.slice(0, MAX_ROWS - 1), `${last}…`]
}

/** One size for the whole block: as large as allowed, smaller until the widest line fits, then wrap. */
function fit(
  fields: Field[],
  spec: { size: number; min: number },
  max: number,
  measure: Measure,
): { size: number; rows: Field[] } {
  const widest = Math.max(0, ...fields.map((f) => measure(f.text, f.bold)))
  const size =
    widest * spec.size <= max ? spec.size : Math.max(spec.min, Math.floor((2 * max) / widest) / 2)
  const rows = fields.flatMap((f) =>
    wrap(f.text, f.bold, size, max, measure).map((text) => ({ ...f, text })),
  )
  return { size, rows }
}

function line(
  f: Field,
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

/** Lay out one label. `from` and `to` are set as given; `to[0]` is the person's name, in bold. */
export function layoutLabel(from: Field[], to: Field[], site: string, measure: Measure): LabelArt {
  const texts: LabelText[] = []
  const band = { x: EDGE, y: EDGE, width: INNER, height: BAND.height, radius: BAND.radius }
  const markW = (MARK_H * LABEL_MARK.width) / LABEL_MARK.height
  const mark = {
    x: EDGE + BAND.pad,
    y: EDGE + (BAND.height - MARK_H) / 2,
    width: markW,
    height: MARK_H,
  }

  // PROP ARCHIVE, with the site under it, centred on the band's height.
  const wordX = mark.x + markW + BAND.gap
  const wordCap = CAP * WORDMARK.size
  const group = site ? wordCap + SITE.gap + CAP * SITE.size : wordCap
  const wordY = EDGE + (BAND.height - group) / 2 + wordCap
  const word = { text: WORDMARK.text, bold: true, exact: true }
  texts.push(
    line(word, wordX, wordY, WORDMARK.size, measure, { white: true, tracking: WORDMARK.tracking }),
  )
  if (site) {
    const siteY = wordY + SITE.gap + CAP * SITE.size
    const siteField = { text: site, bold: true, exact: true }
    texts.push(
      line(siteField, wordX, siteY, SITE.size, measure, { white: true, tracking: SITE.tracking }),
    )
  }
  const bandRule = {
    x: EDGE,
    y: EDGE + BAND.height + BAND_RULE.gap,
    width: INNER,
    height: BAND_RULE.weight,
  }

  // The return address, small, under the band.
  const ret = fit(from, FROM, INNER, measure)
  let y = bandRule.y + bandRule.height + FROM.top + CAP * ret.size
  for (const row of ret.rows) {
    texts.push(line(row, EDGE, y, ret.size, measure))
    y += ret.size * FROM.lead
  }
  const fromBottom = y - ret.size * FROM.lead + DESCENT * ret.size

  // The person's address: large, alone, in the lower middle.
  const person = fit(to, TO, INNER, measure)
  const lead = person.size * TO.lead
  const blockH = CAP * person.size + (person.rows.length - 1) * lead
  const zoneTop = fromBottom + TO_GAP
  const zoneBottom = LABEL_H - EDGE - DESCENT * person.size
  const top = zoneTop + Math.max(0, zoneBottom - zoneTop - blockH) * TO_PLACE
  person.rows.forEach((row, i) => {
    texts.push(line(row, EDGE, top + CAP * person.size + i * lead, person.size, measure))
  })

  return { band, mark, rules: [bandRule], texts }
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
    return {
      pdf: layoutLabel(printable(fromFields), printable(toFields), sitePrint, pdfMeasure),
      page: layoutLabel(fromFields, toFields, sitePrint, pageMeasure),
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
