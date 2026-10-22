// url_live / page_mentions: transient fetch outcomes (429, 5xx gateway errors, timeouts) are retried inside the check's
// timeout, and a still-transient outcome is 'pending' (re-run later), never a final 'fail'. Found on production 2026-10-20:
// github.com answered 429 to the shared egress Worker and 200 a second later.
import { describe, expect, it } from 'vitest'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { BlockedUrl, type FetchResult, type SafeFetch } from '../../src/intelligence/checks/safe-fetch.ts'
import { fetchRetrying, retryAfterMs } from '../../src/intelligence/checks/transient.ts'
import type { CheckContext } from '../../src/intelligence/types.ts'
import { demoContract } from './fixture.ts'

const page = (status: number, body = '<html><body>ORANO turns saves into next steps</body></html>', headers: Record<string, string> = {}): FetchResult => ({
  url: 'https://example.org/p',
  status,
  headers: { 'content-type': 'text/html', ...headers },
  body,
  truncated: false,
  hops: [{ url: 'https://example.org/p', status, location: null }],
  ms: 5,
})

/** A fake fetch answering from a script; anything past its end repeats the last step. */
function scripted(steps: (FetchResult | Error)[]) {
  const calls: { timeoutMs?: number }[] = []
  const f: SafeFetch = async (_url, opts) => {
    calls.push({ timeoutMs: opts?.timeoutMs })
    const s = steps[Math.min(calls.length - 1, steps.length - 1)]!
    if (s instanceof Error) throw s
    return s
  }
  return { f, calls }
}

const ctx = (check: string, params: Record<string, unknown>): CheckContext => ({
  job_id: 'job_demo0001',
  contract: demoContract(),
  deliverable_id: 'D1',
  unit: { ref: 'u1', url: 'https://example.org/p', artifact_ids: [], meta: {} },
  test: { check, params },
  attempt: 1,
  artifact: async () => null,
  saveEvidence: async () => 'ev_test0001',
})

const run = (f: SafeFetch, check: string, params: Record<string, unknown> = {}) => createCheckLibrary({ fetch: f }).get(check)!.run(ctx(check, params))

describe('web checks and transient fetch outcomes', () => {
  it('url_live: a 429 followed by a 200 passes (one retry, Retry-After honoured)', async () => {
    const { f, calls } = scripted([page(429, '', { 'retry-after': '0' }), page(200)])
    const r = await run(f, 'url_live')
    expect(r.status).toBe('pass')
    expect(calls).toHaveLength(2)
  })

  it('page_mentions: a timeout followed by the page passes', async () => {
    const { f, calls } = scripted([new Error('timed out after 8000 ms'), page(200)])
    const r = await run(f, 'page_mentions', { must_include: ['ORANO'] })
    expect(r.status).toBe('pass')
    expect(calls).toHaveLength(2)
  })

  it('still rate limited after the retries: pending with a "transient" detail, not fail', async () => {
    const { f, calls } = scripted([page(503, 'busy', { 'retry-after': '0' })])
    const a = await run(f, 'url_live')
    expect(a.status).toBe('pending')
    expect(a.detail).toMatch(/^transient: HTTP 503 after 3 attempt\(s\)/)
    expect(calls).toHaveLength(3) // 1 try + 2 retries
    const b = await run(scripted([new Error('egress unreachable: timed out')]).f, 'page_mentions', { must_include: ['ORANO'] })
    expect(b).toMatchObject({ status: 'pending' })
  })

  it('real failures stay final and are not retried: 404, wrong text, SSRF refusal, unknown host', async () => {
    const nf = scripted([page(404)])
    expect((await run(nf.f, 'url_live')).status).toBe('fail')
    expect(nf.calls).toHaveLength(1)
    const missing = scripted([page(200, '<p>something else</p>')])
    expect((await run(missing.f, 'page_mentions', { must_include: ['ORANO'] })).status).toBe('fail')
    expect(missing.calls).toHaveLength(1)
    const ssrf = scripted([new BlockedUrl('host 10.0.0.1 is not public')])
    expect((await run(ssrf.f, 'url_live')).status).toBe('fail')
    expect(ssrf.calls).toHaveLength(1)
    const dns = scripted([new Error('getaddrinfo ENOTFOUND no-such-host.example')])
    expect((await run(dns.f, 'url_live')).status).toBe('fail')
    expect(dns.calls).toHaveLength(1)
  })

  it('retries stay inside the check timeout: a long Retry-After is capped and the last attempt gets only the time left', async () => {
    let t = 0
    const slept: number[] = []
    const { f, calls } = scripted([page(429, '', { 'retry-after': '120' }), page(429, '', { 'retry-after': '120' }), page(200)])
    const r = await fetchRetrying(f, 'https://example.org/p', { timeoutMs: 8000 }, { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms } })
    expect(slept).toEqual([3000, 3000]) // capped from 120 s
    expect(r).toMatchObject({ transient: null, attempts: 3 })
    expect(calls.map((c) => c.timeoutMs)).toEqual([8000, 5000, 2000])
    // no time left for another real attempt: give up as transient instead of overrunning
    t = 0
    const tight = await fetchRetrying(scripted([page(429, '', { 'retry-after': '3' })]).f, 'https://example.org/p', { timeoutMs: 3500 }, { now: () => t, sleep: async (ms) => void (t += ms) })
    expect(tight).toMatchObject({ transient: 'HTTP 429', attempts: 1 })
  })

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000)
    expect(retryAfterMs(undefined)).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
  })
})
