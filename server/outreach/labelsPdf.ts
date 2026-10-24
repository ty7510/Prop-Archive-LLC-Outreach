import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import type { EnvelopeLabel } from './queue.ts'

/** A 4 x 6 in shipping label, portrait, in PDF points (72 a inch). */
const W = 4 * 72
const H = 6 * 72
const MARGIN = 0.3 * 72

/** The standard PDF fonts only know Windows-1252 letters; swap the rest for close ASCII. */
function safe(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}

/** Break one line into pieces that fit the width, on spaces where it can. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next
      continue
    }
    if (line) out.push(line)
    line = word
    while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
      let cut = line.length - 1
      while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--
      out.push(line.slice(0, cut))
      line = line.slice(cut)
    }
  }
  if (line) out.push(line)
  return out
}

/**
 * One 4 x 6 in portrait page per label: return address top left, the person's address below.
 * Black text only: a thermal label printer turns grey into speckles.
 */
export async function labelsPdf(labels: EnvelopeLabel[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle('Envelope labels')
  pdf.setProducer('Prop Archive Outreach')
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  for (const label of labels) {
    const page = pdf.addPage([W, H])
    let y = H - MARGIN - 9
    for (const raw of label.from) {
      for (const line of wrap(safe(raw), regular, 9, W - 2 * MARGIN)) {
        page.drawText(line, { x: MARGIN, y, size: 9, font: regular })
        y -= 12
      }
    }

    const toX = 0.5 * 72
    const toWidth = W - toX - MARGIN
    let size = 15
    // The name in bold, the rest plain; each line wrapped to the label's width.
    const fit = () =>
      label.to.flatMap((l, i) => {
        const font = i === 0 ? bold : regular
        return wrap(safe(l), font, size, toWidth).map((text) => ({ text, font }))
      })
    let lines = fit()
    // Shrink a long address until it fits the bottom part of the label.
    while (size > 9 && lines.length * size * 1.4 > H - 2.4 * 72 - MARGIN) {
      size -= 1
      lines = fit()
    }
    let toY = H - 2.4 * 72 - size
    for (const { text, font } of lines) {
      page.drawText(text, { x: toX, y: toY, size, font })
      toY -= size * 1.4
    }
  }
  return pdf.save()
}
