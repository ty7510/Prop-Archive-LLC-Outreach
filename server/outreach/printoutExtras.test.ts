import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRINTOUT_BIO,
  DEFAULT_PRINTOUT_CLOSING,
  DEFAULT_PRINTOUT_FEATURES,
  DEFAULT_PRINTOUT_OVERVIEW,
  PAGE_ONE_EXTRAS,
  PAGE_ONE_PS,
  PAGE_TWO_EXTRAS,
  PRINTOUT_FIT_SCRIPT,
  printoutSection,
} from '../../shared/printout.ts'

const html = printoutSection({
  heading: 'How Prop Archive can help Fairmount Rentals',
  body: 'A short letter.',
  overview: DEFAULT_PRINTOUT_OVERVIEW,
  features: DEFAULT_PRINTOUT_FEATURES,
  bio: DEFAULT_PRINTOUT_BIO,
  closing: DEFAULT_PRINTOUT_CLOSING,
  preparedFor: ['Jane Smith'],
  date: 'October 27, 2026',
  ownerName: 'Theo Young',
  email: 'theo@proparchive.biz',
  site: 'proparchive.app',
  city: 'Philadelphia, PA',
  photo: '',
})

describe('printout extra sections', () => {
  it('prints every extra section hidden, so only the fit script can add one', () => {
    const extras = html.match(/<[a-z]+ class="op-extra[^"]*"[^>]*>/g) ?? []
    expect(extras).toHaveLength(PAGE_ONE_EXTRAS.length + PAGE_TWO_EXTRAS.length + 2)
    for (const tag of extras) expect(tag).toMatch(/ hidden>$/)
  })

  it('adds at most one card section and one short line per page', () => {
    expect(PRINTOUT_FIT_SCRIPT).toContain('.op-extra:not(.op-small)')
    expect(PRINTOUT_FIT_SCRIPT).toContain('.op-extra.op-small')
    expect(PRINTOUT_FIT_SCRIPT).toContain('[null].concat(cards)')
    expect(html.match(/op-extra op-small/g)).toHaveLength(2)
  })

  it('keeps the wording free of em-dashes', () => {
    const words = [
      PAGE_ONE_PS,
      ...[...PAGE_ONE_EXTRAS, ...PAGE_TWO_EXTRAS].flatMap((x) => [
        x.title,
        ...x.cards.flatMap((c) => [c.title, c.text]),
      ]),
    ]
    for (const w of words) expect(w).not.toContain('—')
  })
})
