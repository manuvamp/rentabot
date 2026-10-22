// Pure target guard for the web egress Worker (no Workers or Node APIs, so Node tests import it directly).
// Refuses anything that is not a plain public http(s) URL on a standard port.

export type GuardResult = { ok: true; url: URL } | { ok: false; reason: string }

const BLOCKED_NAMES = /^(?:localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|metadata|metadata\.google\.internal|instance-data|broadcasthost)$/
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa', '.in-addr.arpa', '.ip6.arpa', '.onion']

// [network, prefix bits] for IPv4
const V4_BLOCKED: [number, number][] = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local incl. 169.254.169.254 metadata
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const
).map(([a, b]) => [v4ToInt(a)!, b])

export function v4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((n) => n > 255)) return null
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0
}

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([net, bits]) => (bits === 0 ? true : (n >>> (32 - bits)) === (net >>> (32 - bits))))
}

/** Eight 16-bit groups, or null when not an IPv6 literal. */
export function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const n = v4ToInt(tail[1]!)
    if (n === null) return null
    s = s.slice(0, -tail[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const parts = s.split('::')
  if (parts.length > 2) return null
  const h = parts[0] ? parts[0].split(':') : []
  const r = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : []
  const fill = parts.length === 2 ? 8 - h.length - r.length : 0
  if (fill < 0) return null
  const all = [...h, ...Array<string>(fill).fill('0'), ...r]
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return all.map((g) => parseInt(g, 16))
}

function v6Blocked(g: number[]): boolean {
  const zeroHead = g.slice(0, 5).every((x) => x === 0)
  if (zeroHead && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true // :: and ::1
    return v4Blocked(((g[6]! << 16) | g[7]!) >>> 0) // v4-mapped / v4-compatible
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(((g[6]! << 16) | g[7]!) >>> 0) // NAT64
  if (g[0] === 0x2002) return v4Blocked(((g[1]! << 16) | g[2]!) >>> 0) // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 unique local (incl. fd00:ec2::254 metadata)
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true // discard 100::/64
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true // 2001::/23 IETF special (Teredo, ORCHID, benchmarking)
  return false
}

/** True for an IP literal (v4 or v6) in a private, loopback, link-local, CGNAT, metadata or reserved range. */
export function isBlockedIpLiteral(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '')
  const n = v4ToInt(bare)
  if (n !== null) return v4Blocked(n)
  const g = expandV6(bare)
  return g ? v6Blocked(g) : false
}

/** Validate one target URL (called for the request and again for every redirect hop). */
export function checkTarget(raw: string): GuardResult {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid url' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} not allowed` }
  if (u.username || u.password) return { ok: false, reason: 'credentials in url not allowed' }
  // WHATWG URL drops the default port, so anything left is non-standard (443 on http and 80 on https included).
  if (u.port !== '') return { ok: false, reason: `port ${u.port} not allowed` }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return { ok: false, reason: 'no host' }
  const isV4 = v4ToInt(host) !== null
  const isV6 = !isV4 && expandV6(host) !== null
  if (isV4 || isV6) {
    if (isBlockedIpLiteral(host)) return { ok: false, reason: 'address not public' }
    return { ok: true, url: u }
  }
  if (BLOCKED_NAMES.test(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: 'host not public' }
  if (!host.includes('.')) return { ok: false, reason: 'single-label host not allowed' }
  return { ok: true, url: u }
}

/** Constant-time string compare (length is not secret here, the content is). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
