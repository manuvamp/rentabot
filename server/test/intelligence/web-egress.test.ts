import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BlockedUrl, safeFetch } from '../../src/intelligence/checks/safe-fetch.ts'
import { chooseRoute, isInternalTarget, webEgressFromEnv, type WebEgress } from '../../src/intelligence/checks/web-egress.ts'

const SECRET = 'route-test-s3cret'
const egress: WebEgress = { url: 'https://egress.example.workers.dev', secret: SECRET, internalHosts: ['rentabot.tech'] }

/** A fake Worker: records calls and answers like the real one. */
function fakeWorker(answer: (target: string) => Response = (t) => new Response(`page for ${t}`, { status: 200, headers: { 'content-type': 'text/html', 'x-egress-final-url': t, 'x-egress-hops': JSON.stringify([{ url: t, status: 200, location: null }]) } })) {
  const calls: { target: string; key: string | null }[] = []
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input))
    const target = u.searchParams.get('url')!
    calls.push({ target, key: new Headers(init?.headers).get('x-egress-key') })
    return answer(target)
  }) as typeof fetch
  return { calls, f }
}

describe('web egress routing decision', () => {
  it('reads WEB_EGRESS_URL/WEB_EGRESS_SECRET, null when either is missing or not https', () => {
    expect(webEgressFromEnv({})).toBeNull()
    expect(webEgressFromEnv({ WEB_EGRESS_URL: 'https://x.workers.dev' })).toBeNull()
    expect(webEgressFromEnv({ WEB_EGRESS_URL: 'http://x.workers.dev', WEB_EGRESS_SECRET: 's' })).toBeNull()
    expect(webEgressFromEnv({ WEB_EGRESS_URL: 'https://x.workers.dev/', WEB_EGRESS_SECRET: 's', PUBLIC_URL: 'https://rentabot.tech' })).toEqual({ url: 'https://x.workers.dev', secret: 's', internalHosts: ['rentabot.tech'] })
  })

  it('direct with no egress or for internal hosts; direct for IPv6 hosts; Worker for IPv4-only hosts', () => {
    const v4 = [{ address: '140.82.112.3', family: 4 }]
    const both = [...v4, { address: '2606:4700::6810:84e5', family: 6 }]
    expect(chooseRoute({ egress: null, internal: false, addresses: v4 })).toBe('direct')
    expect(chooseRoute({ egress, internal: true, addresses: v4 })).toBe('direct')
    expect(chooseRoute({ egress, internal: false, addresses: both })).toBe('direct')
    expect(chooseRoute({ egress, internal: false, addresses: v4 })).toBe('egress')
    expect(chooseRoute({ egress, internal: false, addresses: [{ address: 'fd00::1', family: 6 }, ...v4] })).toBe('egress') // a private v6 is not a route
  })

  it('treats the allow list, the own site, Sandbox Web, loopback names and the Worker itself as internal', () => {
    const allow = ['127.0.0.1:8790']
    for (const u of ['http://127.0.0.1:8790/sandbox/x', 'https://rentabot.tech/sandbox/pages/1', 'https://www.rentabot.tech/', 'http://localhost/', 'https://egress.example.workers.dev/fetch'])
      expect(isInternalTarget(new URL(u), allow, egress), u).toBe(true)
    expect(isInternalTarget(new URL('https://github.com/'), allow, egress)).toBe(false)
  })
})

describe('safeFetch through the web egress Worker', () => {
  let server: http.Server
  let base = ''
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('local page'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('sends an IPv4-only host through the Worker with the key header', async () => {
    const w = fakeWorker()
    const r = await safeFetch('https://github.com/', { egress, egressFetch: w.f, lookupAll: async () => [{ address: '140.82.112.3', family: 4 }] })
    expect(r.status).toBe(200)
    expect(r.body).toBe('page for https://github.com/')
    expect(r.url).toBe('https://github.com/')
    expect(w.calls).toEqual([{ target: 'https://github.com/', key: SECRET }])
  })

  it('never sends platform-internal URLs through the Worker', async () => {
    const w = fakeWorker()
    const host = new URL(base).host
    const r = await safeFetch(`${base}/x`, { egress, egressFetch: w.f, allowHosts: [host] })
    expect(r.body).toBe('local page')
    expect(w.calls).toHaveLength(0)
  })

  it('keeps the server-side guard: a host resolving to a private address is refused before the Worker', async () => {
    const w = fakeWorker()
    await expect(safeFetch('https://sneaky.example.com/', { egress, egressFetch: w.f, lookupAll: async () => [{ address: '10.0.0.5', family: 4 }] })).rejects.toBeInstanceOf(BlockedUrl)
    await expect(safeFetch('http://169.254.169.254/', { egress, egressFetch: w.f })).rejects.toBeInstanceOf(BlockedUrl)
    expect(w.calls).toHaveLength(0)
  })

  it('falls back to the Worker when the direct IPv6 fetch fails', async () => {
    const w = fakeWorker()
    // Public AAAA from our resolver, but the real connection fails (.invalid never resolves).
    const r = await safeFetch('https://v6-broken.invalid/', { egress, egressFetch: w.f, lookupAll: async () => [{ address: '2606:4700::1', family: 6 }], timeoutMs: 4000 })
    expect(r.status).toBe(200)
    expect(w.calls.map((c) => c.target)).toEqual(['https://v6-broken.invalid/'])
  })

  it('re-checks the hops the Worker reports, and never puts the secret in an error', async () => {
    const bad = fakeWorker(() => new Response('x', { status: 200, headers: { 'x-egress-final-url': 'http://10.0.0.1/', 'x-egress-hops': '[]' } }))
    await expect(safeFetch('https://github.com/', { egress, egressFetch: bad.f, lookupAll: async () => [{ address: '140.82.112.3', family: 4 }] })).rejects.toBeInstanceOf(BlockedUrl)
    const down = fakeWorker(() => new Response('upstream unreachable', { status: 502, headers: { 'x-egress-error': 'upstream unreachable: Error' } }))
    const err = await safeFetch('https://github.com/', { egress, egressFetch: down.f, lookupAll: async () => [{ address: '140.82.112.3', family: 4 }] }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toMatch(/upstream unreachable/)
    expect(String((err as Error).message)).not.toContain(SECRET)
  })

  it('goes direct when no egress is configured', async () => {
    const r = await safeFetch(`${base}/y`, { egress: null, allowHosts: [new URL(base).host] })
    expect(r.body).toBe('local page')
  })
})
