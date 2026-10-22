// Cloudflare Worker: a locked-down egress proxy to the PayPal REST API.
//
// Why: the free GCE VM has no IPv4, PayPal has no IPv6. The server sends its PayPal calls here
// (PAYPAL_API_BASE) with the shared secret in `x-egress-key` (PAYPAL_EGRESS_SECRET); this Worker forwards
// them to PayPal over IPv4 and streams the answer back. It adds nothing, caches nothing, stores nothing.
//
// Guards: secret header required (constant-time compare), only the configured upstream origin, only
// /v1 /v2 /v3 API paths, only GET and POST, hop-by-hop and Cloudflare headers stripped.
//
// Deploy: see README.md in this folder. Secret: `wrangler secret put EGRESS_SECRET`.

export interface Env {
  /** Shared secret; requests without a matching `x-egress-key` header are rejected. */
  EGRESS_SECRET?: string
  /** Upstream origin, default PayPal sandbox. Set to https://api-m.paypal.com for live. */
  UPSTREAM?: string
}

const DEFAULT_UPSTREAM = 'https://api-m.sandbox.paypal.com'
const ALLOWED_UPSTREAMS = new Set(['https://api-m.sandbox.paypal.com', 'https://api-m.paypal.com'])
const ALLOWED_PATH = /^\/v[123]\//
const DROP_REQUEST_HEADERS = ['host', 'x-egress-key', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-real-ip']
const DROP_RESPONSE_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie']

const text = (status: number, body: string) => new Response(body + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

/** Constant-time string compare (length is not secret here, the content is). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const secret = env.EGRESS_SECRET ?? ''
    if (!secret) return text(503, 'egress secret not configured')
    if (!safeEqual(request.headers.get('x-egress-key') ?? '', secret)) return text(401, 'unauthorized')

    if (request.method !== 'GET' && request.method !== 'POST') return text(405, 'method not allowed')

    const upstream = (env.UPSTREAM ?? DEFAULT_UPSTREAM).replace(/\/+$/, '')
    if (!ALLOWED_UPSTREAMS.has(upstream)) return text(500, 'upstream not allowed')

    const url = new URL(request.url)
    if (!ALLOWED_PATH.test(url.pathname)) return text(404, 'not found')
    // `//evil.com/x` or an absolute-form path would resolve to another host: compare the origin after building.
    const target = new URL(url.pathname + url.search, upstream)
    if (target.origin !== upstream) return text(400, 'bad target')

    const headers = new Headers(request.headers)
    for (const h of DROP_REQUEST_HEADERS) headers.delete(h)
    for (const h of [...headers.keys()]) if (h.startsWith('cf-') || h.startsWith('x-forwarded-') || h === 'forwarded') headers.delete(h)

    let res: Response
    try {
      res = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : request.body,
        redirect: 'manual',
      })
    } catch (err) {
      return text(502, `upstream unreachable: ${err instanceof Error ? err.name : 'error'}`)
    }

    const out = new Headers(res.headers)
    for (const h of DROP_RESPONSE_HEADERS) out.delete(h)
    out.set('cache-control', 'no-store')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  },
}
