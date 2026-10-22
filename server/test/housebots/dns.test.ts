// The DNS audit rules and the platform's dns_claims_hold check: deterministic findings and records, two resolvers, and a check that
// re-resolves everything a unit claims and refuses a unit whose facts, findings or records do not hold.
import { describe, expect, it } from 'vitest'
import type { Delivery } from '@rentabot/shared'
import type { CheckContext } from '../../src/intelligence/types.ts'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../src/housebots/checks.ts'
import { analyze, collectFacts, countSpfLookups, dohResolver, dohTxtData, dkimKeyBits, parseDomain, parseDomains, parseSelectors, parseSpf, resolveBoth, selectorsFor, COMMON_DKIM_SELECTORS } from '../../src/housebots/dns-logic.ts'
import { dkimKey, fakeDns, goodZone, messyZone } from './fake-dns.ts'

const ids = (a: ReturnType<typeof analyze>) => a.findings.map((f) => f.id)

describe('input rules', () => {
  it('accepts plain public domain names only', () => {
    expect(parseDomain('Example.COM.')).toBe('example.com')
    for (const bad of ['localhost', '10.0.0.1', 'intranet.local', 'a', 'http://x', 'bad domain.com', 'metadata.google.internal', 'x.invalid', '-a.com', '', 5, null]) expect(parseDomain(bad as never)).toBeNull()
    expect(parseDomains('a-b.com, https://c.org/path\nA-B.com\n127.0.0.1; nope').domains).toEqual(['a-b.com', 'c.org'])
    expect(parseDomains('a-b.com, 127.0.0.1; nope').rejected).toEqual(['127.0.0.1', 'nope'])
    expect(parseDomains(['x.com', 'y.com']).domains).toEqual(['x.com', 'y.com'])
  })
  it('keeps only label-shaped DKIM selectors and always adds the common ones', () => {
    expect(parseSelectors('s1, "; drop", a.b-c, ' + 'x'.repeat(70))).toEqual(['s1', 'a.b-c'])
    const all = selectorsFor(['custom', 'default'])
    expect(all).toContain('custom')
    expect(all.filter((s) => s === 'default')).toHaveLength(1)
    expect(all.length).toBe(COMMON_DKIM_SELECTORS.length + 1)
  })
})

describe('SPF', () => {
  it('parses mechanisms and reports syntax errors, terms after all, ptr and redirect', () => {
    const p = parseSpf('v=spf1 ip4:1.2.3.4/24 include:_spf.x.com a mx ptr -all mx:late.com extra:thing')
    expect(p.all).toBe('-all')
    expect(p.hasPtr).toBe(true)
    expect(p.afterAll).toEqual(['mx:late.com'])
    expect(p.errors).toEqual(['unknown term "extra:thing"'])
    expect(parseSpf('v=spf1 redirect=_spf.x.com').redirect).toBe('_spf.x.com')
    expect(parseSpf('spf1 -all').ok).toBe(false)
    expect(parseSpf('v=spf1 ip4:999.1.1.1 include: -all').errors).toHaveLength(2)
    expect(parseSpf('v=spf1 +all').all).toBe('all')
  })

  it('counts DNS lookups through includes and flags the 10-lookup limit', async () => {
    const zone: Record<string, string[]> = { 'a.com': ['v=spf1 include:b.com a mx -all'], 'b.com': ['v=spf1 include:c.com exists:%{i}.b.com ~all'], 'c.com': ['v=spf1 ip4:1.1.1.1 -all'] }
    const txt = async (n: string) => zone[n] ?? null
    expect(await countSpfLookups('a.com', zone['a.com']![0]!, txt)).toMatchObject({ count: 5, exceeded: false })
    const many = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${i}.com`).join(' ')} -all`
    const r = await countSpfLookups('big.com', many, async () => ['v=spf1 -all'])
    expect(r).toMatchObject({ count: 11, exceeded: true })
    const loop = await countSpfLookups('l.com', 'v=spf1 include:l2.com', async (n) => (n === 'l2.com' ? ['v=spf1 include:l.com'] : null))
    expect(loop.errors.join(' ')).toMatch(/loops|more than once/)
  })
})

describe('two resolvers', () => {
  it('uses what both return; a disagreement keeps only the common records and is flagged', async () => {
    const zone = { 'x.com': { TXT: ['v=spf1 mx -all', 'other'] } }
    const same = await resolveBoth(fakeDns(zone), 'x.com', 'TXT')
    expect(same).toMatchObject({ status: 'ok', agree: true, records: ['other', 'v=spf1 mx -all'] })
    const split = await resolveBoth(fakeDns(zone, { dohZone: { 'x.com': { TXT: ['other'] } } }), 'x.com', 'TXT')
    expect(split).toMatchObject({ agree: false, records: ['other'] })
    const f = fakeDns(zone)
    f.breakNames(['x.com'])
    expect(await resolveBoth(f, 'x.com', 'TXT')).toMatchObject({ status: 'error' })
    // one resolver down: the other one answers
    const half = fakeDns(zone)
    half.system.resolve = async () => ({ status: 'error', records: [] })
    expect(await resolveBoth(half, 'x.com', 'TXT')).toMatchObject({ status: 'ok', agree: true })
  })

  it('reads DoH answers (Cloudflare JSON), falls back to the next endpoint, and decodes chunked TXT data', async () => {
    expect(dohTxtData('"v=spf1 include:a.com " "~all"')).toBe('v=spf1 include:a.com ~all')
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      if (url.startsWith('https://cloudflare-dns.com')) return new Response('nope', { status: 503 })
      const name = new URL(url).searchParams.get('name')
      const type = new URL(url).searchParams.get('type')
      const body = name === 'gone.com' ? { Status: 3 } : type === 'MX' ? { Status: 0, Answer: [{ type: 15, data: '10 Mail.X.com.' }] } : { Status: 0, Answer: [{ type: 16, data: '"v=spf1 -all"' }, { type: 5, data: 'x.' }] }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } })
    }) as unknown as typeof fetch
    const r = dohResolver({ fetchImpl })
    expect(await r.resolve('x.com', 'MX')).toEqual({ status: 'ok', records: ['10 mail.x.com'] })
    expect(await r.resolve('x.com', 'TXT')).toEqual({ status: 'ok', records: ['v=spf1 -all'] })
    expect(await r.resolve('gone.com', 'TXT')).toEqual({ status: 'nxdomain', records: [] })
    expect(seen.some((u) => u.startsWith('https://dns.google/resolve'))).toBe(true)
    const dead = dohResolver({ fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch })
    expect((await dead.resolve('x.com', 'TXT')).status).toBe('error')
  })
})

describe('findings and records', () => {
  it('a healthy domain has nothing to fix', async () => {
    const a = analyze(await collectFacts('good.com', selectorsFor([]), fakeDns(goodZone('good.com'))))
    expect(a.fixes).toEqual([])
    expect(a.findings.filter((f) => f.severity !== 'info')).toEqual([])
    expect(ids(a)).toEqual(expect.arrayContaining(['spf_all_soft', 'dkim_found', 'mta_sts_present', 'tls_rpt_present']))
  })

  it('a messy domain gets the findings and the exact records to add or replace', async () => {
    const facts = await collectFacts('messy.com', selectorsFor([]), fakeDns(messyZone('messy.com')))
    const a = analyze(facts)
    expect(a.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity}:${f.id}`)).toEqual([
      'high:spf_multiple',
      'medium:dkim_key_weak:google',
      'medium:dmarc_p_none',
      'low:dmarc_no_rua',
      'low:mta_sts_missing',
      'low:mx_single',
      'low:tls_rpt_missing',
    ])
    expect(a.fixes).toEqual([
      { action: 'replace', type: 'TXT', name: 'messy.com', value: 'v=spf1 mx include:_spf.messy.com ~all', why: expect.any(String) },
      { action: 'replace', type: 'TXT', name: '_dmarc.messy.com', value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@messy.com', why: expect.any(String) },
      { action: 'add', type: 'TXT', name: '_mta-sts.messy.com', value: expect.stringMatching(/^v=STSv1; id=[0-9a-f]{12}$/), why: expect.stringContaining('https://mta-sts.messy.com/.well-known/mta-sts.txt') },
      { action: 'add', type: 'TXT', name: '_smtp._tls.messy.com', value: 'v=TLSRPTv1; rua=mailto:tls-reports@messy.com', why: expect.any(String) },
    ])
    // deterministic: the same facts give the same answer
    expect(analyze(facts)).toEqual(a)
  })

  it('+all is critical and is replaced by ~all; no all gets one; a missing SPF/DMARC is added; a missing domain is its own finding', async () => {
    const plus = analyze(await collectFacts('p.com', [], fakeDns({ 'p.com': { MX: ['10 m.p.com'], TXT: ['v=spf1 +all'] } })))
    expect(plus.findings.find((f) => f.id === 'spf_all_plus')?.severity).toBe('critical')
    expect(plus.fixes[0]).toMatchObject({ action: 'replace', name: 'p.com', value: 'v=spf1 ~all' })
    const none = analyze(await collectFacts('n.com', [], fakeDns({ 'n.com': { MX: ['10 m.n.com'], TXT: ['v=spf1 mx'] } })))
    expect(none.fixes.find((f) => f.name === 'n.com')?.value).toBe('v=spf1 mx ~all')
    const bare = analyze(await collectFacts('b.com', selectorsFor([]), fakeDns({ 'b.com': { MX: ['10 m.b.com'] } })))
    expect(bare.fixes.map((f) => `${f.action} ${f.name} ${f.value}`)).toEqual(expect.arrayContaining(['add b.com v=spf1 mx ~all', 'add _dmarc.b.com v=DMARC1; p=none; rua=mailto:dmarc-reports@b.com']))
    expect(ids(bare)).toEqual(expect.arrayContaining(['spf_missing', 'dmarc_missing', 'dkim_none_found']))
    const nomail = analyze(await collectFacts('s.com', [], fakeDns({ 's.com': { MX: ['0 .'] } })))
    expect(ids(nomail)).toContain('mx_null')
    expect(nomail.fixes.find((f) => f.name === 's.com')?.value).toBe('v=spf1 -all')
    expect(nomail.fixes.some((f) => f.name.startsWith('_mta-sts'))).toBe(false) // a domain that takes no mail needs no MTA-STS
    const gone = analyze(await collectFacts('gone.com', [], fakeDns({})))
    expect(ids(gone)).toEqual(['domain_not_found'])
  })

  it('flags the 10-lookup limit and a disagreement between the resolvers', async () => {
    const includes = Array.from({ length: 11 }, (_, i) => `include:i${i}.good.com`)
    const zone = { ...goodZone('good.com'), 'good.com': { MX: ['10 a.good.com', '20 b.good.com'], TXT: [`v=spf1 ${includes.join(' ')} -all`] } }
    for (let i = 0; i < 11; i++) (zone as Record<string, { TXT?: string[] }>)[`i${i}.good.com`] = { TXT: ['v=spf1 -all'] }
    const a = analyze(await collectFacts('good.com', [], fakeDns(zone, { dohZone: { ...zone, '_dmarc.good.com': {} } })))
    expect(a.findings.find((f) => f.id === 'spf_lookup_limit')).toMatchObject({ severity: 'high', title: expect.stringContaining('11 DNS lookups') })
    expect(ids(a)).toContain('resolvers_disagree')
  })

  it('estimates the size of an RSA key from p=', () => {
    expect(dkimKeyBits(dkimKey(1024))).toBe(1024)
    expect(dkimKeyBits(dkimKey(2048))).toBe(2048)
    expect(dkimKeyBits('')).toBeNull()
  })
})

// ---------- the check ----------

const spec = (domains: string[], selectors = '') => ({ inputs: { domains: domains.join('\n'), ...(selectors ? { dkim_selectors: selectors } : {}) } })

async function runCheck(zone: ReturnType<typeof fakeDns>, domains: string[], meta: Record<string, unknown>, opts: { attempt?: number; selectors?: string } = {}) {
  const lib = createCheckLibrary()
  registerHouseBotChecks(lib, { dns: zone })
  const unit = { ref: String(meta.domain), artifact_ids: [], meta } as Delivery['deliverables'][number]['units'][number]
  const ctx = { job_id: 'job_x', contract: spec(domains, opts.selectors) as never, deliverable_id: 'D1', unit, test: { check: 'dns_claims_hold', params: {} }, attempt: opts.attempt ?? 1, artifact: async () => null, saveEvidence: async () => 'ev_1' } as CheckContext
  return lib.get('dns_claims_hold')!.run(ctx)
}

async function claim(dns: ReturnType<typeof fakeDns>, domain: string, selectors: string[] = []) {
  const facts = await collectFacts(domain, selectorsFor(selectors), dns)
  const a = analyze(facts)
  return { domain, facts, findings: a.findings, fixes: a.fixes }
}

describe('dns_claims_hold', () => {
  it('passes a unit whose facts, findings and records are what DNS says now', async () => {
    const dns = fakeDns({ ...messyZone('messy.com'), ...goodZone('good.com') })
    expect((await runCheck(dns, ['messy.com'], await claim(dns, 'messy.com'))).status).toBe('pass')
    expect((await runCheck(dns, ['good.com'], await claim(dns, 'good.com'))).status).toBe('pass')
    // a nonexistent domain is a checkable result too
    expect((await runCheck(dns, ['gone.com'], await claim(dns, 'gone.com'))).status).toBe('pass')
  })

  it('fails every kind of false claim', async () => {
    const dns = fakeDns({ ...messyZone('messy.com'), ...goodZone('good.com') })
    const honest = await claim(dns, 'messy.com')
    const mutate = (f: (m: ReturnType<typeof structuredClone<typeof honest>>) => void) => {
      const m = structuredClone(honest)
      f(m)
      return m
    }
    // a record that is not there
    const spf = await runCheck(dns, ['messy.com'], mutate((m) => (m.facts.dmarc.records = ['v=DMARC1; p=reject'])))
    expect(spf).toMatchObject({ status: 'fail', detail: expect.stringContaining('DMARC') })
    // a finding made up
    expect(await runCheck(dns, ['messy.com'], mutate((m) => m.findings.push({ id: 'dmarc_missing', severity: 'high', title: 't', detail: 'd' })))).toMatchObject({ status: 'fail', detail: expect.stringContaining('dmarc_missing:high is claimed') })
    // a finding left out
    expect((await runCheck(dns, ['messy.com'], mutate((m) => (m.findings = m.findings.filter((f) => f.id !== 'spf_multiple'))))).detail).toMatch(/spf_multiple:high is missing/)
    // a different severity
    expect((await runCheck(dns, ['messy.com'], mutate((m) => (m.findings[0]!.severity = 'info')))).status).toBe('fail')
    // a wrong record to add, and a record left out
    expect((await runCheck(dns, ['messy.com'], mutate((m) => (m.fixes[1]!.value = 'v=DMARC1; p=none')))).detail).toMatch(/DNS record/)
    expect((await runCheck(dns, ['messy.com'], mutate((m) => m.fixes.pop()))).detail).toMatch(/is missing from the unit/)
    // the lookup count
    expect((await runCheck(dns, ['messy.com'], mutate((m) => (m.facts.spf_lookups = { count: 3, exceeded: false, errors: [] })))).status).toBe('fail')
    // a domain the buyer never asked for
    expect(await runCheck(dns, ['good.com'], honest)).toMatchObject({ status: 'fail', detail: expect.stringContaining('not one of the domains') })
    // skipped DKIM selectors, and no facts at all
    expect((await runCheck(dns, ['messy.com'], mutate((m) => delete m.facts.dkim.default))).detail).toMatch(/did not try the DKIM selector/)
    expect((await runCheck(dns, ['messy.com'], { domain: 'messy.com' })).status).toBe('fail')
    // the buyer's own selector must have been tried
    expect((await runCheck(dns, ['messy.com'], honest, { selectors: 'mykey' })).detail).toMatch(/mykey/)
    // DNS changed after the audit
    const changed = fakeDns({ ...messyZone('messy.com'), '_dmarc.messy.com': { TXT: ['v=DMARC1; p=reject; rua=mailto:a@messy.com'] } })
    expect((await runCheck(changed, ['messy.com'], honest)).status).toBe('fail')
  })

  it('is pending, then an error, when the resolvers cannot answer: never a free pass or a false failure', async () => {
    const dns = fakeDns(goodZone('good.com'))
    const honest = await claim(dns, 'good.com')
    dns.breakNames(['_dmarc.good.com'])
    expect(await runCheck(dns, ['good.com'], honest, { attempt: 1 })).toMatchObject({ status: 'pending' })
    expect(await runCheck(dns, ['good.com'], honest, { attempt: 2 })).toMatchObject({ status: 'error' })
    // a unit that claims the same unknown is consistent with what the platform sees
    const sameUnknown = await claim(dns, 'good.com')
    expect((await runCheck(dns, ['good.com'], sameUnknown)).status).toBe('pass')
  })
})
