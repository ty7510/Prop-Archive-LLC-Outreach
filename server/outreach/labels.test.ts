// 2026-10-24: the 4 x 6 in envelope labels. Names in any alphabet must reach the PDF as letters it
// can draw (never deleted, never a crash), and the page and the PDF must lay out the same.
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, type PDFObject } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  cleanLabelText,
  labelFont,
  LABEL_H,
  LABEL_W,
  layoutLabels,
  printableText,
  type EnvelopeLabel,
  type LabelArt,
  type LabelText,
} from './labelLayout.ts'
import { labelsPdf } from './labelsPdf.ts'

const FROM = ['Theo Young', 'Prop Archive LLC', '1500 Market St', 'Philadelphia, PA 19102']
const label = (to: string[]): EnvelopeLabel => ({ from: FROM, to, site: 'proparchive.app' })

/** The text each page of a PDF draws, from its <hex> Tj operators (Windows-1252 bytes). */
async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes)
  return pdf.getPages().map((page) => {
    const contents = page.node.Contents()
    const streams: PDFObject[] =
      contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
    const ops = streams
      .map((ref) => pdf.context.lookup(ref))
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
      .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
      .join('\n')
    return [...ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)]
      .map((m) => Buffer.from(m[1] ?? '', 'hex').toString('latin1'))
      .join('\n')
  })
}

describe('label text', () => {
  it('turns line breaks inside a field into a space and never prints an em dash', () => {
    expect(cleanLabelText('1234 S 10th St\nUnit 2')).toBe('1234 S 10th St Unit 2')
    expect(cleanLabelText('  Smith\t— Rentals  ')).toBe('Smith - Rentals')
    expect(cleanLabelText('O’Brien “Bud”')).toBe('O\'Brien "Bud"')
  })

  it('swaps letters Helvetica lacks for plain ones, says so, and keeps the ones it has', async () => {
    const font = await labelFont()
    const p = (s: string) => printableText(s, font.canPrint)
    expect(p('Nguyễn Văn Đức')).toEqual({ text: 'Nguyen Van Duc', lossy: true })
    expect(p('Łukasz Żółć')).toEqual({ text: 'Lukasz Zólc', lossy: true })
    expect(p('Ştefan')).toEqual({ text: 'Stefan', lossy: true })
    expect(p('Олександр Шевченко')).toEqual({ text: 'Oleksandr Shevchenko', lossy: true })
    expect(p('Григорій ЖУК')).toEqual({ text: 'Hryhoriy ZHUK', lossy: true })
    expect(p('王伟')).toEqual({ text: '', lossy: true })
    expect(p('José Núñez')).toEqual({ text: 'José Núñez', lossy: false })
    expect(p('Šimon Žák Œuvre €5')).toEqual({ text: 'Šimon Žák Œuvre €5', lossy: false })
  })
})

describe('the labels PDF', () => {
  it('prints Vietnamese, Polish, Ukrainian and Chinese names without dropping letters or crashing', async () => {
    const bytes = await labelsPdf([
      label(['Nguyễn Văn Đức', 'Đức Holdings', '1234 S 10th St\nUnit 2', 'Philadelphia, PA 19147']),
      label(['Łukasz Żółć', '4512 Baltimore Ave', 'Philadelphia, PA 19143']),
      label(['Олександр Шевченко', '7600 Castor Ave', 'Philadelphia, PA 19152']),
      label(['王伟', 'José Núñez — Rentals', '901 Race St', 'Philadelphia, PA 19107']),
    ])
    const pages = await pdfText(bytes)
    expect(pages).toHaveLength(4)
    expect(pages[0]).toContain('Nguyen Van Duc')
    expect(pages[0]).toContain('Duc Holdings')
    expect(pages[0]).toContain('1234 S 10th St Unit 2')
    expect(pages[1]).toContain('Lukasz Zólc')
    expect(pages[2]).toContain('Oleksandr Shevchenko')
    expect(pages[3]).toContain('José Núñez - Rentals')
    expect(pages.join('\n')).not.toContain('—')
    expect(pages.join('\n')).toContain('PROP ARCHIVE LLC')
    expect(pages.join('\n')).toContain('Theo Young')
    expect(pages[0]).toContain('SHIP TO')
    expect(pages.join('\n')).not.toContain('PIECE')
  })

  it('is 4 x 6 in portrait, titled, and asks to print at 100% on paper of its size', async () => {
    const date = new Date('2026-10-24T15:00:00Z')
    const pdf = await PDFDocument.load(
      await labelsPdf([label(['Dana Smith'])], {
        title: 'Envelope labels, October 24, 2026',
        date,
      }),
    )
    expect(pdf.getPage(0).getSize()).toEqual({ width: LABEL_W, height: LABEL_H })
    expect(pdf.getTitle()).toBe('Envelope labels, October 24, 2026')
    const prefs = pdf.catalog.getOrCreateViewerPreferences()
    expect(String(prefs.PrintScaling())).toBe('/None')
    expect(prefs.getPickTrayByPDFSize()).toBe(true)
  })
})

describe('the label layout', () => {
  const EDGE = 0.3 * 72
  /** The two heavy rules, top to bottom: under the return address, and over the strip. */
  const heavyRules = (art: LabelArt) =>
    art.rules.filter((r) => r.height === 3 && r.width > 200).sort((a, b) => a.y - b.y)

  it('keeps every line inside the frame, the person well below the return address', async () => {
    const [laid] = await layoutLabels([
      label([
        'Maximilian Alexander Featherstonehaugh-Worthington',
        'Featherstonehaugh Worthington Residential Property Holdings and Management Group LLC',
        '12345 North Broad Street, Apartment 1204, Building C',
        'Philadelphia, PA 19122-4321',
      ]),
    ])
    for (const art of [laid!.pdf, laid!.page]) {
      for (const t of art.texts) {
        expect(t.x).toBeGreaterThan(EDGE + 1.5)
        expect(t.x + t.width).toBeLessThan(LABEL_W - EDGE - 1.5)
        expect(t.y).toBeLessThan(LABEL_H - EDGE - 1.5)
      }
      const to = art.texts.filter((t) => t.kind === 'to')
      const from = art.texts.filter((t) => t.kind === 'from')
      expect(Math.min(...to.map((t) => t.y))).toBeGreaterThan(
        Math.max(...from.map((t) => t.y)) + 30,
      )
      // Never under 12 pt, the city line last.
      expect(Math.min(...to.map((t) => t.size))).toBeGreaterThanOrEqual(12)
      expect(to.at(-1)!.text).toBe('Philadelphia, PA 19122-4321')
    }
    expect(laid!.pdf).toEqual(laid!.page)
  })

  it('lays out as a shipping label: frame, FROM, a heavy rule, SHIP TO, a heavy rule, the strip', async () => {
    const [laid] = await layoutLabels([
      label([
        'Esther Shemza',
        'Yermiv Ahu2018 LLC',
        '107 S 2nd St Ste 300',
        'Philadelphia, PA 19106',
      ]),
    ])
    const art = laid!.pdf
    const [under, over] = heavyRules(art)
    expect(under && over).toBeTruthy()
    // The frame: four sides, 0.3 in in from the edges.
    const frame = art.rules.filter((r) => r.height === 1.5 || r.width === 1.5)
    expect(frame).toHaveLength(4)
    expect(Math.min(...frame.map((r) => r.x))).toBeCloseTo(EDGE)
    expect(Math.max(...frame.map((r) => r.x + r.width))).toBeCloseTo(LABEL_W - EDGE)
    expect(Math.max(...frame.map((r) => r.y + r.height))).toBeCloseTo(LABEL_H - EDGE)
    // Each section's type stays between its rules, descenders included.
    const top = (t: LabelText) => t.y - 0.718 * t.size
    const foot = (t: LabelText) => t.y + 0.21 * t.size
    const of = (kind: LabelText['kind']) => art.texts.filter((t) => t.kind === kind)
    for (const t of of('from')) {
      expect(top(t)).toBeGreaterThan(art.band.y + art.band.height)
      expect(foot(t)).toBeLessThan(under!.y)
    }
    for (const t of of('to')) {
      expect(top(t)).toBeGreaterThan(under!.y + under!.height)
      expect(foot(t)).toBeLessThan(over!.y)
    }
    for (const t of of('meta')) {
      expect(top(t)).toBeGreaterThan(over!.y + over!.height)
      expect(foot(t)).toBeLessThan(LABEL_H - EDGE - 1.5)
    }
    expect(of('caption').map((t) => t.text)).toEqual(['FROM', 'SHIP TO'])
    expect(of('brand').map((t) => t.text)).toEqual(['PROP ARCHIVE LLC', 'proparchive.app'])
    // The wordmark fits its band.
    const [word] = of('brand')
    expect(word!.x + word!.width).toBeLessThan(art.band.x + art.band.width - 6)
  })

  it('breaks a long return address at its commas instead of cutting it short', async () => {
    const laid = await layoutLabels([
      {
        from: [
          'Theo Young',
          'Prop Archive LLC',
          'Charles D. Close School of Entrepreneurship, Pearlstein Business Learning Center, 3230 Market St Pearlstein Suite 402',
          'Philadelphia, PA 19104',
        ],
        to: ['Esther Shemza', '107 S 2nd St Ste 300', 'Philadelphia, PA 19106'],
        site: 'proparchive.app',
      },
      {
        from: [
          'Theo Young',
          'Prop Archive LLC',
          '1500 Market St, Suite 400',
          'Philadelphia, PA 19102',
        ],
        to: ['Dana Smith'],
        site: '',
      },
    ])
    const from = (i: number) =>
      laid[i]!.pdf.texts.filter((t) => t.kind === 'from').map((t) => t.text)
    expect(from(0)).toEqual([
      'Theo Young',
      'Prop Archive LLC',
      'Charles D. Close School of Entrepreneurship',
      'Pearlstein Business Learning Center',
      '3230 Market St Pearlstein Suite 402',
      'Philadelphia, PA 19104',
    ])
    expect(from(0).join(' ')).not.toContain('…')
    // A line that fits keeps its suite beside the street, as the post office reads it.
    expect(from(1)).toContain('1500 Market St, Suite 400')
  })

  it('keeps a suite after a comma on the street line, not alone under it', async () => {
    const [laid] = await layoutLabels([
      {
        from: [
          'Theo Young',
          'Prop Archive LLC',
          'Charles D. Close School of Entrepreneurship, Pearlstein Business Learning Center, 3230 Market St, Suite 402',
          'Philadelphia, PA 19104',
        ],
        to: ['Dana Smith'],
        site: '',
      },
    ])
    const rows = laid!.pdf.texts.filter((t) => t.kind === 'from').map((t) => t.text)
    expect(rows).toContain('3230 Market St, Suite 402')
    expect(rows).not.toContain('Suite 402')
  })

  it('prints a long return address typed without commas whole, over three rows', async () => {
    const line =
      'Charles D Close School of Entrepreneurship Pearlstein Business Learning Center 3230 Market St Pearlstein Suite 402'
    const [laid] = await layoutLabels([
      {
        from: ['Theo Young', 'Prop Archive LLC', line, 'Philadelphia, PA 19104'],
        to: ['Esther Shemza', '107 S 2nd St Ste 300', 'Philadelphia, PA 19106'],
        site: 'proparchive.app',
      },
    ])
    const rows = laid!.pdf.texts.filter((t) => t.kind === 'from').map((t) => t.text)
    expect(rows.join(' ')).not.toContain('…')
    expect(rows.join(' ')).toContain(line)
    expect(rows.at(-1)).toBe('Philadelphia, PA 19104')
  })

  it('never wraps the street or city line of the person it goes to', async () => {
    const city = 'Philadelphia, PA 19103'
    for (const street of ['1700 Benjamin Franklin Pkwy Apt 1210', '2317 N 29TH ST APT 2R REAR']) {
      const [laid] = await layoutLabels([label(['Dana Smith', street, city])])
      for (const art of [laid!.pdf, laid!.page]) {
        const to = art.texts.filter((t) => t.kind === 'to')
        expect(
          to.map((t) => t.text),
          street,
        ).toEqual(['Dana Smith', street, city])
        expect(Math.min(...to.map((t) => t.size))).toBeGreaterThanOrEqual(9)
      }
    }
    // Too long even so: the apartment goes on the line above the street, as the post office
    // prefers, and the street line stays whole above the city.
    const long = '12345 North Broad Street, Apartment 1204, Building C'
    const [laid] = await layoutLabels([label(['Dana Smith', long, city])])
    const to = laid!.pdf.texts.filter((t) => t.kind === 'to')
    expect(to.map((t) => t.text)).toEqual([
      'Dana Smith',
      'Apartment 1204, Building C',
      '12345 North Broad Street',
      city,
    ])
    expect(Math.min(...to.map((t) => t.size))).toBeGreaterThanOrEqual(12)
  })

  it('wraps a long name to more rows instead of cutting it', async () => {
    const name = 'Estate of Margaret A Featherstonehaugh c/o Robert Featherstonehaugh'
    const [laid] = await layoutLabels([label([name, '1 Main St', 'Media, PA 19063'])])
    const to = laid!.pdf.texts.filter((t) => t.kind === 'to').map((t) => t.text)
    expect(to.join(' ')).not.toContain('…')
    expect(to.slice(0, -2).join(' ')).toBe(name)
    expect(to.slice(-2)).toEqual(['1 Main St', 'Media, PA 19063'])
  })

  it('prints the date and the reference in the strip, never a piece count', async () => {
    const laid = await layoutLabels([
      {
        ...label(['Dana Smith', '1 Main St', 'Media, PA 19063']),
        date: '10/25/2026',
        ref: 'PA-7Q2K9M',
      },
      {
        ...label(['Wei Wang', '901 Race St', 'Philadelphia, PA 19107']),
        date: '10/25/2026',
        ref: 'PA-X4B1RT',
      },
      label(['No Ref']),
    ])
    const meta = (i: number) =>
      laid[i]!.pdf.texts.filter((t) => t.kind === 'meta').map((t) => t.text)
    // "Piece 2 of 3" on a carrier label reads as more parcels coming to the same person.
    expect(meta(0)).toEqual(['DATE', '10/25/2026', 'REF', 'PA-7Q2K9M'])
    expect(meta(1)).toEqual(['DATE', '10/25/2026', 'REF', 'PA-X4B1RT'])
    // Missing values leave their cell blank, never "undefined".
    expect(meta(2)).toEqual(['DATE', 'REF'])
  })

  it('keeps a name the PDF cannot print as a blank line, so the address stays put and plain', async () => {
    const [chinese, latin] = await layoutLabels([
      label(['王伟', 'Wang Holdings', '901 Race St', 'Philadelphia, PA 19107']),
      label(['Wei Wang', 'Wang Holdings', '901 Race St', 'Philadelphia, PA 19107']),
    ])
    expect(chinese!.lossy).toBe(true)
    expect(chinese!.name).toBe('王伟')
    const company = (art: LabelArt) => art.texts.find((t) => t.text === 'Wang Holdings')!
    expect(company(chinese!.pdf).bold).toBe(false)
    expect(company(chinese!.pdf).y).toBe(company(latin!.pdf).y)
    expect(chinese!.pdf.texts.some((t) => t.text === '' && t.bold)).toBe(true)
    // The page prints the name as typed, in the same place.
    expect(chinese!.page.texts.find((t) => t.kind === 'to' && t.bold)!.text).toBe('王伟')
  })

  it('sets a label with only a name, and a return address without Theo’s name', async () => {
    const [laid] = await layoutLabels([
      { from: ['Prop Archive LLC', '1500 Market St'], to: ['Dana Smith'], site: '' },
    ])
    const texts = laid!.pdf.texts.filter((t) => t.kind === 'from' || t.kind === 'to')
    expect(texts.map((t) => t.text)).toEqual(['Prop Archive LLC', '1500 Market St', 'Dana Smith'])
    expect(laid!.pdf.texts.filter((t) => t.white).map((t) => t.text)).toEqual(['PROP ARCHIVE LLC'])
  })
})
