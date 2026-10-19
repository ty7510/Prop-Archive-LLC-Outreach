import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { allowedUrl, decodeCfEmail, getOnce, isBlockedPage, pageText } from './pageCheck.ts'
import {
  checkContacts,
  nameWords,
  normaliseContact,
  streetKey,
  streetKeysIn,
  type ContactEvidence,
  type OwnerFacts,
} from './verify.ts'

const facts: OwnerFacts = {
  full_name: 'Daniel Liez',
  first_name: 'Daniel',
  last_name: 'Liez',
  company: 'Sunrise Center City LLC',
  mailing_street: '4253 Regent Sq',
  property_addresses: ['1022 PINE ST', '650 N 54TH ST'],
}

const LISTING = 'https://hotpads.com/1022-pine-st-phila-pa-19107-tnv33c/202/pad'

function evidence(patch: Partial<ContactEvidence>): ContactEvidence {
  return {
    field: 'phone',
    value: '(610) 209-5093',
    role: 'owner',
    source_url: LISTING,
    quote: '1022 Pine St #202, Philadelphia. Listed by Daniel Liez (610) 209-5093',
    ...patch,
  }
}

/** The source pages say exactly what their quotes say. */
function pagesOf(list: ContactEvidence[]): Map<string, string | null> {
  return new Map(list.map((e) => [e.source_url, e.quote]))
}

function check(list: ContactEvidence[], pages = pagesOf(list), f = facts) {
  return checkContacts(list, f, pages)
}

describe('street keys', () => {
  it('match an address however it is written', () => {
    expect(streetKey('1022 Pine Street #202')).toBe('1022 PINE')
    expect(streetKey('650 N. 54th Street')).toBe('650 54TH')
    expect(streetKey('Pine St')).toBeNull()
    expect([...streetKeysIn('Studio at 1022 Pine St, $1,190. Also 650 North 54th St.')]).toEqual(
      expect.arrayContaining(['1022 PINE', '650 54TH']),
    )
  })

  it('reads a house number range from the records as its first number', () => {
    expect(streetKey('2151-53 CROSS ST')).toBe('2151 CROSS')
    expect(streetKey('905-07 S 48TH ST')).toBe('905 48TH')
    expect(streetKey('1839-47 BLAIR ST Unit 11')).toBe('1839 BLAIR')
    expect([...streetKeysIn('Lagos Homes, 2151 Cross st, Philadelphia')]).toContain('2151 CROSS')
    expect([...streetKeysIn('1839-47 Blair St unit 3')]).toContain('1839 BLAIR')
    expect([...streetKeysIn('905 S 48TH STREET 07 PHILADELPHIA')]).toContain('905 48TH')
  })
})

describe('checkContacts', () => {
  it('verifies a phone the page shows at their property under their name', () => {
    const [c] = check([evidence({})])
    expect(c).toMatchObject({ value: '6102095093', verdict: 'verified', page: 'confirmed' })
  })

  it('keeps a listing phone with no owner name at "likely": it may be the leasing agent', () => {
    const [c] = check([evidence({ quote: '1022 Pine St #202. Call (610) 209-5093' })])
    expect(c).toMatchObject({ verdict: 'likely', page: 'confirmed' })
    expect(c!.reason).toContain("not that it is the owner's own")
  })

  it('never verifies what the server could not open, and rejects what the page contradicts', () => {
    const e = evidence({})
    expect(check([e], new Map())[0]).toMatchObject({ verdict: 'likely', page: 'unreachable' })
    const wrongPage = new Map([[LISTING, '1022 Pine St. Daniel Liez (610) 209-0000']])
    expect(check([e], wrongPage)[0]).toMatchObject({ verdict: 'rejected', page: 'contradicted' })
    const noTieOnPage = new Map([[LISTING, 'Call (610) 209-5093 for apartments']])
    expect(check([e], noTieOnPage)[0]!.verdict).toBe('rejected')
  })

  it('verifies a contact the page ties to their mailing address', () => {
    const [c] = check([
      evidence({ quote: 'D. Liez, 4253 Regent Square, Philadelphia. Tel 610 209 5093' }),
    ])
    expect(c!.verdict).toBe('verified')
  })

  it('calls a name or company match likely, never verified', () => {
    const [byName, byCompany] = check([
      evidence({ quote: 'Daniel Liez, Keystone Floor Works, 610-209-5093' }),
      evidence({
        source_url: 'https://example.com/b',
        quote: 'Sunrise Center City LLC (610) 209-5093',
      }),
    ])
    expect(byName!.verdict).toBe('likely')
    expect(byCompany!.verdict).toBe('likely')
  })

  it('verifies a site whose page shows an already verified phone', () => {
    const list = [
      evidence({
        field: 'website',
        value: 'keystonefloorworks.com',
        source_url: 'https://www.keystonefloorworks.com/contact',
        quote: 'Keystone Floor Works, keystonefloorworks.com, call 610-209-5093',
      }),
      evidence({}), // the phone, checked first whatever the order
    ]
    const site = check(list).find((c) => c.field === 'website')
    expect(site).toMatchObject({ value: 'https://keystonefloorworks.com', verdict: 'verified' })
  })

  it("verifies a manager's line at their property as the manager's, not the owner's", () => {
    const [c] = check([
      evidence({ role: 'manager', quote: '1022 Pine St, managed by Next Door, (610) 209-5093' }),
    ])
    expect(c).toMatchObject({ role: 'manager', verdict: 'verified' })
  })

  it('rejects a value the quote does not show, a missing source, and an untied source', () => {
    const [wrong, noSource, untied] = check([
      evidence({ value: '610-209-0000' }),
      evidence({ source_url: '' }),
      evidence({
        source_url: 'https://example.com/u',
        quote: 'Call 610-209-5093 for apartments in Center City',
      }),
    ])
    expect(wrong!.verdict).toBe('rejected')
    expect(noSource!.verdict).toBe('rejected')
    expect(untied).toMatchObject({
      verdict: 'rejected',
      reason: 'nothing ties the source to this owner',
    })
  })

  it('takes the tie from a separate quote of the same source', () => {
    const [c] = check(
      [
        evidence({
          quote: 'Call (610) 209-5093',
          tie_quote: 'Daniel Liez, 4253 Regent Square, Philadelphia',
        }),
      ],
      new Map([[LISTING, 'Call (610) 209-5093. Daniel Liez, 4253 Regent Square, Philadelphia']]),
    )
    expect(c).toMatchObject({ verdict: 'verified', page: 'confirmed' })
  })

  it('takes the tie from anywhere on the opened page when the quotes miss it', () => {
    const list = [evidence({ quote: 'Call (610) 209-5093' })]
    const pages = new Map([
      [LISTING, 'Studio at 1022 Pine St. Listed by Daniel Liez. (610) 209-5093'],
    ])
    expect(check(list, pages)[0]).toMatchObject({ verdict: 'verified', page: 'confirmed' })
  })

  it('takes the value from the opened page when the quote only shows the address', () => {
    const list = [evidence({ quote: '1022 Pine St #202, Philadelphia, Daniel Liez' })]
    const pages = new Map([[LISTING, '1022 Pine St #202. Daniel Liez. Call (610) 209-5093']])
    expect(check(list, pages)[0]).toMatchObject({ verdict: 'verified' })
    // Blocked page: the quotes alone never show the phone, so it stays rejected.
    expect(check(list, new Map())[0]!.verdict).toBe('rejected')
  })

  it('ties a profile whose link carries their first and last name, as likely only', () => {
    const potter: OwnerFacts = {
      ...facts,
      full_name: 'Jonathan Potter',
      first_name: 'Jonathan',
      last_name: 'Potter',
    }
    const url = 'https://www.linkedin.com/in/jonathan-potter-4a1b2c'
    const [c] = checkContacts(
      [
        evidence({
          field: 'linkedin_url',
          value: url,
          source_url: url,
          quote: 'Owner, Philadelphia',
        }),
      ],
      potter,
    )
    expect(c).toMatchObject({ verdict: 'likely', reason: expect.stringContaining('profile link') })
    const [other] = checkContacts(
      [
        evidence({
          field: 'linkedin_url',
          value: 'https://www.linkedin.com/in/jpotts',
          source_url: url,
          quote: 'jpotts',
        }),
      ],
      potter,
    )
    expect(other!.verdict).toBe('rejected')
  })

  it('needs both first and last name, and a company word longer than a few letters', () => {
    const shortCompany: OwnerFacts = { ...facts, first_name: null, company: 'M & M LLC' }
    const list = [
      evidence({ quote: 'Liez 610-209-5093' }),
      evidence({ source_url: 'https://example.com/m', quote: 'M & M LLC 610-209-5093' }),
    ]
    const [lastOnly, mm] = check(list, pagesOf(list), shortCompany)
    expect(lastOnly!.verdict).toBe('rejected')
    expect(mm!.verdict).toBe('rejected')
  })
})

describe('names written another way', () => {
  const smith: OwnerFacts = {
    ...facts,
    full_name: 'Smith John A',
    first_name: 'Smith',
    last_name: 'John A',
    company: null,
  }

  it('reads the words of a name without initials or titles, in any order', () => {
    expect(nameWords(smith)).toEqual(['SMITH', 'JOHN'])
    expect(
      nameWords({ full_name: "Mary O'Brien-Kelly Jr", first_name: null, last_name: null }),
    ).toEqual(['MARY', 'OBRIEN KELLY'])
    expect(
      nameWords({ full_name: 'Karl &amp; Evelyn Baptiste', first_name: null, last_name: null }),
    ).toEqual(['KARL', 'EVELYN', 'BAPTISTE'])
  })

  it('ties a page that writes "John Smith" to a record that says "Smith John A"', () => {
    const list = [evidence({ quote: 'Call John Smith at 610-209-5093 about 1022 Pine St' })]
    expect(check(list, pagesOf(list), smith)[0]).toMatchObject({ verdict: 'verified' })
    const middle: OwnerFacts = {
      ...smith,
      full_name: 'John A Smith',
      first_name: 'John',
      last_name: 'A Smith',
    }
    const named = [evidence({ quote: 'John Smith, landlord, 610-209-5093' })]
    expect(check(named, pagesOf(named), middle)[0]).toMatchObject({ verdict: 'likely' })
  })

  it('keeps a hyphenated surname as one word', () => {
    const buda: OwnerFacts = {
      ...smith,
      full_name: 'Gabriel Buda-Levin',
      first_name: 'Gabriel',
      last_name: 'Buda-Levin',
    }
    const list = [
      evidence({ quote: 'Gabe Buda-Levin 610-209-5093' }),
      evidence({ source_url: 'https://example.com/b', quote: 'Gabriel Buda Levin 610-209-5093' }),
    ]
    expect(check(list, pagesOf(list), buda).map((c) => c.verdict)).toEqual(['rejected', 'likely'])
  })

  it('matches whole words only, and needs two of them', () => {
    const ann: OwnerFacts = { ...smith, full_name: 'Ann Lee', first_name: 'Ann', last_name: 'Lee' }
    const list = [
      evidence({ quote: 'Anna Leeds 610-209-5093' }),
      evidence({ source_url: 'https://example.com/b', quote: 'Ms. Lee 610-209-5093' }),
      evidence({ source_url: 'https://example.com/c', quote: 'ANN LEE 610-209-5093' }),
    ]
    expect(check(list, pagesOf(list), ann).map((c) => c.verdict)).toEqual([
      'rejected',
      'rejected',
      'likely',
    ])
  })

  it('ties a profile link carrying two words of a three-part name', () => {
    const coleman: OwnerFacts = {
      ...facts,
      full_name: 'Pasquilina Follone Coleman',
      first_name: 'Pasquilina',
      last_name: 'Follone Coleman',
    }
    const url = 'https://www.linkedin.com/in/pasquilina-coleman-12ab'
    const [c] = checkContacts(
      [evidence({ field: 'linkedin_url', value: url, source_url: url, quote: 'Realtor' })],
      coleman,
    )
    expect(c).toMatchObject({ verdict: 'likely', reason: expect.stringContaining('profile link') })
  })
})

describe('normaliseContact', () => {
  it('accepts real profile and site links only', () => {
    expect(normaliseContact('linkedin_url', 'https://www.linkedin.com/in/dliez')).toEqual({
      value: 'https://www.linkedin.com/in/dliez',
    })
    expect('problem' in normaliseContact('linkedin_url', 'https://example.com/dliez')).toBe(true)
    expect('problem' in normaliseContact('instagram_url', 'https://instagram.com/p/abc123')).toBe(
      true,
    )
    expect('problem' in normaliseContact('facebook_url', 'https://facebook.com/search?q=x')).toBe(
      true,
    )
    expect('problem' in normaliseContact('website', 'https://www.zillow.com/homedetails/x')).toBe(
      true,
    )
    expect('problem' in normaliseContact('website', 'https://www.apartments.com/x')).toBe(true)
    expect(normaliseContact('website', 'keystonefloorworks.com')).toEqual({
      value: 'https://keystonefloorworks.com',
    })
    expect('problem' in normaliseContact('phone', '555-0199')).toBe(true)
    expect('problem' in normaliseContact('email', 'not-an-email')).toBe(true)
  })
})

describe('opening source pages', () => {
  it('only opens public http(s) pages on the normal ports, never a numeric address', () => {
    expect(allowedUrl('https://hotpads.com/x')).not.toBeNull()
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://169.254.169.254/latest',
      'https://hotpads.com:8443/x',
      'https://user:pass@hotpads.com/',
    ]) {
      expect(allowedUrl(bad), bad).toBeNull()
    }
  })

  it('reads the words of a page', () => {
    expect(
      pageText('<html><script>x()</script><p>1022 Pine&nbsp;St</p><b>(610) 209-5093</b></html>'),
    ).toBe('1022 Pine St (610) 209-5093')
  })

  it('keeps what a visitor can reach but the words leave out', () => {
    // Cloudflare hides john@sunrise.com behind data-cfemail; key 0x42.
    const key = 0x42
    const hex =
      key.toString(16) +
      [...'john@sunrise.com']
        .map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
        .join('')
    expect(decodeCfEmail(hex)).toBe('john@sunrise.com')
    const html = `<p>Contact</p>
      <a href="mailto:Daniel%40sunrisephilly.com?subject=Hi">Email us</a>
      <a href="tel:+16102095093">Call</a>
      <span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span>
      <script type="application/ld+json">{"telephone":"215-555-0101","url":"https:\\/\\/sunrise.com"}</script>
      <p>info&#x40;sunrise&period;com</p>`
    const text = pageText(html)
    for (const part of [
      'Daniel@sunrisephilly.com',
      '+16102095093',
      'john@sunrise.com',
      '215-555-0101',
      'https://sunrise.com',
      'info@sunrise.com',
    ]) {
      expect(text).toContain(part)
    }
  })

  it('treats a bot check or an empty shell as a page it could not open', () => {
    const words = 'Sunrise Center City rentals at 1022 Pine St. '.repeat(10)
    expect(isBlockedPage('<div id="root"></div>')).toBe(true)
    expect(
      isBlockedPage(
        `<html><head><title>Just a moment...</title></head><body>${words}<script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>`,
      ),
    ).toBe(true)
    expect(isBlockedPage(`<html><title>Sunrise</title><body>${words}</body></html>`)).toBe(false)
    // Cloudflare's bot script sits on ordinary pages too.
    expect(
      isBlockedPage(
        `<html><title>905 S 48th Street</title><body>${words}<script>a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'</script></body></html>`,
      ),
    ).toBe(false)
    // A contact form protected by reCAPTCHA is a normal page.
    expect(
      isBlockedPage(`<html><body>${words}<div class="g-recaptcha"></div> captcha</body></html>`),
    ).toBe(false)
  })
})

describe('a hostile page cannot hold a research run', () => {
  // Local test servers are private, so these tests pass a lookup that allows them.
  const anyLookup: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) {
      ;(cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ])
    } else cb(null, '127.0.0.1', 4)
  }

  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler)
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const port = (server.address() as AddressInfo).port
    return { server, url: new URL(`http://test.local:${port}/`) }
  }

  it('gives up on a page that drips one byte at a time, at the deadline', async () => {
    const { server, url } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      const t = setInterval(() => res.write('a'), 50)
      res.on('close', () => clearInterval(t))
    })
    const started = Date.now()
    await expect(getOnce(url, { lookup: anyLookup, deadlineMs: 400 })).rejects.toThrow('deadline')
    expect(Date.now() - started).toBeLessThan(2000)
    server.close()
  })

  it('stops reading a page bigger than the cap', async () => {
    const { server, url } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('x'.repeat(3_000_000))
    })
    await expect(getOnce(url, { lookup: anyLookup })).rejects.toThrow('page too large')
    server.close()
  })

  it('reads a normal page', async () => {
    const { server, url } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<p>1022 Pine St</p>')
    })
    await expect(getOnce(url, { lookup: anyLookup })).resolves.toMatchObject({
      status: 200,
      body: '<p>1022 Pine St</p>',
    })
    server.close()
  })
})
