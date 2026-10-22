// Polite HTTP for the bots that touch the real web (Lead Verifier, Agent-Readiness Auditor):
//  - browser-like User-Agent, 15 s timeout, a shared limit of 2 requests per second per process
//  - no retries on 4xx (one retry on a network error or 5xx)
//  - SSRF guard: public http(s) addresses only (the server's own allow list for tests and Sandbox Web)
//  - IPv4-only hosts go through the web egress Worker when WEB_EGRESS_URL/WEB_EGRESS_SECRET are set (the
//    production VM has IPv6 only); hosts with AAAA go direct first and fall back to the Worker on failure
//  - a small robots.txt parser for the crawls that go beyond fixed well-known paths
import dns from 'node:dns/promises'
import { assertFetchableUrl, BlockedUrl, chooseRoute, egressGet, isAllowedHost, isBlockedIp, isInternalTarget, webEgressFromEnv, type WebEgress } from './server-shared.ts'

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
/** Name matched against robots.txt groups (in addition to "*"). */
export const ROBOTS_TOKEN = 'RentABotAuditor'

/** Spaces out calls so no more than `perSecond` start in any second. Shared by everything that fetches. */
export class RateLimiter {
  private next = 0
  private perSecond: number
  constructor(perSecond: number) {
    this.perSecond = perSecond
  }
  async wait(): Promise<void> {
    const gap = 1000 / this.perSecond
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + gap
    if (at > now) await new Promise((r) => setTimeout(r, at - now))
  }
}

export interface WebResponse {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

export interface PoliteWebOptions {
  /** "host" or "host:port" entries that skip the public-address check (local fixtures). */
  allowHosts?: string[]
  timeoutMs?: number
  maxBytes?: number
  /** Requests per second across the whole process (default 2). */
  perSecond?: number
  limiter?: RateLimiter
  userAgent?: string
  fetchImpl?: typeof fetch
  maxRedirects?: number
  /** Web egress Worker for IPv4-only hosts. Default: WEB_EGRESS_URL/WEB_EGRESS_SECRET from the env; null = always direct. */
  egress?: WebEgress | null
  /** Resolver for the address check and routing (tests). Default: dns.lookup(all). */
  lookupAll?: (host: string) => Promise<{ address: string; family: number }[]>
}

export interface PoliteWeb {
  /** `method: 'HEAD'` sends a HEAD directly; through the egress Worker (GET only) it becomes a GET whose body is thrown away. `maxBytes` caps the body read for this call. */
  get(url: string, opts?: { accept?: string; method?: 'GET' | 'HEAD'; maxBytes?: number }): Promise<WebResponse>
  readonly limiter: RateLimiter
  /** Count of HTTP requests actually sent (tests assert on politeness). */
  requests: number
}

type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>
const defaultLookup: LookupAll = (host) => dns.lookup(host, { all: true })

/** Every resolved address must be public; one non-public answer refuses the host. Returns the addresses. */
async function assertPublicHost(u: URL, allowHosts: string[], lookupAll: LookupAll): Promise<{ address: string; family: number }[]> {
  if (isAllowedHost(u, allowHosts)) return []
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(host)) return [{ address: host, family: 4 }] // IP literals were checked by assertFetchableUrl
  if (host.includes(':')) return [{ address: host, family: 6 }]
  const addrs = await lookupAll(host)
  const bad = addrs.find((a) => isBlockedIp(a.address))
  if (bad || addrs.length === 0) throw new BlockedUrl(`${host} resolves to a non-public address${bad ? ` (${bad.address})` : ''}`)
  return addrs
}

export function createPoliteWeb(opts: PoliteWebOptions = {}): PoliteWeb {
  const allowHosts = opts.allowHosts ?? []
  const limiter = opts.limiter ?? new RateLimiter(opts.perSecond ?? 2)
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxBytes = opts.maxBytes ?? 1_500_000
  const maxRedirects = opts.maxRedirects ?? 4
  const egress = opts.egress === undefined ? webEgressFromEnv() : opts.egress
  const lookupAll = opts.lookupAll ?? defaultLookup
  const accept = (o: { accept?: string }) => o.accept ?? 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5'
  const viaEgress = async (eg: WebEgress, u: URL, o: { accept?: string; maxBytes?: number }, hopsLeft: number): Promise<WebResponse> => {
    await limiter.wait()
    web.requests++
    const r = await egressGet(eg, u.toString(), { accept: accept(o), timeoutMs: timeoutMs + 2000, maxBytes: o.maxBytes ?? maxBytes, maxRedirects: hopsLeft, fetchImpl: doFetch, allowHosts })
    return { url: r.url, status: r.status, headers: r.headers, body: r.body, truncated: r.truncated }
  }
  const web: PoliteWeb = {
    limiter,
    requests: 0,
    async get(raw, o = {}) {
      let current = raw
      for (let hop = 0; ; hop++) {
        const u = assertFetchableUrl(current, allowHosts)
        const addresses = await assertPublicHost(u, allowHosts, lookupAll)
        const internal = isInternalTarget(u, allowHosts, egress)
        if (egress && chooseRoute({ egress, internal, addresses }) === 'egress') return viaEgress(egress, u, o, maxRedirects - hop)
        let res: Response | null = null
        let lastErr: unknown
        for (let attempt = 0; attempt < 2; attempt++) {
          await limiter.wait()
          web.requests++
          const ctl = new AbortController()
          const timer = setTimeout(() => ctl.abort(), timeoutMs)
          try {
            res = await doFetch(u, {
              method: o.method ?? 'GET',
              redirect: 'manual',
              signal: ctl.signal,
              headers: { 'user-agent': opts.userAgent ?? BROWSER_UA, accept: accept(o), 'accept-language': 'en' },
            })
            if (res.status >= 500 && attempt === 0) {
              await res.body?.cancel().catch(() => {})
              res = null
              lastErr = new Error('HTTP 5xx')
              continue
            }
            break
          } catch (e) {
            lastErr = e
            res = null
          } finally {
            clearTimeout(timer)
          }
        }
        if (!res) {
          // Direct (IPv6) failed at the network level: try once through the Worker before giving up.
          if (egress && !internal && !(lastErr instanceof BlockedUrl)) return viaEgress(egress, u, o, maxRedirects - hop)
          // The network error code (ENOTFOUND, ECONNREFUSED, a TLS error) travels with the error: callers that judge links need it.
          const cause = (lastErr as { cause?: { code?: string } } | undefined)?.cause
          const failure = new Error(`fetch failed: ${cause?.code ? `${cause.code} ` : ''}${(lastErr as Error)?.message ?? 'unknown'}`) as Error & { code?: string }
          failure.code = cause?.code ?? (lastErr as { code?: string } | undefined)?.code
          throw failure
        }
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => (headers[k] = v))
        if (res.status >= 300 && res.status < 400 && headers.location) {
          await res.body?.cancel().catch(() => {})
          if (hop >= maxRedirects) throw new Error(`more than ${maxRedirects} redirects`)
          current = new URL(headers.location, u).toString()
          continue
        }
        const { text, truncated } = o.method === 'HEAD' ? { text: '', truncated: false } : await readCapped(res, o.maxBytes ?? maxBytes)
        if (o.method === 'HEAD') await res.body?.cancel().catch(() => {})
        return { url: u.toString(), status: res.status, headers, body: text, truncated }
      }
    },
  }
  return web
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.length
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

// ---------- robots.txt ----------

interface RobotsGroup {
  agents: string[]
  rules: { allow: boolean; pattern: string }[]
}

export interface Robots {
  /** Is `path` (with query) allowed for the given user-agent token? Longest matching rule wins; allow wins ties. */
  allowed(userAgent: string, path: string): boolean
  /** The group that applies to this agent: its own, else "*", else none. */
  groupFor(userAgent: string): { explicit: boolean; found: boolean; rules: RobotsGroup['rules'] }
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = []
  let cur: RobotsGroup | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const i = line.indexOf(':')
    if (i < 1) continue
    const field = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] }
        groups.push(cur)
      }
      cur.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (field === 'allow' || field === 'disallow') {
      if (value === '' && field === 'disallow') continue // empty Disallow = allow everything
      cur.rules.push({ allow: field === 'allow', pattern: value })
    }
  }
  const toRe = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'))
  const groupFor = (ua: string) => {
    const name = ua.toLowerCase()
    const own = groups.filter((g) => g.agents.some((a) => a !== '*' && name.includes(a)))
    if (own.length) return { explicit: true, found: true, rules: own.flatMap((g) => g.rules) }
    const star = groups.filter((g) => g.agents.includes('*'))
    return { explicit: false, found: star.length > 0, rules: star.flatMap((g) => g.rules) }
  }
  return {
    groupFor,
    allowed(ua, path) {
      const { rules } = groupFor(ua)
      let best: { allow: boolean; len: number } | null = null
      for (const r of rules) {
        if (!toRe(r.pattern).test(path)) continue
        const len = r.pattern.length
        if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len }
      }
      return best ? best.allow : true
    },
  }
}
