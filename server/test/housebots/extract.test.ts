// The extraction rules (what counts as "this value is on that page") and the platform's page_extraction_verified check run against a fixture page.
import http from 'node:http'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Delivery } from '@rentabot/shared'
import type { CheckContext } from '../../src/intelligence/types.ts'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../src/housebots/checks.ts'
import { checkRow, fieldProblem, minFilled, norm, pageFacts, parseFields, parseUrls, ruleExtract } from '../../src/housebots/extract-logic.ts'

const PAGE = `<!doctype html><html lang="en"><head>
<title>Acme Widget &mdash; Pro | Acme Store</title>
<meta name="description" content="The Acme Widget Pro: built for teams that ship.">
<meta property="og:title" content="Acme Widget Pro">
<script>var secret = 'Price: $999999'</script></head>
<body><h1>Acme Widget Pro</h1>
<p>Our Pro plan costs $1,299.00 per year, or &euro;49 a month for small teams. <!-- hidden: $5 --></p>
<p>Questions? Write to <a href="mailto:sales@acme.test">our sales team</a> or <a href="mailto:support%40acme.test?subject=Hi">support</a>, call +1 (555) 010-0199 or 020 7946 0958.</p>
<p>Released 2026-10-20 on server 10.0.0.1. Rating: &ldquo;best widget ever&rdquo; said Maya&rsquo;s review.</p>
<ul><li>Plan name: Pro Annual</li><li>Author: Maya Okafor</li></ul>
<p><a href="tel:+15550100199">Call us</a></p></body></html>`

const facts = pageFacts(PAGE)
const fields = (s: string) => parseFields(s).fields

describe('inputs', () => {
  it('parses fields: names, hints, built-ins, limits', () => {
    const r = parseFields('title\nPlan Name: the name of the cheapest plan\nbad name!\ntitle\nemails')
    expect(r.fields).toEqual([
      { name: 'title', hint: '', builtin: true },
      { name: 'plan_name', hint: 'the name of the cheapest plan', builtin: false },
      { name: 'emails', hint: '', builtin: true },
    ])
    expect(r.rejected).toEqual(['bad name!', 'title'])
    expect(parseFields('title, price , h1').fields.map((f) => f.name)).toEqual(['title', 'price', 'h1'])
    expect(parseFields(Array.from({ length: 20 }, (_, i) => `f${i}`).join('\n')).fields).toHaveLength(12)
    expect(parseFields(42).fields).toEqual([])
  })
  it('parses urls: http(s) only, canonical, de-duplicated, capped', () => {
    const r = parseUrls('https://a.test/x#frag\nHTTPS://A.test/x\nftp://a.test/f javascript:alert(1)\r\n http://b.test/y, not a url')
    expect(r.urls).toEqual(['https://a.test/x', 'http://b.test/y'])
    expect(r.rejected).toEqual(['ftp://a.test/f', 'javascript:alert(1)', 'not', 'a', 'url'])
    expect(parseUrls(Array.from({ length: 400 }, (_, i) => `https://s.test/${i}`).join('\n')).urls).toHaveLength(300)
  })
  it('normalises case, spacing, curly quotes, dashes and thousands commas', () => {
    expect(norm('  The  “Best” — Widget Pro  ')).toBe('the "best" - widget pro')
    expect(norm('$1,299,000.50 and 1,5')).toBe('$1299000.50 and 1,5')
  })
})

describe('what a page says', () => {
  it('reads title, descriptions, h1, mailto and tel targets, ignoring scripts and comments', () => {
    expect(facts.title).toBe('Acme Widget — Pro | Acme Store')
    expect(facts.description).toBe('The Acme Widget Pro: built for teams that ship.')
    expect(facts.ogTitle).toBe('Acme Widget Pro')
    expect(facts.h1).toBe('Acme Widget Pro')
    expect(facts.mailtos).toEqual(['sales@acme.test', 'support@acme.test'])
    expect(facts.tels).toEqual(['+15550100199'])
    expect(facts.corpus).not.toContain('999999')
    expect(facts.corpus).not.toContain('hidden')
    expect(facts.corpus).toContain('our pro plan costs $1299.00 per year')
  })
})

describe('a tag ends at the first ">" outside its quoted attribute values (Wikipedia puts JSON with ">" and "<!--" in data-mw)', () => {
  // The lead of an en.wikipedia.org biography, reduced: the footnote <sup> carries its template data in a single-quoted attribute.
  const WIKI = `<!doctype html><html><head><title>Albert - Wikipedia</title></head><body><h1>Albert</h1>
    <p><b>Albert</b> <sup class="r" data-mw='{"parts":[{"template":{"params":{"1":{"wt":"{{IPAc-en|a}};&lt;ref name=\\"N\\"/> {{IPA|de|b}}<!--<ref/>"}}}}]}'><a href="#c">[a]</a></sup>
    (14 March 1879) was a German-born<!-- Please do not change this --> theoretical physicist.</p>
    <p>Swallowed by the old comment stripper.</p><!-- a real comment --><p id="after" title="a > b">Visible after.</p><script>var x = "<p>no</p>"</script></body></html>`
  const f = pageFacts(WIKI)
  it('keeps attribute text out of the page text, so the visible lead sentence is one passage', () => {
    expect(f.text).not.toMatch(/parts|template|IPAc|wt/)
    expect(f.text).toContain('(14 March 1879) was a German-born theoretical physicist.')
    expect(f.text).toContain('Swallowed by the old comment stripper.')
    expect(f.text).toContain('Visible after.')
    expect(f.text).not.toContain('real comment')
    expect(f.text).not.toContain('var x')
    expect(f.h1).toBe('Albert')
  })
  it('lets a quote of that sentence pass the same check the bot uses', () => {
    const row = { data: { first_sentence: '(14 March 1879) was a German-born theoretical physicist.' }, quotes: { first_sentence: '(14 March 1879) was a German-born theoretical physicist.' } }
    expect(fieldProblem('first_sentence', row.data.first_sentence, row.quotes.first_sentence, f)).toBeNull()
  })
})

describe('the rules extractor', () => {
  const row =ruleExtract(fields('title\ndescription\nh1\nemails\nphones\nprices\nauthor'), facts)
  it('fills the built-in fields with quotes and leaves other fields alone', () => {
    expect(row.data.title).toBe('Acme Widget — Pro | Acme Store')
    expect(row.data.h1).toBe('Acme Widget Pro')
    expect(row.data.description).toBe('The Acme Widget Pro: built for teams that ship.')
    expect(row.data.emails).toEqual(['sales@acme.test', 'support@acme.test'])
    expect(row.data.phones).toEqual(['+1 (555) 010-0199', '020 7946 0958']) // the tel: link is the same number as the first, so it is not listed twice
    expect(row.data.prices).toEqual(['$1,299.00', '€49'])
    expect('author' in row.data).toBe(false)
  })
  it('every value it produces passes the platform rule, and the date and the IP address are not phone numbers', () => {
    const check = checkRow({ data: { ...row.data, author: null }, quotes: { ...row.quotes, author: null } }, fields('title\ndescription\nh1\nemails\nphones\nprices\nauthor'), facts)
    expect(check.problems).toEqual([])
    expect(check.ok).toBe(true)
    expect(check.filled).toEqual(['title', 'description', 'h1', 'emails', 'phones', 'prices'])
    expect(JSON.stringify(row.data.phones)).not.toMatch(/2026|10\.0\.0/)
  })
})

describe('fieldProblem and checkRow', () => {
  const ok = (name: string, value: unknown, quote: unknown) => expect(fieldProblem(name, value, quote, facts)).toBeNull()
  const bad = (name: string, value: unknown, quote: unknown, why: RegExp) => expect(fieldProblem(name, value, quote, facts)).toMatch(why)

  it('accepts a value whose quote is on the page and which sits inside the quote', () => {
    ok('author', 'Maya Okafor', 'Author: Maya Okafor')
    ok('plan_name', 'Pro Annual', 'plan name: PRO   annual') // case and spacing do not matter
    ok('rating', 'best widget ever', 'Rating: "best widget ever" said Maya\'s review.') // curly and straight quotes are the same
    ok('price_year', '$1299.00', 'Our Pro plan costs $1,299.00 per year') // thousands commas are the same
    ok('year', 2026, 'Released 2026-10-20 on server') // numbers compare as text, inside a quote that holds them
    ok('author', null, undefined)
    ok('author', '', undefined)
    ok('author', [], undefined)
  })
  it('rejects what is not on the page, however it is dressed up', () => {
    bad('author', 'Someone Else', 'Author: Someone Else', /quote that is not on the page/)
    bad('author', 'Maya Okafor', 'Written by Maya Okafor', /quote that is not on the page/)
    bad('author', 'Okafor Maya', 'Author: Maya Okafor', /not inside its own quote/)
    bad('author', 'Maya Okafor', undefined, /no source quote/)
    bad('author', 'Maya Okafor', '   ', /no source quote/)
    bad('author', 'Maya Okafor', 12, /no source quote/)
    bad('author', { a: 1 }, 'Author: Maya Okafor', /not text or a number/)
    bad('author', 'M', 'Author: Maya Okafor', /too short/)
    bad('secret', '$999999', 'Price: $999999', /quote that is not on the page/) // inside a <script>
    bad('secret', '$5', 'hidden: $5', /quote that is not on the page/) // inside a comment
    bad('author', 'x'.repeat(301), 'x'.repeat(301), /longer than 300/)
    bad('author', 'Maya Okafor', 'Author: Maya Okafor ' + 'y'.repeat(400), /quote longer than 400/)
    bad('emails', ['sales@acme.test', 'support@acme.test'], 'sales@acme.test', /one quote per value/)
  })
  it('gives the built-in fields their shape: the right title, a real email, a phone, a price', () => {
    ok('title', 'Acme Widget Pro', 'Acme Widget Pro') // og:title and h1 are also titles
    bad('title', 'Our Pro plan costs', 'Our Pro plan costs $1,299.00 per year', /not the page title/)
    bad('h1', 'Acme Widget', 'Acme Widget Pro', /not the first <h1>/)
    bad('description', 'built for teams that ship', 'The Acme Widget Pro: built for teams that ship.', /not the page description/)
    ok('emails', ['sales@acme.test'], ['sales@acme.test'])
    bad('emails', ['our sales team'], ['our sales team'], /not an email address/)
    bad('phones', ['Released 2026'], ['Released 2026-10-20 on server'], /not a phone number/)
    ok('phones', ['020 7946 0958'], ['call +1 (555) 010-0199 or 020 7946 0958.'])
    bad('prices', ['per year'], ['per year'], /not a price/)
    ok('prices', ['$1,299.00'], ['Our Pro plan costs $1,299.00 per year'])
  })
  it('a row needs at least half of the requested fields, only requested fields, and no bad value', () => {
    const fs = fields('title\nauthor\nplan_name\nrating')
    expect(minFilled(fs)).toBe(2)
    expect(minFilled(fields('title'))).toBe(1)
    const good = { data: { title: 'Acme Widget Pro', author: 'Maya Okafor', plan_name: null, rating: null }, quotes: { title: 'Acme Widget Pro', author: 'Author: Maya Okafor', plan_name: null, rating: null } }
    expect(checkRow(good, fs, facts)).toMatchObject({ ok: true, filled: ['title', 'author'] })
    expect(checkRow({ data: { title: 'Acme Widget Pro' }, quotes: { title: 'Acme Widget Pro' } }, fs, facts)).toMatchObject({ ok: false, problems: [expect.stringContaining('only 1 of 4 fields')] })
    expect(checkRow({ data: { title: null, author: null }, quotes: {} }, fs, facts).ok).toBe(false) // all null is not a page
    expect(checkRow({ ...good, data: { ...good.data, extra: 'x' } }, fs, facts).problems).toEqual(['"extra" is not a requested field'])
    expect(checkRow({ ...good, data: { ...good.data, rating: 'five stars' }, quotes: { ...good.quotes, rating: 'five stars' } }, fs, facts).problems).toEqual(['rating has a quote that is not on the page'])
    expect(checkRow(null, fs, facts).ok).toBe(false)
    expect(checkRow({ data: [] }, fs, facts).ok).toBe(false)
  })
})

// ---------- the platform check ----------

let server: http.Server
let origin = ''
const hits: string[] = []
let flaky = 0
const free = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    hits.push(u.pathname)
    const send = (code: number, body = '', type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) => (res.writeHead(code, { 'content-type': type, ...extra }), res.end(body))
    if (u.pathname === '/page') return send(200, PAGE)
    if (u.pathname === '/gone') return send(404, 'gone')
    if (u.pathname === '/json') return send(200, '{"title":"x"}', 'application/json')
    if (u.pathname === '/busy') return send(503, 'busy', 'text/html', { 'retry-after': '0' })
    if (u.pathname === '/flaky') return flaky++ === 0 ? send(503, 'busy', 'text/html', { 'retry-after': '0' }) : send(200, PAGE)
    send(404, 'nope')
  })
  const port = await free()
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  origin = `http://127.0.0.1:${port}`
})
afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

const FIELDS = 'title\nauthor\nplan_name'
const goodRow = () => ({ data: { title: 'Acme Widget Pro', author: 'Maya Okafor', plan_name: null }, quotes: { title: 'Acme Widget Pro', author: 'Author: Maya Okafor', plan_name: null } })

async function runCheck(meta: Record<string, unknown>, o: { attempt?: number; urls?: string; fields?: string; url?: string } = {}) {
  const lib = createCheckLibrary()
  registerHouseBotChecks(lib, { allowHosts: [origin.replace('http://', '')] })
  const url = o.url ?? `${origin}/page`
  const unit = { ref: 'page-1', url: String(meta.url ?? url), artifact_ids: [], meta: { url, ...meta } } as Delivery['deliverables'][number]['units'][number]
  const ctx = { job_id: 'job_x', contract: { inputs: { urls: o.urls ?? `${origin}/page\n${origin}/gone\n${origin}/busy\n${origin}/flaky\n${origin}/json`, fields: o.fields ?? FIELDS } } as never, deliverable_id: 'D1', unit, test: { check: 'page_extraction_verified', params: {} }, attempt: o.attempt ?? 1, artifact: async () => null, saveEvidence: async () => 'ev_1' } as CheckContext
  return lib.get('page_extraction_verified')!.run(ctx)
}

describe('page_extraction_verified', () => {
  it('passes a row whose values the platform finds on the page it fetched itself', async () => {
    const r = await runCheck(goodRow())
    expect(r).toMatchObject({ status: 'pass', detail: expect.stringContaining('2 of 3 fields verified') })
    expect(hits).toContain('/page')
  })
  it('fails a value that is not on the page, a quote that is not on the page, a value outside its quote, and an unrequested field', async () => {
    const row = goodRow()
    expect(await runCheck({ ...row, data: { ...row.data, author: 'Someone Else' }, quotes: { ...row.quotes, author: 'Author: Someone Else' } })).toMatchObject({ status: 'fail', detail: expect.stringContaining('quote that is not on the page') })
    expect(await runCheck({ ...row, data: { ...row.data, author: 'Okafor' }, quotes: { ...row.quotes, author: 'Author: Maya Okafor' } })).toMatchObject({ status: 'pass' }) // inside its quote, and the quote is real
    expect(await runCheck({ ...row, data: { ...row.data, author: 'Maya' }, quotes: { ...row.quotes, author: 'Plan name: Pro Annual' } })).toMatchObject({ status: 'fail', detail: expect.stringContaining('not inside its own quote') })
    expect(await runCheck({ ...row, data: { ...row.data, secret: 'x1' } })).toMatchObject({ status: 'fail', detail: expect.stringContaining('not a requested field') })
    expect(await runCheck({ data: { title: 'Wrong title', author: null, plan_name: null }, quotes: { title: 'Wrong title' } })).toMatchObject({ status: 'fail' })
  })
  it('fails an almost empty row (no free pay for all-null pages)', async () => {
    expect(await runCheck({ data: { title: null, author: null, plan_name: null }, quotes: {} })).toMatchObject({ status: 'fail', detail: expect.stringContaining('only 0 of 3 fields') })
    expect(await runCheck({ data: { title: 'Acme Widget Pro' }, quotes: { title: 'Acme Widget Pro' } })).toMatchObject({ status: 'fail', detail: expect.stringContaining('only 1 of 3 fields') })
  })
  it('only checks pages named in the contract', async () => {
    expect(await runCheck(goodRow(), { url: `${origin}/other`, })).toMatchObject({ status: 'fail', detail: expect.stringContaining("not one of the contract's urls") })
    expect(await runCheck({ ...goodRow(), url: 'file:///etc/passwd' })).toMatchObject({ status: 'fail', detail: expect.stringContaining('not an http(s) URL') })
    expect(await runCheck(goodRow(), { urls: '', fields: FIELDS })).toMatchObject({ status: 'fail' })
  })
  it('a page that is gone or not a web page fails; one that is busy is pending, then fails on the second look, and a blip is retried within the check', async () => {
    expect(await runCheck(goodRow(), { url: `${origin}/gone` })).toMatchObject({ status: 'fail', detail: expect.stringContaining('HTTP 404') })
    expect(await runCheck(goodRow(), { url: `${origin}/json` })).toMatchObject({ status: 'fail', detail: expect.stringContaining('not a web page') })
    expect(await runCheck(goodRow(), { url: `${origin}/busy` })).toMatchObject({ status: 'pending' })
    expect(await runCheck(goodRow(), { url: `${origin}/busy`, attempt: 2 })).toMatchObject({ status: 'fail', detail: expect.stringContaining('still after a second look') })
    flaky = 0
    expect(await runCheck(goodRow(), { url: `${origin}/flaky` })).toMatchObject({ status: 'pass' }) // the 503 is retried inside the check
  }, 30_000)
  it('the check is registered with the house-bot checks, per unit and delayed', () => {
    const lib = createCheckLibrary()
    registerHouseBotChecks(lib, {})
    expect(lib.get('page_extraction_verified')!.def).toMatchObject({ per_unit: true, delayed: true })
  })
})
