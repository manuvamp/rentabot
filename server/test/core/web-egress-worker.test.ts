import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkTarget, isBlockedIpLiteral } from '../../../deploy/cloudflare/web-egress/guard.ts'
import worker, { MAX_BYTES, MAX_REDIRECTS, USER_AGENT } from '../../../deploy/cloudflare/web-egress/worker.ts'

const KEY = 'web-egress-s3cret'
const env = { EGRESS_SECRET: KEY }
const call = (target: string, init: RequestInit = {}, e: { EGRESS_SECRET?: string } = env) =>
  worker.fetch(new Request(`https://egress.example.workers.dev/fetch?url=${encodeURIComponent(target)}`, { ...init, headers: { 'x-egress-key': KEY, ...(init.headers as Record<string, string>) } }), e)

type Seen = { url: string; method: string; headers: Headers }
function upstream(reply: (url: string) => Response = () => new Response('<h1>hi</h1>', { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'sid=1', 'www-authenticate': 'Basic' } })) {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit) => {
    seen.push({ url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers) })
    return reply(String(input))
  })
  return seen
}

afterEach(() => vi.unstubAllGlobals())

describe('web egress guard (pure)', () => {
  it('accepts plain public http(s) URLs on default ports', () => {
    for (const u of ['https://github.com/', 'http://shopify.com/x?y=1', 'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://github.com:443/'])
      expect(checkTarget(u).ok, u).toBe(true)
  })
  it('refuses schemes, ports, credentials, local names and private/metadata IP literals (v4 and v6)', () => {
    const bad = [
      'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url',
      'https://example.com:8443/', 'http://example.com:443/', 'https://user:pw@example.com/',
      'http://localhost/', 'http://foo.localhost/', 'http://metadata.google.internal/', 'http://printer.local/', 'http://intranet/',
      'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://169.254.169.254/',
      'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/',
      'http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[fd00:ec2::254]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[64:ff9b::a00:1]/', 'http://[2002:c0a8:101::1]/',
    ]
    for (const u of bad) expect(checkTarget(u).ok, u).toBe(false)
  })
  it('classifies IP literals', () => {
    expect(isBlockedIpLiteral('100.127.255.255')).toBe(true)
    expect(isBlockedIpLiteral('100.128.0.1')).toBe(false)
    expect(isBlockedIpLiteral('2001:4860:4860::8888')).toBe(false)
    expect(isBlockedIpLiteral('fc00::1')).toBe(true)
  })
})

describe('web egress worker', () => {
  it('refuses a missing or wrong key, and 503s with no secret configured, without fetching', async () => {
    const seen = upstream()
    const noKey = await worker.fetch(new Request('https://egress.example.workers.dev/fetch?url=https%3A%2F%2Fgithub.com'), env)
    expect(noKey.status).toBe(401)
    expect((await call('https://github.com', { headers: { 'x-egress-key': 'nope' } })).status).toBe(401)
    expect((await call('https://github.com', {}, {})).status).toBe(503)
    expect(seen).toHaveLength(0)
  })

  it('allows GET and HEAD only, on /fetch only', async () => {
    const seen = upstream()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await call('https://github.com', { method })).status).toBe(405)
    expect((await worker.fetch(new Request('https://egress.example.workers.dev/other?url=x', { headers: { 'x-egress-key': KEY } }), env)).status).toBe(404)
    expect(seen).toHaveLength(0)
    const head = await call('https://github.com', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(seen[0]!.method).toBe('HEAD')
  })

  it('refuses private targets with 403 and an x-egress-error header', async () => {
    const seen = upstream()
    for (const t of ['http://169.254.169.254/computeMetadata/v1/', 'http://[::1]/', 'http://localhost:8790/', 'https://github.com:8443/']) {
      const r = await call(t)
      expect(r.status, t).toBe(403)
      expect(r.headers.get('x-egress-error')).toMatch(/^blocked/)
    }
    expect(seen).toHaveLength(0)
  })

  it('fetches with its own UA and no caller headers, and strips cookies/auth from the answer', async () => {
    const seen = upstream()
    const r = await call('https://github.com', { headers: { cookie: 'a=b', authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4', accept: 'text/html' } })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('<h1>hi</h1>')
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('www-authenticate')).toBeNull()
    expect(r.headers.get('content-type')).toBe('text/html')
    expect(r.headers.get('x-egress-final-url')).toBe('https://github.com/')
    const h = seen[0]!.headers
    expect(h.get('user-agent')).toBe(USER_AGENT)
    expect(h.get('cookie')).toBeNull()
    expect(h.get('authorization')).toBeNull()
    expect(h.get('x-egress-key')).toBeNull()
    expect(h.get('x-forwarded-for')).toBeNull()
    expect(h.get('accept')).toBe('text/html')
  })

  it('follows redirects itself, re-checking every hop, and reports them', async () => {
    const seen = upstream((u) =>
      u === 'http://shop.example.com/' ? new Response(null, { status: 301, headers: { location: 'https://www.shop.example.com/' } }) : new Response('ok', { status: 200 }),
    )
    const r = await call('http://shop.example.com/')
    expect(r.status).toBe(200)
    expect(r.headers.get('x-egress-final-url')).toBe('https://www.shop.example.com/')
    expect(JSON.parse(r.headers.get('x-egress-hops')!)).toEqual([
      { url: 'http://shop.example.com/', status: 301, location: 'https://www.shop.example.com/' },
      { url: 'https://www.shop.example.com/', status: 200, location: null },
    ])
    expect(seen).toHaveLength(2)
  })

  it('refuses a redirect into a private address', async () => {
    const seen = upstream(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }))
    const r = await call('https://evil.example.com/')
    expect(r.status).toBe(403)
    expect(seen).toHaveLength(1)
  })

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    let n = 0
    const seen = upstream(() => new Response(null, { status: 302, headers: { location: `https://loop.example.com/${++n}` } }))
    const r = await call('https://loop.example.com/')
    expect(r.status).toBe(508)
    expect(seen).toHaveLength(MAX_REDIRECTS + 1)
  })

  it('caps the body size', async () => {
    upstream(() => new Response('x'.repeat(MAX_BYTES + 5000), { status: 200 }))
    const r = await call('https://big.example.com/')
    expect((await r.arrayBuffer()).byteLength).toBe(MAX_BYTES)
  })

  it('reports an unreachable upstream as 502 without leaking details', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('connect failed')
    })
    const r = await call('https://down.example.com/')
    expect(r.status).toBe(502)
    expect(r.headers.get('x-egress-error')).toMatch(/upstream unreachable/)
  })
})
