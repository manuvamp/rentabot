// Cloudflare Worker: a locked-down page-fetch egress for Rent-A-Bot's house bots and acceptance checks.
//
// Why: the free GCE VM has IPv6 only, and many sites (github.com, shopify.com, ~45% of lead domains) have no
// AAAA record. The server fetches IPv6 hosts directly and sends IPv4-only ones here; this Worker fetches them
// from Cloudflare (which has IPv4) and streams the answer back. It caches nothing and stores nothing.
//
//   GET|HEAD https://<worker>/fetch?url=<encoded target>      header  x-egress-key: <shared secret>
//
// Response: the final upstream status and body, plus
//   x-egress-final-url  the URL that answered (after redirects)
//   x-egress-hops       JSON [{url,status,location}] for every hop
//   x-egress-error      set (with a 4xx/5xx status) only when the Worker itself refused or failed
//
// Not an open proxy: secret required (constant-time compare); GET/HEAD only; http(s) on default ports only;
// IP literals in private/loopback/link-local/CGNAT/metadata ranges and local names refused; redirects
// followed here (max MAX_REDIRECTS) with every hop re-checked; 10 s and 2 MiB caps; no cookies or auth
// headers in either direction; a fixed User-Agent that names the checker.
import { checkTarget, safeEqual } from './guard.ts'

export interface Env {
  /** Shared secret; requests without a matching `x-egress-key` header are rejected. */
  EGRESS_SECRET?: string
}

export const MAX_REDIRECTS = 5
export const MAX_BYTES = 2 * 1024 * 1024
export const TIMEOUT_MS = 10_000
export const USER_AGENT = 'RentABot-Checker/1.0 (+https://rentabot.tech/docs/bots; page checks for an agent marketplace)'
/** Upstream response headers passed back; everything else (set-cookie, www-authenticate, ...) is dropped. */
const PASS_HEADERS = ['content-type', 'content-language', 'last-modified', 'etag', 'x-robots-tag', 'link', 'retry-after']

const fail = (status: number, reason: string) =>
  new Response(reason + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-egress-error': reason } })

/** Cuts a body stream off after `max` bytes. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const { done, value } = await reader.read()
      if (done) return ctl.close()
      const room = max - seen
      if (value.length >= room) {
        if (room > 0) ctl.enqueue(value.subarray(0, room))
        seen = max
        ctl.close()
        await reader.cancel().catch(() => {})
        return
      }
      seen += value.length
      ctl.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const secret = env.EGRESS_SECRET ?? ''
    if (!secret) return fail(503, 'egress secret not configured')
    if (!safeEqual(request.headers.get('x-egress-key') ?? '', secret)) return fail(401, 'unauthorized')
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method not allowed')

    const self = new URL(request.url)
    if (self.pathname !== '/fetch') return fail(404, 'not found')
    const raw = self.searchParams.get('url') ?? ''
    const accept = (request.headers.get('accept') ?? 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5').slice(0, 300)

    const ctl = new AbortController()
    // Not cleared: the body keeps streaming after we return, so a slow body still stops at TIMEOUT_MS.
    setTimeout(() => ctl.abort(), TIMEOUT_MS)
    const hops: { url: string; status: number; location: string | null }[] = []
    let current = raw
    for (let hop = 0; ; hop++) {
      const g = checkTarget(current)
      if (!g.ok) return fail(403, `blocked: ${g.reason}`)
      let res: Response
      try {
        res = await fetch(g.url.toString(), {
          method: request.method,
          redirect: 'manual',
          signal: ctl.signal,
          // Built from scratch: nothing from the caller (cookies, authorization, the key) reaches the target.
          headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en' },
        })
      } catch (err) {
        return fail(ctl.signal.aborted ? 504 : 502, ctl.signal.aborted ? 'upstream timed out' : `upstream unreachable: ${err instanceof Error ? err.name : 'error'}`)
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      hops.push({ url: g.url.toString(), status: res.status, location })
      if (location) {
        await res.body?.cancel().catch(() => {})
        if (hop >= MAX_REDIRECTS) return fail(508, `more than ${MAX_REDIRECTS} redirects`)
        try {
          current = new URL(location, g.url).toString()
        } catch {
          return fail(502, 'bad redirect location')
        }
        continue
      }
      const out = new Headers({ 'cache-control': 'no-store', 'x-egress-final-url': g.url.toString(), 'x-egress-hops': JSON.stringify(hops) })
      for (const h of PASS_HEADERS) {
        const v = res.headers.get(h)
        if (v !== null) out.set(h, v)
      }
      const body = request.method === 'HEAD' || !res.body ? null : capped(res.body, MAX_BYTES)
      return new Response(body, { status: res.status, headers: out })
    }
  },
}
