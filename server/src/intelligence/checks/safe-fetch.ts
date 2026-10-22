// SSRF-guarded HTTP GET for checks that visit URLs supplied by agents.
// - http/https only, no credentials in the URL, at most `maxRedirects` hops (each hop re-checked)
// - every address a hostname resolves to must be public; the check happens inside the socket's
//   DNS lookup, so the IP we validate is the IP we connect to (no DNS-rebinding window)
// - hosts in `allowHosts` ("host" or "host:port") skip the address check (the server's own Sandbox Web)
// - total time and decoded body size are capped
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import type { LookupFunction } from 'node:net'
import { chooseRoute, egressGet, isInternalTarget, webEgressFromEnv, type WebEgress } from './web-egress.ts'

export class BlockedUrl extends Error {}

export interface FetchOptions {
  allowHosts?: string[]
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** Web egress Worker for IPv4-only hosts. Default: WEB_EGRESS_URL/WEB_EGRESS_SECRET from the env; null = always direct. */
  egress?: WebEgress | null
  /** Resolver used for the routing decision (tests). Default: dns.lookup(all). */
  lookupAll?: (host: string) => Promise<{ address: string; family: number }[]>
  /** fetch used to call the egress Worker (tests). */
  egressFetch?: typeof fetch
}

export interface FetchHop {
  url: string
  status: number
  location: string | null
}

export interface FetchResult {
  url: string // final URL
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  hops: FetchHop[]
  ms: number
}

export type SafeFetch = (url: string, opts?: FetchOptions) => Promise<FetchResult>

const blocked = new net.BlockList()
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const)
  blocked.addSubnet(addr, bits, 'ipv4')
for (const [addr, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local (incl. fd00:ec2::254 metadata)
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
  ['2001:db8::', 32],
  ['100::', 64],
] as const)
  blocked.addSubnet(addr, bits, 'ipv6')

/** IPv4 embedded in an IPv6 address (mapped, compatible, NAT64, 6to4), if any. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase()
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]!
  const groups = expandV6(lower)
  if (!groups) return null
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  // ::ffff:a.b.c.d and ::a.b.c.d written in hex
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    if (groups[5] === 0 && groups[6] === 0) return null // ::, ::1 handled by the v6 list
    return v4(groups[6]!, groups[7]!)
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return v4(groups[6]!, groups[7]!) // NAT64
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!) // 6to4
  return null
}

function expandV6(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null
  let s = ip.split('%')[0]!
  const tail = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number]
    s = s.slice(0, -tail[0].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, rest] = s.split('::') as [string, string | undefined]
  const h = head ? head.split(':') : []
  const r = rest !== undefined ? (rest ? rest.split(':') : []) : []
  const fill = rest !== undefined ? 8 - h.length - r.length : 0
  const all = [...h, ...Array(fill).fill('0'), ...r]
  if (all.length !== 8) return null
  return all.map((g) => parseInt(g || '0', 16))
}

/** True when an IP literal is private, loopback, link-local, metadata, multicast or reserved. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]!
  const family = net.isIP(bare)
  if (family === 4) return blocked.check(bare, 'ipv4')
  if (family === 6) {
    const v4 = embeddedV4(bare)
    if (v4) return blocked.check(v4, 'ipv4')
    return blocked.check(bare, 'ipv6')
  }
  return true // not an IP at all: refuse
}

function hostKey(u: URL) {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return { host, hostPort: `${host}:${port}` }
}

export function isAllowedHost(u: URL, allowHosts: string[]): boolean {
  const { host, hostPort } = hostKey(u)
  return allowHosts.some((a) => {
    const x = a.toLowerCase().replace(/^\[|\]$/g, '')
    return x === hostPort || x === host
  })
}

/** Throws BlockedUrl when a URL must not be fetched before any DNS happens. */
export function assertFetchableUrl(raw: string, allowHosts: string[] = []): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new BlockedUrl(`not a valid URL: ${raw.slice(0, 100)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrl(`scheme ${u.protocol} not allowed`)
  if (u.username || u.password) throw new BlockedUrl('credentials in URL not allowed')
  if (isAllowedHost(u, allowHosts)) return u
  const { host } = hostKey(u)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === 'metadata.google.internal')
    throw new BlockedUrl(`host ${host} is not public`)
  if (net.isIP(host) && isBlockedIp(host)) throw new BlockedUrl(`address ${host} is not public`)
  return u
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = addresses as dns.LookupAddress[]
    const bad = list.find((a) => isBlockedIp(a.address))
    if (bad || list.length === 0) {
      return callback(new BlockedUrl(`${hostname} resolves to a non-public address${bad ? ` (${bad.address})` : ''}`), '', 0)
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}

function getOnce(u: URL, allowed: boolean, deadline: number, maxBytes: number) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new Error('timed out'))
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: { 'user-agent': 'RentABot-CheckRunner/0.1', accept: 'text/html,text/plain,application/json,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
        lookup: allowed ? undefined : guardedLookup,
        timeout: remaining,
        agent: false,
      },
      (res) => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({ status, headers, body: '', truncated: false })
        }
        const enc = (headers['content-encoding'] ?? '').toLowerCase()
        const stream =
          enc === 'gzip' || enc === 'x-gzip'
            ? res.pipe(zlib.createGunzip())
            : enc === 'deflate'
              ? res.pipe(zlib.createInflate())
              : enc === 'br'
                ? res.pipe(zlib.createBrotliDecompress())
                : res
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        stream.on('data', (c: Buffer) => {
          if (truncated) return
          const room = maxBytes - size
          if (c.length >= room) {
            chunks.push(c.subarray(0, room))
            size = maxBytes
            truncated = true
            req.destroy()
            resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8'), truncated })
            return
          }
          chunks.push(c)
          size += c.length
        })
        stream.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8'), truncated }))
        stream.on('error', (e) => (truncated ? undefined : reject(e)))
      },
    )
    // Hard wall-clock cap (the socket `timeout` above is only an idle timeout).
    const timer = setTimeout(() => req.destroy(new Error('timed out')), remaining)
    req.on('close', () => clearTimeout(timer))
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

export async function safeFetch(raw: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const allowHosts = opts.allowHosts ?? []
  const timeoutMs = Math.min(opts.timeoutMs ?? 8000, 20_000)
  const maxBytes = opts.maxBytes ?? 1_000_000
  const maxRedirects = opts.maxRedirects ?? 3
  const started = Date.now()
  const deadline = started + timeoutMs
  const hops: FetchHop[] = []
  let current = raw
  const egress = opts.egress === undefined ? webEgressFromEnv() : opts.egress
  const lookupAll = opts.lookupAll ?? ((h: string) => dns.promises.lookup(h, { all: true }))
  for (let i = 0; ; i++) {
    const u = assertFetchableUrl(current, allowHosts)
    const allowed = isAllowedHost(u, allowHosts)
    const internal = isInternalTarget(u, allowHosts, egress)
    if (egress && !internal) {
      // Same address rule as the direct path, then: IPv6 host -> direct first; IPv4-only host -> the Worker.
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookupAll(host)
      const bad = addrs.find((a) => isBlockedIp(a.address))
      if (bad || addrs.length === 0) throw new BlockedUrl(`${host} resolves to a non-public address${bad ? ` (${bad.address})` : ''}`)
      const viaEgress = async () => {
        const e = await egressGet(egress, u.toString(), { timeoutMs: Math.max(1000, deadline - Date.now()), maxBytes, maxRedirects: maxRedirects - i, fetchImpl: opts.egressFetch, allowHosts })
        hops.push(...e.hops)
        return { url: e.url, status: e.status, headers: e.headers, body: e.body, truncated: e.truncated, hops, ms: Date.now() - started }
      }
      if (chooseRoute({ egress, internal, addresses: addrs }) === 'egress') return viaEgress()
      // Direct over IPv6, keeping time for the Worker if that fails at the network level.
      let r: Awaited<ReturnType<typeof getOnce>>
      try {
        r = await getOnce(u, false, Math.min(deadline, Date.now() + Math.max(3000, (deadline - Date.now()) / 2)), maxBytes)
      } catch (e) {
        if (e instanceof BlockedUrl) throw e
        return viaEgress()
      }
      const location = r.status >= 300 && r.status < 400 ? (r.headers.location ?? null) : null
      hops.push({ url: u.toString(), status: r.status, location })
      if (location) {
        if (i >= maxRedirects) throw new BlockedUrl(`more than ${maxRedirects} redirects`)
        current = new URL(location, u).toString()
        continue
      }
      return { url: u.toString(), status: r.status, headers: r.headers, body: r.body, truncated: r.truncated, hops, ms: Date.now() - started }
    }
    const r = await getOnce(u, allowed, deadline, maxBytes)
    const location = r.status >= 300 && r.status < 400 ? (r.headers.location ?? null) : null
    hops.push({ url: u.toString(), status: r.status, location })
    if (location) {
      if (i >= maxRedirects) throw new BlockedUrl(`more than ${maxRedirects} redirects`)
      current = new URL(location, u).toString()
      continue
    }
    return { url: u.toString(), status: r.status, headers: r.headers, body: r.body, truncated: r.truncated, hops, ms: Date.now() - started }
  }
}
