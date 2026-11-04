import { describe, expect, it } from 'vitest'
import { csvCell } from './leadsCsv.ts'

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(14)).toBe('14')
  })

  it('stops a cell from running as a spreadsheet formula, but leaves phone numbers alone', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('  =1+1')).toBe("'  =1+1")
    expect(csvCell('\t=1')).toBe("'\t=1")
    expect(csvCell('+1 (215) 555-0102')).toBe('+1 (215) 555-0102')
    expect(csvCell('215-555-0102')).toBe('215-555-0102')
    expect(csvCell('-3')).toBe('-3')
  })
})
