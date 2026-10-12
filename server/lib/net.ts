// Network address checks shared by everything that connects to a host a user or a web page named
// (inbox servers, research source pages): only the public internet is reachable.
import { isIP } from 'node:net'

/** IPv4 ranges that are not the public internet (IANA special-purpose registry). */
const IPV4_BLOCKED: [number, number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, cloud metadata
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // 6to4 relay
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 3], // multicast, reserved, broadcast (224.0.0.0 and up)
]

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0)
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
export function ipv6Groups(address: string): number[] | null {
  let a = address.toLowerCase()
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  // A dotted IPv4 tail (::ffff:10.0.0.1) becomes two hex groups.
  const lastColon = a.lastIndexOf(':')
  const tail = a.slice(lastColon + 1)
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null
    const n = ipv4ToInt(tail)
    a = `${a.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

/**
 * True for every address the app must not connect to. Fails closed: anything that does not parse,
 * and every IPv6 address outside global unicast (2000::/3), is blocked. That covers loopback,
 * private, link-local and site-local, unique-local, multicast, IPv4-mapped and NAT64 forms, plus
 * 6to4, Teredo and documentation ranges, which can carry or stand in for a private address.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const n = ipv4ToInt(ip)
    return IPV4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return (n & mask) >>> 0 === base
    })
  }
  if (kind !== 6) return true
  const g = ipv6Groups(ip)
  if (!g) return true
  const [g0 = 0, g1 = 0] = g
  if ((g0 & 0xe000) !== 0x2000) return true // not global unicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true // documentation
  if (g0 === 0x2001 && g1 === 0x0000) return true // Teredo
  if (g0 === 0x2002) return true // 6to4 carries an IPv4 address
  return false
}
