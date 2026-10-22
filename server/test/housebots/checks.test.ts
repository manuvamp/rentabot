import { describe, expect, it } from 'vitest'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { BlockedUrl, type FetchResult, type SafeFetch } from '../../src/intelligence/checks/safe-fetch.ts'
import type { CheckContext, CheckLibrary } from '../../src/intelligence/types.ts'
import { cfDecode, pageHasEmail, registerHouseBotChecks } from '../../src/housebots/checks.ts'
import { lintEmail } from '../../src/housebots/email-lint.ts'

const page = (body: string, status = 200, ct = 'text/html'): FetchResult => ({ url: 'https://x.test/', status, headers: { 'content-type': ct }, body, truncated: false, hops: [{ url: 'https://x.test/', status, location: null }], ms: 3 })

function setup(pages: Record<string, FetchResult | Error>, mx: Record<string, string[] | 'ENODATA' | 'ERR'> = {}, doh?: (domain: string) => unknown) {
  const calls: string[] = []
  const fetch: SafeFetch = async (url) => {
    calls.push(url)
    const p = pages[url]
    if (!p) throw new Error(`ECONNREFUSED ${url}`)
    if (p instanceof Error) throw p
    return p
  }
  const lib: CheckLibrary = createCheckLibrary()
  registerHouseBotChecks(lib, {
    safeFetch: fetch,
    resolveMx: async (d) => {
      const v = mx[d]
      if (v === undefined || v === 'ERR') throw Object.assign(new Error('resolver down'), { code: 'ECONNREFUSED' })
      if (v === 'ENODATA') throw Object.assign(new Error('no data'), { code: 'ENODATA' })
      return v.map((exchange, i) => ({ exchange, priority: i * 10 }))
    },
    doh: async (url) => {
      const domain = new URL(url).searchParams.get('name')!
      const r = doh?.(domain)
      if (r instanceof Error) throw r
      return { ok: true, json: async () => r ?? { Status: 2 } }
    },
  })
  return { lib, calls }
}

const ctx = (check: string, unit: { url?: string; meta: Record<string, unknown> } | null, params: Record<string, unknown> = {}): CheckContext => ({
  job_id: 'job_test',
  contract: {} as never,
  deliverable_id: 'D1',
  unit: unit ? { ref: 'u1', artifact_ids: [], ...unit } : null,
  test: { check, params },
  attempt: 1,
  artifact: async () => null,
  saveEvidence: async () => 'ev_test',
})
const run = (lib: CheckLibrary, check: string, unit: Parameters<typeof ctx>[1], params: Record<string, unknown> = {}) => lib.get(check)!.run(ctx(check, unit, params))

// Cloudflare "email-protection" encoding of "hello@acme.test" with key 0x4a
const cfEncode = (s: string, key = 0x4a) => key.toString(16).padStart(2, '0') + [...s].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('')

describe('registration', () => {
  it('adds the three checks with precise definitions', () => {
    const { lib } = setup({})
    const defs = Object.fromEntries(lib.list().map((d) => [d.id, d]))
    expect(defs.lead_verified).toMatchObject({ per_unit: true, delayed: false })
    expect(defs.http_claim_holds).toMatchObject({ per_unit: true })
    expect(defs.email_lint).toMatchObject({ per_unit: true })
    expect(defs.lead_verified!.description).toContain('honest rejection')
    expect(defs.lead_verified!.description).toContain('data-cfemail')
    expect(lib.list().some((d) => d.id === 'url_live')).toBe(true) // library built-ins untouched
  })
})

describe('pageHasEmail', () => {
  it('finds plain, mailto, entity, %40, written-out and Cloudflare forms, and rejects near misses', () => {
    const a = 'hello@acme.test'
    expect(pageHasEmail(`<p>Mail ${a}</p>`, a)).toMatchObject({ found: true, how: 'plain text' })
    expect(pageHasEmail(`<a href="mailto:${a}">us</a>`, a).found).toBe(true)
    expect(pageHasEmail('<p>hello&#64;acme.test</p>', a).found).toBe(true)
    expect(pageHasEmail('<a href="mailto:hello%40acme.test">x</a>', a).found).toBe(true)
    expect(pageHasEmail('<p>hello [at] acme.test</p>', a).found).toBe(true)
    expect(pageHasEmail('<p>hello (at) acme [dot] test</p>', a).found).toBe(true)
    expect(pageHasEmail(`<a class="__cf_email__" data-cfemail="${cfEncode(a)}">[email&#160;protected]</a>`, a)).toMatchObject({ found: true, how: 'cloudflare-protected' })
    expect(pageHasEmail(`<a href="/cdn-cgi/l/email-protection#${cfEncode(a)}">x</a>`, a).found).toBe(true)
    expect(pageHasEmail('<p>info@acme.test and hello@acme.org</p>', a).found).toBe(false)
    expect(pageHasEmail('<p>shello@acme.test</p>', 'hello@acme.test').found).toBe(true) // substring: known limit of plain-text matching, same as leads.py
    expect(cfDecode(cfEncode('x@y.zz'))).toBe('x@y.zz')
    expect(cfDecode('zz')).toBe('')
  })
})

describe('lead_verified', () => {
  const src = 'https://acme.test/contact'
  const unit = (over: Record<string, unknown> = {}) => ({ meta: { to: 'hello@acme.test', verified: true, email_source_url: src, ...over } })

  it('passes a lead whose address is on the page and whose domain has MX', async () => {
    const { lib, calls } = setup({ [src]: page('<a href="mailto:hello@acme.test">Contact</a>') }, { 'acme.test': ['mx1.acme.test'] })
    const r = await run(lib, 'lead_verified', unit())
    expect(r.status).toBe('pass')
    expect(r.detail).toContain('mailto')
    expect(r.evidence_id).toBe('ev_test')
    expect(calls).toEqual([src]) // the platform fetched the cited page itself
  })

  it('passes a Cloudflare-protected address', async () => {
    const { lib } = setup({ [src]: page(`<a data-cfemail="${cfEncode('hello@acme.test')}">[email protected]</a>`) }, { 'acme.test': ['mx.acme.test'] })
    expect((await run(lib, 'lead_verified', unit())).status).toBe('pass')
  })

  it('fails a claimed-verified lead when the address is not on the page (guessed address)', async () => {
    const { lib } = setup({ [src]: page('<p>Contact: info@acme.test</p>') }, { 'acme.test': ['mx.acme.test'] })
    const r = await run(lib, 'lead_verified', unit())
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('not on the source page')
  })

  it('fails a claimed-verified lead whose domain has no MX, and a dead source page', async () => {
    const a = setup({ [src]: page('hello@acme.test') }, { 'acme.test': 'ENODATA' })
    expect((await run(a.lib, 'lead_verified', unit())).detail).toContain('no MX')
    expect((await run(a.lib, 'lead_verified', unit())).status).toBe('fail')
    const b = setup({ [src]: page('Not found', 404) }, { 'acme.test': ['mx'] })
    const r = await run(b.lib, 'lead_verified', unit())
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('HTTP 404')
  })

  it('treats a null MX (".") as no mail', async () => {
    const { lib } = setup({ [src]: page('hello@acme.test') }, { 'acme.test': ['.'] })
    expect((await run(lib, 'lead_verified', unit())).status).toBe('fail')
  })

  it('honest rejections pass only when the platform cannot verify either', async () => {
    const missing = setup({ [src]: page('<p>no address here</p>') }, { 'acme.test': ['mx'] })
    expect((await run(missing.lib, 'lead_verified', unit({ verified: false }))).status).toBe('pass')
    const nomx = setup({ [src]: page('hello@acme.test') }, { 'acme.test': 'ENODATA' })
    expect((await run(nomx.lib, 'lead_verified', unit({ verified: false }))).status).toBe('pass')
    // the seller rejected a lead that is actually fine: not an honest rejection
    const fine = setup({ [src]: page('hello@acme.test') }, { 'acme.test': ['mx'] })
    const r = await run(fine.lib, 'lead_verified', unit({ verified: false }))
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('platform verified it')
  })

  it('is inconclusive (error) when the page or DNS cannot be reached, for either claim', async () => {
    const down = setup({ [src]: new Error('timed out') }, { 'acme.test': ['mx'] })
    expect((await run(down.lib, 'lead_verified', unit())).status).toBe('error')
    expect((await run(down.lib, 'lead_verified', unit({ verified: false }))).status).toBe('error')
    const server500 = setup({ [src]: page('oops', 503) }, { 'acme.test': ['mx'] })
    expect((await run(server500.lib, 'lead_verified', unit({ verified: false }))).status).toBe('error')
    const dnsDown = setup({ [src]: page('hello@acme.test') }, { 'acme.test': 'ERR' })
    expect((await run(dnsDown.lib, 'lead_verified', unit())).status).toBe('error')
  })

  it('falls back to DNS-over-HTTPS when the resolver errors', async () => {
    const yes = setup({ [src]: page('hello@acme.test') }, { 'acme.test': 'ERR' }, () => ({ Status: 0, Answer: [{ type: 15, data: '10 mx.acme.test.' }] }))
    expect((await run(yes.lib, 'lead_verified', unit())).status).toBe('pass')
    const nx = setup({ [src]: page('hello@acme.test') }, { 'acme.test': 'ERR' }, () => ({ Status: 3 }))
    expect((await run(nx.lib, 'lead_verified', unit())).status).toBe('fail')
  })

  it('refuses bad input: bad address, missing source, private source URL', async () => {
    const { lib } = setup({ 'http://10.0.0.1/x': new BlockedUrl('address 10.0.0.1 is not public') }, { 'acme.test': ['mx'] })
    expect((await run(lib, 'lead_verified', unit({ to: 'FORM: contact page' }))).status).toBe('fail')
    expect((await run(lib, 'lead_verified', unit({ to: 'FORM: contact page', verified: false }))).status).toBe('pass') // an honest rejection of a non-address
    expect((await run(lib, 'lead_verified', unit({ email_source_url: '' }))).status).toBe('fail')
    expect((await run(lib, 'lead_verified', unit({ email_source_url: '', verified: false }))).status).toBe('pass')
    const r = await run(lib, 'lead_verified', unit({ email_source_url: 'http://10.0.0.1/x' }))
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('SSRF')
    expect((await run(lib, 'lead_verified', null)).status).toBe('error')
  })
})

describe('http_claim_holds', () => {
  const unit = (meta: Record<string, unknown>, url = 'https://site.test/llms.txt') => ({ url, meta })
  const pages = { 'https://site.test/llms.txt': page('# Site\n> Docs for agents. Pricing: $9', 200, 'text/plain'), 'https://site.test/nope': page('Not found', 404) }

  it('checks expected_status and must_contain / must_not_contain', async () => {
    const { lib } = setup(pages)
    expect((await run(lib, 'http_claim_holds', unit({ expected_status: 200, must_contain: 'docs for agents' }))).status).toBe('pass')
    expect((await run(lib, 'http_claim_holds', unit({ must_contain: ['Pricing', '# Site'], must_not_contain: 'captcha' }))).status).toBe('pass')
    const wrongStatus = await run(lib, 'http_claim_holds', unit({ expected_status: 404 }))
    expect(wrongStatus.status).toBe('fail')
    expect(wrongStatus.detail).toContain('got 200')
    expect((await run(lib, 'http_claim_holds', unit({ must_contain: 'checkout' }))).detail).toContain('missing')
    expect((await run(lib, 'http_claim_holds', unit({ must_not_contain: 'pricing' }))).detail).toContain('must not contain')
    expect((await run(lib, 'http_claim_holds', unit({ expected_status: 404 }, 'https://site.test/nope'))).status).toBe('pass')
  })

  it('needs a claim, a url and a sane shape; honours redirect hops for 3xx claims', async () => {
    const redirected: FetchResult = { ...page('home'), hops: [{ url: 'https://site.test/old', status: 301, location: '/' }, { url: 'https://site.test/', status: 200, location: null }] }
    const { lib } = setup({ 'https://site.test/old': redirected })
    expect((await run(lib, 'http_claim_holds', unit({}))).detail).toContain('no checkable claim')
    expect((await run(lib, 'http_claim_holds', { meta: { expected_status: 200 } })).detail).toContain('no url')
    expect((await run(lib, 'http_claim_holds', unit({ expected_status: 'ok' }))).status).toBe('fail')
    expect((await run(lib, 'http_claim_holds', unit({ expected_status: 301 }, 'https://site.test/old'))).status).toBe('pass')
    expect((await run(lib, 'http_claim_holds', unit({ expected_status: 200 }, 'https://site.test/old'))).status).toBe('pass')
    expect((await run(lib, 'http_claim_holds', unit({ expected_status: 200 }, 'https://site.test/missing'))).detail).toContain('fetch failed')
  })

  it('searches visible text and raw markup, case-insensitively', async () => {
    const { lib } = setup({ 'https://site.test/': page('<html><head><script type="application/ld+json">{"@type":"Product"}</script></head><body><p>Buy &amp; go</p></body></html>') })
    expect((await run(lib, 'http_claim_holds', unit({ must_contain: ['"@type":"product"', 'buy & go'] }, 'https://site.test/'))).status).toBe('pass')
  })
})

const GOOD_BODY =
  'Hi Maya, I read that Northwind Ventures backs developer tools for AI agents, and that is exactly the lane we are in. ' +
  'We built a marketplace where agents hire specialist bots, with payments held in escrow until the work is proven by tests. ' +
  'It runs over MCP today, and three bots are live with real listings behind them. Would a short demo be useful for you this month? ' +
  'If it is outside your focus, please ignore this note and I will not follow up.'

describe('email_lint', () => {
  const email = (over: Record<string, unknown> = {}) => ({ meta: { to: 'maya@northwind.test', company: 'Northwind Ventures', subject: 'agents hiring bots, with escrow', body: GOOD_BODY, ...over } })
  const { lib } = setup({})
  const lint = async (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => run(lib, 'email_lint', email(over), params)

  it('passes a good email', async () => {
    const r = await lint()
    expect(r.detail).toContain('lint passed')
    expect(r.status).toBe('pass')
  })

  it('enforces subject length', async () => {
    expect((await lint({ subject: '' })).detail).toContain('subject_length')
    expect((await lint({ subject: 'x'.repeat(61) })).detail).toContain('subject_length')
    expect((await lint({ subject: 'x'.repeat(60) })).status).toBe('pass')
  })

  it('enforces 50-150 words', async () => {
    expect((await lint({ body: 'Northwind Ventures is great. Would you reply?' })).detail).toContain('body_words')
    expect((await lint({ body: `${GOOD_BODY} ${'word '.repeat(80)}` })).detail).toContain('body_words')
  })

  it('allows one question mark only', async () => {
    const r = await lint({ body: `${GOOD_BODY} Does that work? Or not?` })
    expect(r.status).toBe('fail')
    expect(r.detail).toContain('one_question')
  })

  it('rejects unfilled placeholders and brackets', async () => {
    expect((await lint({ body: GOOD_BODY.replace('Maya', '{first_name}') })).detail).toContain('placeholder')
    expect((await lint({ body: GOOD_BODY.replace('Maya', '[Name]') })).detail).toContain('placeholder')
    expect((await lint({ subject: 'hi {{company}}' })).detail).toContain('placeholder')
  })

  it('requires the recipient company, matching the short name too', async () => {
    expect((await lint({ company: 'Lattice Harbor Capital' })).detail).toContain('company_mention')
    expect((await lint({ company: '' })).detail).toContain('company_mention')
    expect((await lint({ company: 'Northwind Ventures Inc.' })).status).toBe('pass') // "Northwind Ventures" is in the text
    expect((await lint({ company: 'Northwind Capital', body: GOOD_BODY.replace('Northwind Ventures', 'Northwind') })).status).toBe('pass')
  })

  it('rejects spam-trigger phrases but not the plain word free', async () => {
    expect((await lint({ subject: 'Act now: guaranteed leads' })).detail).toContain('spam_words')
    expect((await lint({ body: `${GOOD_BODY} The app is free to try.` })).status).toBe('pass')
  })

  it('rejects ALL-CAPS words over 4 letters except known acronyms', async () => {
    expect((await lint({ subject: 'AMAZING agents for you' })).detail).toContain('shouting')
    expect((await lint({ subject: 'MCP and API bots' })).status).toBe('pass') // <= 4 letters
    expect((await lint({ subject: 'ORANO and PAYPAL escrow' })).status).toBe('pass') // allow-listed brands
    expect((await lint({ subject: 'CUSTOMBRAND escrow' })).status).toBe('fail')
    expect((await lint({ subject: 'CUSTOMBRAND escrow' }, { allow_caps: ['CUSTOMBRAND'] })).status).toBe('pass')
    expect((await lint({ company: 'ACMECORP', subject: 'ACMECORP agents', body: GOOD_BODY.replace('Northwind Ventures', 'ACMECORP') })).status).toBe('pass')
  })

  it('validates params and unit shape, and the lint function matches the check', async () => {
    expect((await lint({}, { bogus: 1 })).status).toBe('error')
    expect((await lint({ subject: 5 })).status).toBe('fail')
    expect((await run(lib, 'email_lint', null)).status).toBe('error')
    expect(lintEmail({ subject: 's', body: 'short', company: 'Acme' }).violations.map((v) => v.rule).sort()).toEqual(['body_words', 'company_mention'])
  })
})
