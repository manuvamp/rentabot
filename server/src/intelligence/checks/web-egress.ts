// Client side of the web egress Worker (deploy/cloudflare/web-egress). The production VM has IPv6 only, so
// page fetches to hosts without a public AAAA record go through the Worker (Cloudflare has IPv4). Shared by the
// acceptance checks (safe-fetch.ts) and the house bots' fetcher (bots/src/web.ts).
//
// Routing (chooseRoute): platform-internal hosts (allow list, own PUBLIC_URL host, the Worker itself) always
// go direct and never through the Worker; with no egress configured everything goes direct; a host with a
// public IPv6 address goes direct first (callers fall back to the Worker when that fails); an IPv4-only host
// goes through the Worker. The server-side SSRF guard still runs before any of this, and every hop the Worker
// reports is re-checked. The secret only ever travels in the `x-egress-key` header: never in a URL, a log
// line or an error message.
import net from 'node:net'
import { assertFetchableUrl, BlockedUrl, isAllowedHost, isBlockedIp, type FetchHop } from './safe-fetch.ts'

export interface WebEgress {
  /** Worker origin, e.g. https://rentabot-web-egress.rentabot.workers.dev */
  url: string
  secret: string
  /** Hostnames that must never be sent through the Worker (own site, Sandbox Web). */
  internalHosts: string[]
}

/** WEB_EGRESS_URL + WEB_EGRESS_SECRET, or null when either is missing (then everything goes direct). */
export function webEgressFromEnv(env: Record<string, string | undefined> = process.env): WebEgress | null {
  const url = (env.WEB_EGRESS_URL ?? '').trim().replace(/\/+$/, '')
  const secret = (env.WEB_EGRESS_SECRET ?? '').trim()
  if (!url || !secret) return null
  try {
    if (new URL(url).protocol !== 'https:') return null
  } catch {
    return null
  }
  const internalHosts: string[] = []
  for (const k of ['PUBLIC_URL']) {
    try {
      if (env[k]) internalHosts.push(new URL(env[k]!).hostname.toLowerCase())
    } catch {
      /* ignore */
    }
  }
  return { url, secret, internalHosts }
}

/** True when a URL is the platform's own (allow list, PUBLIC_URL host, loopback names, the Worker): never egress. */
export function isInternalTarget(u: URL, allowHosts: string[], egress: WebEgress | null): boolean {
  if (isAllowedHost(u, allowHosts)) return true
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true
  if (!egress) return false
  const own = new URL(egress.url).hostname.toLowerCase()
  return host === own || egress.internalHosts.some((h) => host === h || host.endsWith(`.${h}`))
}

export type Route = 'direct' | 'egress'

/** Which way to fetch a (public, already-guarded) URL, given the addresses its host resolves to. */
export function chooseRoute(o: { egress: WebEgress | null; internal: boolean; addresses: { address: string; family?: number }[] }): Route {
  if (!o.egress || o.internal) return 'direct'
  const hasV6 = o.addresses.some((a) => net.isIPv6(a.address) && !isBlockedIp(a.address))
  return hasV6 ? 'direct' : 'egress'
}

export interface EgressResult {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  hops: FetchHop[]
}

export class EgressError extends Error {}

/** GET a page through the Worker. Throws BlockedUrl when the Worker (or our re-check) refuses a hop. */
export async function egressGet(
  egress: WebEgress,
  target: string,
  o: { accept?: string; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; fetchImpl?: typeof fetch; allowHosts?: string[] } = {},
): Promise<EgressResult> {
  const doFetch = o.fetchImpl ?? fetch
  const maxBytes = o.maxBytes ?? 1_000_000
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 12_000)
  try {
    let res: Response
    try {
      res = await doFetch(`${egress.url}/fetch?url=${encodeURIComponent(target)}`, {
        signal: ctl.signal,
        redirect: 'manual',
        headers: { 'x-egress-key': egress.secret, accept: o.accept ?? 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' },
      })
    } catch (e) {
      throw new EgressError(`egress unreachable: ${ctl.signal.aborted ? 'timed out' : ((e as Error)?.name ?? 'error')}`)
    }
    const err = res.headers.get('x-egress-error')
    if (err) {
      await res.body?.cancel().catch(() => {})
      if (res.status === 403 && err.startsWith('blocked')) throw new BlockedUrl(`egress refused: ${err}`)
      throw new EgressError(`egress: ${err.slice(0, 120)} (HTTP ${res.status})`)
    }
    let hops: FetchHop[] = []
    try {
      hops = JSON.parse(res.headers.get('x-egress-hops') ?? '[]') as FetchHop[]
    } catch {
      hops = []
    }
    const finalUrl = res.headers.get('x-egress-final-url') ?? target
    // Our own guard on everything the Worker visited (it already refused these; this is belt and braces).
    for (const h of [...hops.map((x) => x.url), finalUrl]) assertFetchableUrl(h, o.allowHosts ?? [])
    if (o.maxRedirects !== undefined && hops.length - 1 > o.maxRedirects) {
      await res.body?.cancel().catch(() => {})
      throw new BlockedUrl(`more than ${o.maxRedirects} redirects`)
    }
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (!k.startsWith('x-egress-')) headers[k] = v
    })
    const { text, truncated } = await readCapped(res, maxBytes)
    return { url: finalUrl, status: res.status, headers, body: text, truncated, hops }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size))
      await reader.cancel().catch(() => {})
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true }
    }
    chunks.push(value)
    size += value.length
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false }
}
