import { describe, expect, it } from 'vitest'
import {
  hasEmDash,
  isLlc,
  normaliseEmail,
  normalisePhone,
  normaliseStreet,
  normaliseZip5,
  slug,
  splitName,
  titleCase,
} from './text.ts'

describe('normaliseStreet', () => {
  it('uppercases, strips punctuation, abbreviates suffixes, collapses spaces', () => {
    expect(normaliseStreet('1234 N. Broad Street, Apt 2')).toBe('1234 N BROAD ST UNIT 2')
    expect(normaliseStreet('  45   south   52nd avenue ')).toBe('45 S 52ND AVE')
    expect(normaliseStreet('900 Market Rd.')).toBe('900 MARKET RD')
  })

  it('makes different spellings of one address equal', () => {
    const a = normaliseStreet('1234 North Broad St #2')
    const b = normaliseStreet('1234 N BROAD STREET UNIT 2')
    expect(a).toBe(b)
  })

  it('handles empty input', () => {
    expect(normaliseStreet('')).toBe('')
    expect(normaliseStreet(null)).toBe('')
    expect(normaliseStreet(undefined)).toBe('')
  })
})

describe('normaliseZip5', () => {
  it('keeps five digits', () => {
    expect(normaliseZip5('19104')).toBe('19104')
    expect(normaliseZip5('19104-2301')).toBe('19104')
    expect(normaliseZip5(' 19104 ')).toBe('19104')
    expect(normaliseZip5(19104)).toBe('19104')
  })
  it('pads short zips that lost a leading zero and empties junk', () => {
    expect(normaliseZip5('2134')).toBe('02134')
    expect(normaliseZip5('abc')).toBe('')
    expect(normaliseZip5(null)).toBe('')
  })
})

describe('titleCase', () => {
  it('title cases names and keeps company suffixes upper', () => {
    expect(titleCase('JOHN SMITH')).toBe('John Smith')
    expect(titleCase("o'brien")).toBe("O'Brien")
    expect(titleCase('SMITH-JONES')).toBe('Smith-Jones')
    expect(titleCase('MCDONALD')).toBe('McDonald')
    expect(titleCase('BROAD STREET HOLDINGS LLC')).toBe('Broad Street Holdings LLC')
    expect(titleCase('ACME INC.')).toBe('Acme INC')
  })
  it('handles empty', () => {
    expect(titleCase('')).toBe('')
    expect(titleCase(null)).toBe('')
  })
})

describe('isLlc', () => {
  it('detects companies', () => {
    expect(isLlc('BROAD STREET HOLDINGS LLC')).toBe(true)
    expect(isLlc('Acme Properties, L.L.C.')).toBe(true)
    expect(isLlc('Smith Family Trust')).toBe(true)
    expect(isLlc('PHILLY REALTY LP')).toBe(true)
    expect(isLlc('Fishtown Rentals Inc')).toBe(true)
  })
  it('does not flag people', () => {
    expect(isLlc('John Smith')).toBe(false)
    expect(isLlc('Maria Costa')).toBe(false)
    expect(isLlc('')).toBe(false)
    expect(isLlc(null)).toBe(false)
  })
})

describe('hasEmDash', () => {
  it('finds the em dash and nothing else', () => {
    expect(hasEmDash('a — b')).toBe(true)
    expect(hasEmDash('a - b')).toBe(false)
    expect(hasEmDash('a – b')).toBe(false) // en dash is allowed in empty cells
    expect(hasEmDash(null)).toBe(false)
  })
})

describe('slug', () => {
  it('makes url-safe slugs', () => {
    expect(slug('Point Breeze / Graduate Hospital')).toBe('point-breeze-graduate-hospital')
    expect(slug('  Hello, World!  ')).toBe('hello-world')
    expect(slug('Café Olé')).toBe('cafe-ole')
    expect(slug('')).toBe('')
  })
})

describe('normaliseEmail / normalisePhone', () => {
  it('lower-cases valid emails and drops junk', () => {
    expect(normaliseEmail(' Theo@Example.com ')).toBe('theo@example.com')
    expect(normaliseEmail('not an email')).toBe('')
  })
  it('keeps digits and drops a leading 1', () => {
    expect(normalisePhone('(215) 555-0100')).toBe('2155550100')
    expect(normalisePhone('+1 215 555 0100')).toBe('2155550100')
    expect(normalisePhone('')).toBe('')
  })
})

describe('splitName', () => {
  it('splits first and last', () => {
    expect(splitName('JOHN SMITH')).toEqual({ first_name: 'John', last_name: 'Smith' })
    expect(splitName('Maria de la Cruz')).toEqual({ first_name: 'Maria', last_name: 'De La Cruz' })
    expect(splitName('Cher')).toEqual({ first_name: 'Cher', last_name: '' })
    expect(splitName('')).toEqual({ first_name: '', last_name: '' })
  })
})
