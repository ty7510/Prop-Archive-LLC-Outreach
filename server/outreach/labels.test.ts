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
    expect(pages.join('\n')).toContain('PROP ARCHIVE')
    expect(pages.join('\n')).toContain('Theo Young')
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
  it('keeps every line inside the label, the person well below the return address', async () => {
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
        expect(t.x).toBeGreaterThanOrEqual(0.2 * 72)
        expect(t.x + t.width).toBeLessThanOrEqual(LABEL_W - 0.2 * 72 + 0.01)
        expect(t.y).toBeLessThanOrEqual(LABEL_H - 0.2 * 72)
      }
      const big = art.texts.filter((t) => !t.white && t.size >= 12)
      const small = art.texts.filter((t) => !t.white && t.size < 12)
      expect(Math.min(...big.map((t) => t.y))).toBeGreaterThan(
        Math.max(...small.map((t) => t.y)) + 30,
      )
      // Never under 12 pt, the city line last.
      expect(big.at(-1)!.text).toBe('Philadelphia, PA 19122-4321')
    }
    expect(laid!.pdf).toEqual(laid!.page)
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
    expect(chinese!.page.texts.find((t) => t.bold && !t.white && t.size > 12)!.text).toBe('王伟')
  })

  it('sets a label with only a name, and a return address without Theo’s name', async () => {
    const [laid] = await layoutLabels([
      { from: ['Prop Archive LLC', '1500 Market St'], to: ['Dana Smith'], site: '' },
    ])
    const texts = laid!.pdf.texts.filter((t) => !t.white)
    expect(texts.map((t) => t.text)).toEqual(['Prop Archive LLC', '1500 Market St', 'Dana Smith'])
    expect(laid!.pdf.texts.filter((t) => t.white).map((t) => t.text)).toEqual(['PROP ARCHIVE'])
  })
})
