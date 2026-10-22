import { describe, expect, it } from 'vitest'
import { createPoliteWeb, RateLimiter } from '../src/web.ts'

const SECRET = 'bots-egress-s3cret'
const egress = { url: 'https://egress.example.workers.dev', secret: SECRET, internalHosts: ['rentabot.tech'] }
const limiter = new RateLimiter(1000)

/** One fetch stub playing both the Worker and the direct targets. */
function net(direct: (url: string) => Response | Promise<Response> = () => new Response('direct page', { status: 200 })) {
  const calls: { url: string; key: string | null }[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, key: new Headers(init?.headers).get('x-egress-key') })
    if (url.startsWith(egress.url)) {
      const target = new URL(url).searchParams.get('url')!
      return new Response(`via worker: ${target}`, { status: 200, headers: { 'x-egress-final-url': target, 'x-egress-hops': JSON.stringify([{ url: target, status: 200, location: null }]) } })
    }
    return direct(url)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const v4only = async () => [{ address: '140.82.112.3', family: 4 }]
const dual = async () => [{ address: '140.82.112.3', family: 4 }, { address: '2606:4700::6810:84e5', family: 6 }]

describe('bots web fetcher routing', () => {
  it('sends IPv4-only hosts through the Worker with the key, IPv6 hosts direct', async () => {
    const n = net()
    const web = createPoliteWeb({ egress, lookupAll: v4only, fetchImpl: n.fetchImpl, limiter })
    const r = await web.get('https://github.com/')
    expect(r.body).toBe('via worker: https://github.com/')
    expect(r.url).toBe('https://github.com/')
    expect(n.calls).toEqual([{ url: `${egress.url}/fetch?url=${encodeURIComponent('https://github.com/')}`, key: SECRET }])

    const m = net()
    const web2 = createPoliteWeb({ egress, lookupAll: dual, fetchImpl: m.fetchImpl, limiter })
    expect((await web2.get('https://example.com/')).body).toBe('direct page')
    expect(m.calls.map((c) => c.url)).toEqual(['https://example.com/'])
    expect(m.calls[0]!.key).toBeNull()
  })

  it('falls back to the Worker when a direct fetch fails at the network level', async () => {
    const n = net(() => {
      throw new TypeError('fetch failed')
    })
    const web = createPoliteWeb({ egress, lookupAll: dual, fetchImpl: n.fetchImpl, limiter })
    expect((await web.get('https://example.com/')).body).toBe('via worker: https://example.com/')
    expect(n.calls.at(-1)!.url.startsWith(egress.url)).toBe(true)
  })

  it('never routes allowed (platform) hosts or the own site through the Worker', async () => {
    const n = net()
    const web = createPoliteWeb({ egress, lookupAll: v4only, fetchImpl: n.fetchImpl, limiter, allowHosts: ['127.0.0.1:8790'] })
    await web.get('http://127.0.0.1:8790/sandbox/page')
    await web.get('https://rentabot.tech/sandbox/x')
    expect(n.calls.every((c) => !c.url.startsWith(egress.url))).toBe(true)
  })

  it('goes direct with no egress configured, and still refuses private resolutions', async () => {
    const n = net()
    const web = createPoliteWeb({ egress: null, lookupAll: v4only, fetchImpl: n.fetchImpl, limiter })
    expect((await web.get('https://github.com/')).body).toBe('direct page')
    const bad = createPoliteWeb({ egress, lookupAll: async () => [{ address: '192.168.0.10', family: 4 }], fetchImpl: n.fetchImpl, limiter })
    await expect(bad.get('https://sneaky.example.com/')).rejects.toThrow(/non-public/)
  })
})
