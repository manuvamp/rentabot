import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../../deploy/cloudflare/paypal-egress/worker.ts'

const env = { EGRESS_SECRET: 'egress-s3cret' }
const call = (path: string, init: RequestInit = {}, e = env) => worker.fetch(new Request(`https://egress.example.workers.dev${path}`, init), e)

function upstream(reply: () => Response = () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } })) {
  const seen: { url: string; method: string; headers: Headers; body: string | null }[] = []
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit) => {
    seen.push({ url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body ? await new Response(init.body as BodyInit).text() : null })
    return reply()
  })
  return seen
}

afterEach(() => vi.unstubAllGlobals())

describe('paypal egress worker', () => {
  it('rejects a missing or wrong key without calling upstream, and 503s when no secret is configured', async () => {
    const seen = upstream()
    expect((await call('/v1/oauth2/token', { method: 'POST' })).status).toBe(401)
    expect((await call('/v1/oauth2/token', { method: 'POST', headers: { 'x-egress-key': 'nope' } })).status).toBe(401)
    expect((await call('/v1/oauth2/token', { method: 'POST', headers: { 'x-egress-key': '' } }, {} as typeof env)).status).toBe(503)
    expect(seen).toHaveLength(0)
  })

  it('forwards method, path, query, body and headers to PayPal, minus the key and Cloudflare headers', async () => {
    const seen = upstream()
    const res = await call('/v2/checkout/orders?x=1', {
      method: 'POST',
      headers: { 'x-egress-key': 'egress-s3cret', authorization: 'Bearer T', 'paypal-request-id': 'r1', 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' },
      body: '{"a":1}',
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(seen).toHaveLength(1)
    const s = seen[0]!
    expect(s.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders?x=1')
    expect(s.method).toBe('POST')
    expect(s.body).toBe('{"a":1}')
    expect(s.headers.get('authorization')).toBe('Bearer T')
    expect(s.headers.get('paypal-request-id')).toBe('r1')
    expect(s.headers.get('x-egress-key')).toBeNull()
    expect(s.headers.get('cf-connecting-ip')).toBeNull()
    expect(s.headers.get('x-forwarded-for')).toBeNull()
  })

  it('passes PayPal error statuses and bodies through unchanged', async () => {
    upstream(() => new Response('{"name":"UNPROCESSABLE_ENTITY"}', { status: 422 }))
    const res = await call('/v2/payments/authorizations/A1/capture', { method: 'POST', headers: { 'x-egress-key': 'egress-s3cret' }, body: '{}' })
    expect(res.status).toBe(422)
    expect(await res.text()).toBe('{"name":"UNPROCESSABLE_ENTITY"}')
  })

  it('only talks to the configured PayPal upstream, never another host', async () => {
    const seen = upstream()
    const h = { 'x-egress-key': 'egress-s3cret' }
    expect((await call('//evil.example.com/v1/x', { headers: h })).status).toBeGreaterThanOrEqual(400)
    expect((await call('/admin', { headers: h })).status).toBe(404)
    expect((await call('/v1/x', { method: 'DELETE', headers: h })).status).toBe(405)
    expect((await call('/v1/x', { headers: h }, { ...env, UPSTREAM: 'https://evil.example.com' } as typeof env)).status).toBe(500)
    expect(seen).toHaveLength(0)
    await call('/v1/notifications/webhooks', { headers: h }, { ...env, UPSTREAM: 'https://api-m.paypal.com/' } as typeof env)
    expect(seen[0]!.url).toBe('https://api-m.paypal.com/v1/notifications/webhooks')
  })

  it('answers 502 when PayPal is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('boom')
    })
    expect((await call('/v1/oauth2/token', { method: 'POST', headers: { 'x-egress-key': 'egress-s3cret' } })).status).toBe(502)
  })
})
