import {
  Duplex,
  grayscale,
  PDFDocument,
  PrintScaling,
  setCharacterSpacing,
  StandardFonts,
} from 'pdf-lib'
import { LABEL_H, LABEL_W, layoutLabels, type EnvelopeLabel } from './labelLayout.ts'
import { LABEL_MARK } from './labelMark.ts'

export interface LabelsPdfInfo {
  title?: string
  author?: string
  date?: Date
}

/** A rounded rectangle as an SVG path, from its top left corner (Bezier corners). */
function roundedRect(w: number, h: number, r: number): string {
  const k = r * 0.4477
  return [
    `M${r} 0H${w - r}C${w - k} 0 ${w} ${k} ${w} ${r}`,
    `V${h - r}C${w} ${h - k} ${w - k} ${h} ${w - r} ${h}`,
    `H${r}C${k} ${h} 0 ${h - k} 0 ${h - r}`,
    `V${r}C0 ${k} ${k} 0 ${r} 0Z`,
  ].join('')
}

/**
 * One 4 x 6 in portrait page per label, as laid out in labelLayout.ts: the black brand band, the
 * return address, the person's address. Pure black only (a thermal printer turns grey into
 * speckles), and the file asks the viewer to print at 100% on paper of the page's size.
 */
export async function labelsPdf(
  labels: EnvelopeLabel[],
  info: LabelsPdfInfo = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const date = info.date ?? new Date()
  pdf.setTitle(info.title ?? 'Envelope labels', { showInWindowTitleBar: true })
  pdf.setSubject(
    `${labels.length} envelope ${labels.length === 1 ? 'label' : 'labels'}, 4 x 6 in, one per page`,
  )
  pdf.setAuthor(info.author ?? 'Prop Archive LLC')
  pdf.setCreator('Prop Archive Outreach')
  pdf.setProducer('Prop Archive Outreach')
  pdf.setLanguage('en-US')
  pdf.setCreationDate(date)
  pdf.setModificationDate(date)
  const prefs = pdf.catalog.getOrCreateViewerPreferences()
  prefs.setPrintScaling(PrintScaling.None)
  prefs.setPickTrayByPDFSize(true)
  prefs.setDuplex(Duplex.Simplex)

  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const black = grayscale(0)
  const white = grayscale(1)

  for (const { pdf: art } of await layoutLabels(labels)) {
    const page = pdf.addPage([LABEL_W, LABEL_H])
    const { band, mark } = art
    page.drawSvgPath(roundedRect(band.width, band.height, band.radius), {
      x: band.x,
      y: LABEL_H - band.y,
      color: black,
    })
    page.drawSvgPath(LABEL_MARK.d, {
      x: mark.x,
      y: LABEL_H - mark.y,
      scale: mark.width / LABEL_MARK.width,
      color: white,
    })
    for (const r of art.rules) {
      page.drawRectangle({
        x: r.x,
        y: LABEL_H - r.y - r.height,
        width: r.width,
        height: r.height,
        color: black,
      })
    }
    for (const t of art.texts) {
      if (!t.text) continue
      if (t.tracking) page.pushOperators(setCharacterSpacing(t.tracking))
      page.drawText(t.text, {
        x: t.x,
        y: LABEL_H - t.y,
        size: t.size,
        font: t.bold ? bold : regular,
        color: t.white ? white : black,
      })
      if (t.tracking) page.pushOperators(setCharacterSpacing(0))
    }
  }
  return pdf.save()
}
