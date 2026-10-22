import { afterEach, describe, expect, it } from 'vitest'
import type { Ai } from '../src/ai.ts'
import { auditSite, auditor, buildReport, jsonLdTypes } from '../src/bots/auditor.ts'
import { leadVerifier, verifyLead, createVerifyContext } from '../src/bots/lead-verifier.ts'
import { createPoliteWeb, parseRobots, RateLimiter } from '../src/web.ts'
import { createCheckLibrary } from '../../server/src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../server/src/housebots/checks.ts'
import { fakeTools, makeJob, makeSpec, NO_AI, passedUnits, runAcceptance, startSite } from './helpers.ts'

type Site = Awaited<ReturnType<typeof startSite>>
const sites: Site[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()))
})
const site = async (h: Parameters<typeof startSite>[0]) => {
  const s = await startSite(h)
  sites.push(s)
  return s
}

const cf = (s: string, key = 0x2b) => key.toString(16).padStart(2, '0') + [...s].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('')

// ---------------------------------------------------------------- Lead Verifier

const MX: Record<string, string[] | 'ENODATA'> = { 'acme.test': ['mx.acme.test'], 'globex.test': ['mx.globex.test'], 'initech.test': ['mx.initech.test'], 'nomx.test': 'ENODATA' }
const mxOpts = {
  resolveMx: async (d: string) => {
    const v = MX[d]
    if (!v || v === 'ENODATA') throw Object.assign(new Error('no data'), { code: 'ENODATA' })
    return v.map((exchange) => ({ exchange, priority: 10 }))
  },
}

describe('Lead Verifier', () => {
  const makeSite = () => {
    let flaky = 0
    return site((u) => {
      switch (u.pathname) {
        case '/team':
          return [200, '<p>Contact <a href="mailto:hello@acme.test">us</a></p>']
        case '/cf':
          return [200, `<a class="__cf_email__" data-cfemail="${cf('sales@globex.test')}">[email&#160;protected]</a>`]
        case '/none':
          return [200, '<p>Write to info@initech.test only</p>']
        case '/nomx':
          return [200, '<p>ceo@nomx.test</p>']
        case '/flaky':
          return flaky++ === 0 ? [503, 'try later'] : [200, '<p>team@acme.test</p>']
        default:
          return [404, 'not found']
      }
    })
  }

  it('verifies each lead exactly as the platform does, and the platform agrees on every unit', async () => {
    const s = await makeSite()
    const leads = [
      { to: 'hello@acme.test', company: 'Acme Ltd', email_source_url: `${s.origin}/team`, country: 'UK' }, // mailto + MX: verified
      { to: 'sales@globex.test', company: 'Globex', email_source_url: `${s.origin}/cf`, country: 'US' }, // Cloudflare-protected: verified
      { to: 'bob@initech.test', company: 'Initech', email_source_url: `${s.origin}/none`, country: 'US' }, // address not on the page: rejected
      { to: 'ceo@nomx.test', company: 'NoMX', email_source_url: `${s.origin}/nomx`, country: 'US' }, // no MX: rejected
      { to: 'ghost@acme.test', company: 'Ghost', email_source_url: `${s.origin}/gone`, country: 'UK' }, // 404 page: rejected
      { to: 'team@acme.test', company: 'Acme again', email_source_url: `${s.origin}/flaky`, country: 'UK' }, // one 503, then fine
      { to: 'FORM: contact page', company: 'FormCo', email_source_url: `${s.origin}/team`, country: 'US' },
      { to: 'someone@gmail.com', company: 'Personal', email_source_url: `${s.origin}/team`, country: 'US' },
    ]
    const web = createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 })
    const bot = leadVerifier({ web, mx: { ...mxOpts, doh: async () => ({ ok: false, json: async () => ({}) }) } })
    const spec = makeSpec({ skill_id: 'verify_leads', quantity: 8, acceptance: [{ check: 'lead_verified', params: {} }] })
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, { leads_jsonl: leads.map((l) => JSON.stringify(l)).join('\n') + '\nnot json' }), tools)
    const units = r.delivery.deliverables[0]!.units
    const verdict = (n: number) => units[n]!.meta
    expect(units).toHaveLength(8)
    expect([0, 1, 5].map((i) => verdict(i).verified)).toEqual([true, true, true])
    expect([2, 3, 4, 6, 7].map((i) => verdict(i).verified)).toEqual([false, false, false, false, false])
    expect(String(verdict(2).why)).toContain('not on the source page')
    expect(String(verdict(3).why)).toContain('no MX records')
    expect(String(verdict(4).why)).toContain('HTTP 404')
    expect(String(verdict(6).why)).toContain('not an email address')
    expect(verdict(5).flags).toEqual(['second_contact_at_domain']) // flagged, still verified
    expect(r.delivery.note).toContain('3 verified, 5 not verified')
    expect(r.delivery.note).toContain('1 input line(s)')

    // The platform re-verifies every unit itself; honest rejections pass, true verifications pass.
    const lib = createCheckLibrary({ allowHosts: [s.host] })
    registerHouseBotChecks(lib, { allowHosts: [s.host], ...mxOpts, doh: async () => ({ ok: false, json: async () => ({}) }) })
    // gmail.com has no mock MX and no source mailto at /team: the platform cannot verify it either (honest false). Give it MX so the page decides.
    const results = await runAcceptance(lib, spec, r.delivery, tools)
    const failing = results.filter((x) => x.status !== 'pass')
    // someone@gmail.com: page /team does not contain it -> platform cannot verify -> honest rejection passes (MX lookup there is inconclusive but the page is a definite negative)
    expect(failing).toEqual([])
    expect(passedUnits(results)).toHaveLength(8)
  })

  it('is polite: browser-like UA, no retry on 4xx, one retry on 5xx, one fetch per page', async () => {
    const s = await makeSite()
    const web = createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 })
    const ctx = createVerifyContext(web, { ...mxOpts, doh: async () => ({ ok: false, json: async () => ({}) }) })
    await verifyLead({ to: 'ghost@acme.test', email_source_url: `${s.origin}/gone` }, ctx)
    await verifyLead({ to: 'a@acme.test', email_source_url: `${s.origin}/gone` }, ctx) // same page again: cached
    await verifyLead({ to: 'team@acme.test', email_source_url: `${s.origin}/flaky` }, ctx)
    expect(s.hits.filter((h) => h.path === '/gone')).toHaveLength(1)
    expect(s.hits.filter((h) => h.path === '/flaky')).toHaveLength(2)
    expect(s.hits.every((h) => /Mozilla\/5\.0/.test(h.ua))).toBe(true)
  })

  it('never fetches private addresses it was not allowed to', async () => {
    const s = await makeSite()
    const web = createPoliteWeb({ perSecond: 1000 }) // no allow list: 127.0.0.1 is private
    const ctx = createVerifyContext(web, mxOpts)
    const v = await verifyLead({ to: 'hello@acme.test', email_source_url: `${s.origin}/team` }, ctx)
    expect(v.verified).toBe(false)
    expect(v.why).toContain('could not read the source page')
    expect(s.hits).toHaveLength(0)
  })

  it('spaces requests at 2 per second', async () => {
    const lim = new RateLimiter(2)
    const t0 = Date.now()
    for (let i = 0; i < 4; i++) await lim.wait()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400) // 3 gaps of 500 ms
  })

  it('names missing inputs and declines out-of-scope asks', () => {
    const bot = leadVerifier()
    expect(bot.missingInputs({}, makeSpec())).toEqual(['leads_jsonl'])
    expect(bot.missingInputs({ leads: [{ to: 'a@b.co' }] }, makeSpec())).toEqual([])
    expect(bot.scope(makeSpec({ goal: 'Verify these leads and scrape personal profiles from social media' }), {} as never)).toContain('scrape personal')
    expect(bot.scope(makeSpec({ goal: 'Verify the business addresses on this list of 40 UK companies' }), {} as never)).toBeNull()
  })
})

// ---------------------------------------------------------------- Agent-Readiness Auditor

const HOME = `<!doctype html><html><head><title>Acme</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme"},{"@type":"Product","name":"Widget"}]}</script></head>
<body><h1>Acme</h1><a href="/pricing">Pricing</a> <a href="/docs">Docs</a></body></html>`

const goodSite = () =>
  site((u) => {
    switch (u.pathname) {
      case '/robots.txt':
        return [200, 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n', { 'content-type': 'text/plain' }]
      case '/llms.txt':
        return [200, '# Acme\n> Acme sells widgets to agents.\n\n## Docs\n- [Pricing](/pricing)\n', { 'content-type': 'text/plain' }]
      case '/.well-known/agent.json':
        return [200, JSON.stringify({ name: 'Acme Agent', url: 'https://acme.test', skills: [] }), { 'content-type': 'application/json' }]
      case '/openapi.json':
        return [200, JSON.stringify({ openapi: '3.1.0', info: { title: 'Acme', version: '1' }, paths: {} }), { 'content-type': 'application/json' }]
      case '/':
        return [200, HOME]
      case '/pricing':
        return [200, '<h1>Pricing</h1>']
      default:
        return [404, 'Not found', { 'content-type': 'text/plain' }]
    }
  })

describe('Agent-Readiness Auditor', () => {
  it('turns real fetches into findings and a score', async () => {
    const s = await goodSite()
    const web = createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 })
    const a = await auditSite(s.origin, web)
    const by = Object.fromEntries(a.findings.map((f) => [f.id, f]))
    expect(by.llms_txt).toMatchObject({ status: 'pass', points: 15 })
    expect(by.llms_full_txt).toMatchObject({ status: 'fail', claim: { expected_status: 404 } })
    expect(by.agent_card).toMatchObject({ status: 'pass', points: 15 })
    expect(by.mcp_json).toMatchObject({ status: 'fail', points: 0 })
    expect(by.openapi).toMatchObject({ status: 'pass', points: 15 })
    expect(by.robots_ai).toMatchObject({ status: 'fail', points: 12 }) // GPTBot blocked, the other four allowed
    expect(by.robots_ai!.detail).toContain('blocks GPTBot')
    expect(by.jsonld).toMatchObject({ status: 'fail', points: 7 }) // Organization + Product, no Offer
    expect(by.pricing_linked).toMatchObject({ status: 'pass' })
    expect(by.pricing_page).toMatchObject({ status: 'pass' })
    expect(a.score).toBe(74)
    expect(a.max).toBe(100)
    // every request was a real GET the site saw
    expect(a.requests).toBe(s.hits.length)
    expect(jsonLdTypes(HOME).sort()).toEqual(['Organization', 'Product'])
  })

  it('delivers a report plus per-finding claims that the platform re-fetches and confirms', async () => {
    const s = await goodSite()
    const bot = auditor({ web: createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }) })
    const spec = makeSpec({
      skill_id: 'agent_readiness_audit',
      quantity: 1,
      acceptance: [{ check: 'report_sections_present', params: { headings: ['Summary', 'Score', 'Findings', 'Fixes'] } }],
    })
    spec.deliverables.push({ id: 'D2', description: 'Each finding as a re-checkable claim', quantity: 1, acceptance: [{ check: 'http_claim_holds', params: {} }], rubric: '' })
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, { site_url: `${s.origin}/` }), tools)
    expect(r.delivery.deliverables.map((d) => [d.deliverable_id, d.units.length > 0])).toEqual([['D1', true], ['D2', true]])
    expect(r.delivery.deliverables[0]!.units).toHaveLength(1) // the report, one unit
    expect(r.delivery.deliverables[1]!.units.length).toBeGreaterThanOrEqual(8) // one unit per re-checkable finding
    const report = tools.uploads[0]!
    expect(report).toMatchObject({ name: 'agent-readiness-report.md', mime: 'text/markdown' })
    for (const h of ['## Summary', '## Score', '## Findings', '## Fixes']) expect(report.text).toContain(h)
    expect(report.text).toContain('74 / 100')

    const lib = createCheckLibrary({ allowHosts: [s.host] })
    registerHouseBotChecks(lib, { allowHosts: [s.host] })
    const results = await runAcceptance(lib, spec, r.delivery, tools)
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
  })

  it('works when one deliverable carries both checks (every unit satisfies both)', async () => {
    const s = await goodSite()
    const bot = auditor({ web: createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }) })
    const spec = makeSpec({ skill_id: 'agent_readiness_audit', quantity: 1, acceptance: [{ check: 'report_sections_present', params: { headings: ['Summary', 'Findings'] } }, { check: 'http_claim_holds', params: {} }] })
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, { site_url: s.origin }), tools)
    const results = await runAcceptance(
      (() => {
        const lib = createCheckLibrary({ allowHosts: [s.host] })
        registerHouseBotChecks(lib, { allowHosts: [s.host] })
        return lib
      })(),
      spec,
      r.delivery,
      tools,
    )
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
    expect(results.length).toBeGreaterThan(10)
  })

  // Production 2026-10-19: the spec copilot asked for one heading per discovery file plus Recommendations; the report
  // had none of them, the check failed and the buyer's $9.00 authorization was voided with the seller paid nothing.
  const COPILOT_HEADINGS = ['Summary', 'llms.txt', 'agent.json', 'mcp.json', 'OpenAPI', 'Recommendations']
  const auditSpec = (headings: string[]) => {
    const spec = makeSpec({ skill_id: 'agent_readiness_audit', quantity: 1, acceptance: [{ check: 'report_sections_present', params: { headings } }] })
    spec.deliverables.push({ id: 'D2', description: 'Each finding as a re-checkable claim', quantity: 1, acceptance: [{ check: 'http_claim_holds', params: {} }], rubric: '' })
    return spec
  }

  it('writes the report sections the spec names, from the audit itself, and the platform check passes', async () => {
    const s = await goodSite()
    const bot = auditor({ web: createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }) })
    const spec = auditSpec(COPILOT_HEADINGS)
    expect(bot.scope(spec, {} as never)).toBeNull()
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, { site_url: s.origin }), tools)
    const text = tools.uploads[0]!.text
    for (const h of ['## llms.txt', '## agent.json', '## mcp.json', '## OpenAPI', '## Recommendations']) expect(text).toContain(h)
    expect(text).toContain('A2A agent card at /.well-known/agent.json') // the section is the finding, not filler
    const lib = createCheckLibrary({ allowHosts: [s.host] })
    registerHouseBotChecks(lib, { allowHosts: [s.host] })
    const results = await runAcceptance(lib, spec, r.delivery, tools)
    expect(results.filter((x) => x.status !== 'pass')).toEqual([])
  })

  it('a requested section for something the audit did not assess says so, and still satisfies the check', async () => {
    const s = await site((u) => (u.pathname === '/robots.txt' ? [200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' }] : [404, 'nope']))
    const bot = auditor({ web: createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }) })
    const spec = auditSpec(['Summary', 'schema.org'])
    const tools = fakeTools()
    const r = await bot.work(makeJob(spec, { site_url: s.origin }), tools)
    expect(tools.uploads[0]!.text).toMatch(/## schema\.org\n\nNot assessed in this audit\. .*disallows "\/"/)
    const lib = createCheckLibrary({ allowHosts: [s.host] })
    registerHouseBotChecks(lib, { allowHosts: [s.host] })
    const results = await runAcceptance(lib, spec, r.delivery, tools)
    expect(results.filter((x) => x.check === 'report_sections_present' && x.status !== 'pass')).toEqual([])
  })

  it('declines, naming them, a spec whose report sections it cannot write', () => {
    const bot = auditor()
    const why = bot.scope(auditSpec(['Summary', 'Competitor pricing analysis', 'Recommendations', 'Audit findings']), {} as never)
    expect(why).toContain('"Competitor pricing analysis"')
    expect(why).toContain('"Audit findings"') // "Findings" alone is fine; this exact heading would not be in the report
    expect(why).not.toContain('"Summary"')
    expect(why).not.toContain('"Recommendations"')
    for (const ok of [['Summary', 'Findings'], ['Summary', 'Score', 'Findings', 'Fixes'], COPILOT_HEADINGS, ['llms.txt and llms-full.txt', 'MCP', 'Next steps']]) expect(bot.scope(auditSpec(ok), {} as never)).toBeNull()
  })

  it('respects robots.txt beyond the fixed well-known paths', async () => {
    const s = await site((u) => {
      if (u.pathname === '/robots.txt') return [200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' }]
      if (u.pathname === '/llms.txt') return [200, '# Closed\n> A site that disallows crawling but publishes llms.txt\n', { 'content-type': 'text/plain' }]
      return [200, HOME]
    })
    const a = await auditSite(s.origin, createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }))
    expect(s.hits.map((h) => h.path)).not.toContain('/') // the home page was not crawled
    expect(s.hits.map((h) => h.path)).not.toContain('/pricing')
    expect(a.findings.find((f) => f.id === 'home_crawl')?.detail).toContain('disallows "/"')
    expect(a.findings.find((f) => f.id === 'llms_txt')?.status).toBe('pass') // the fixed path is still read
    expect(a.findings.find((f) => f.id === 'robots_ai')?.status).toBe('fail')
  })

  it('reports a site with nothing, honestly (soft-404s are not files)', async () => {
    const s = await site(() => [200, '<html><body>Welcome to our page</body></html>'])
    const a = await auditSite(s.origin, createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }))
    const by = Object.fromEntries(a.findings.map((f) => [f.id, f]))
    expect(by.llms_txt!.status).toBe('fail')
    expect(by.llms_txt!.detail).toContain('serves an HTML page')
    expect(by.llms_txt!.claim).toMatchObject({ expected_status: 200, must_contain: ['<html'] })
    expect(by.jsonld!.claim).toMatchObject({ must_not_contain: ['application/ld+json'] })
    expect(by.pricing_linked!.status).toBe('fail')
    expect(a.score).toBeLessThan(20)
  })

  it('uses the AI only for the summary and fixes, and rejects invented numbers', async () => {
    const s = await goodSite()
    const a = await auditSite(s.origin, createPoliteWeb({ allowHosts: [s.host], perSecond: 1000 }))
    const mk = (summary: string): Ai => ({ enabled: true, complete: async () => JSON.stringify({ summary, fixes: ['Publish /.well-known/mcp.json.', 'Add an Offer to the JSON-LD.'] }) })
    const honest = await buildReport(a, mk('Acme is well set up for agents at 74 out of 100, with gaps in MCP discovery and structured offers that are easy to fix.'))
    expect(honest.usedAi).toBe(true)
    expect(honest.markdown).toContain('Publish /.well-known/mcp.json.')
    const lying = await buildReport(a, mk('Acme scores 97 out of 100 and has 55 findings, which is excellent overall for an agent-ready site.'))
    expect(lying.usedAi).toBe(false)
    // The invented claims, not a bare "97": the report also holds the test server's port and timings, which can contain it.
    expect(lying.markdown).not.toMatch(/97 out of 100|55 findings/)
    const none = await buildReport(a, NO_AI)
    expect(none.usedAi).toBe(false)
    expect(none.markdown).toContain('## Fixes')
  })

  it('names the input it needs', () => {
    const bot = auditor()
    expect(bot.missingInputs({ site_url: 'not a url' }, makeSpec())).toEqual(['site_url'])
    expect(bot.missingInputs({ site_url: 'https://example.com' }, makeSpec())).toEqual([])
  })
})

describe('robots parser', () => {
  it('applies the longest matching rule, groups by agent, and wildcards', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /*.pdf$\n')
    expect(r.allowed('Mozilla', '/private/x')).toBe(false)
    expect(r.allowed('Mozilla', '/private/ok')).toBe(true)
    expect(r.allowed('GPTBot', '/')).toBe(false)
    expect(r.allowed('CCBot', '/anything')).toBe(false)
    expect(r.allowed('ClaudeBot', '/a.pdf')).toBe(false)
    expect(r.allowed('ClaudeBot', '/a.html')).toBe(true)
    expect(r.groupFor('ClaudeBot').explicit).toBe(true)
    expect(r.groupFor('PerplexityBot').explicit).toBe(false)
    expect(parseRobots('').allowed('x', '/')).toBe(true)
  })
})
