// Link extraction, the definition of "broken", the Sandbox Web link-check site, and the platform's broken_link_confirmed check run against it.
import http from 'node:http'
import net from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Delivery } from '@rentabot/shared'
import type { CheckContext } from '../../src/intelligence/types.ts'
import { createCheckLibrary } from '../../src/intelligence/checks/library.ts'
import { registerHouseBotChecks } from '../../src/housebots/checks.ts'
import { canonicalUrl, classifyError, classifyStatus, extractLinks, isPage } from '../../src/housebots/link-logic.ts'
import { KNOWN_BROKEN, LINKSITE_PATH, registerLinkSite } from '../../src/sandbox/linksite.ts'

describe('extractLinks', () => {
  const page = 'https://site.test/docs/index.html'
  it('finds anchors in document order, resolved against the page, without fragments, mailto, tel, javascript or comments', () => {
    const html = `<!-- <a href="/commented">x</a> --><script>var a = '<a href="/in-script">x</a>'</script>
      <a href="/abs?x=1&amp;y=2#frag">Absolute &amp; <b>bold</b></a> <a href='rel.html'>Relative</a> <a href=bare>Bare</a>
      <a href="mailto:a@b.com">mail</a> <a href="tel:1">tel</a> <a href="javascript:void(0)">js</a> <a href="#top">top</a> <a href="">empty</a>
      <a href="https://other.test/x">Other</a> <a name="no-href">none</a> <a href="ftp://f.test/x">ftp</a> <a href="//cdn.test/p">proto relative</a>
      <a href="/img"><img src="a.png" alt="Logo here"></a> <a href="/aria" aria-label="Labelled"></a>`
    expect(extractLinks(html, page)).toEqual([
      { url: 'https://site.test/abs?x=1&y=2', text: 'Absolute & bold' },
      { url: 'https://site.test/docs/rel.html', text: 'Relative' },
      { url: 'https://site.test/docs/bare', text: 'Bare' },
      { url: 'https://other.test/x', text: 'Other' },
      { url: 'https://cdn.test/p', text: 'proto relative' },
      { url: 'https://site.test/img', text: '[image] Logo here' },
      { url: 'https://site.test/aria', text: 'Labelled' },
    ])
  })
  it("ignores Cloudflare's obfuscated mailto: links (/cdn-cgi/l/email-protection), which 404 on a plain GET", () => {
    const html = `<a href="/cdn-cgi/l/email-protection#9fe1f0f2fff6fdb1">Email us</a><span class="__cf_email__"><a href="https://site.test/cdn-cgi/l/email-protection#abc">e</a></span><a href="/real">Real</a>`
    expect(extractLinks(html, page)).toEqual([{ url: 'https://site.test/real', text: 'Real' }])
  })
  it('honours <base href> and clips long anchor text', () => {
    expect(extractLinks('<base href="https://cdn.test/v2/"><a href="a">A</a>', page)).toEqual([{ url: 'https://cdn.test/v2/a', text: 'A' }])
    expect(extractLinks(`<a href="/x">${'long '.repeat(60)}</a>`, page)[0]!.text).toHaveLength(120)
    expect(canonicalUrl('HTTPS://Site.TEST:443/a#b')).toBe('https://site.test/a')
    expect(canonicalUrl('mailto:x@y.z')).toBeNull()
    expect(isPage('https://s.test/a/b')).toBe(true)
    expect(isPage('https://s.test/a/report.pdf?x=1')).toBe(false)
  })
})

describe('what counts as broken', () => {
  it('judges the final status', () => {
    for (const s of [200, 204, 301, 302, 399]) expect(classifyStatus(s).verdict).toBe('ok')
    for (const s of [400, 404, 410]) expect(classifyStatus(s).verdict).toBe('broken')
    for (const s of [401, 403, 405, 429, 451, 999]) expect(classifyStatus(s).verdict).toBe('restricted')
    for (const s of [500, 502, 503, 504]) expect(classifyStatus(s).verdict).toBe('server_error')
    expect(classifyStatus(408).verdict).toBe('transient')
  })
  it('judges network failures by their code', () => {
    const e = (code: string, message = 'fetch failed') => Object.assign(new Error(message), { code })
    expect(classifyError(e('ENOTFOUND'))).toMatchObject({ verdict: 'broken', kind: 'dns' })
    expect(classifyError(e('EAI_AGAIN'))).toMatchObject({ verdict: 'transient' })
    expect(classifyError(e('ECONNREFUSED'))).toMatchObject({ verdict: 'server_error' })
    expect(classifyError(e('CERT_HAS_EXPIRED', 'certificate has expired'))).toMatchObject({ verdict: 'broken', kind: 'tls' })
    expect(classifyError(new Error('more than 3 redirects'))).toMatchObject({ verdict: 'broken', kind: 'redirects' })
    expect(classifyError(new Error('timed out'))).toMatchObject({ verdict: 'transient', kind: 'timeout' })
    expect(classifyError(new Error('host 10.0.0.1 is not public'))).toMatchObject({ verdict: 'restricted', kind: 'blocked' })
    expect(classifyError(new Error('socket hang up'))).toMatchObject({ verdict: 'transient' })
  })
})

// ---------- the Sandbox Web site and the check ----------

let origin = ''
let host = ''
let app: ReturnType<typeof Fastify>
let fixture: http.Server
let fixtureOrigin = ''
const free = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })

beforeAll(async () => {
  const port = await free()
  origin = `http://127.0.0.1:${port}`
  host = `127.0.0.1:${port}`
  app = Fastify()
  await app.register(async (sb: FastifyInstance) => registerLinkSite(sb), { prefix: '/sandbox' })
  await app.listen({ port, host: '127.0.0.1' })
  // A second site for the cases the sandbox site does not have: login walls, a link that works now, a page without the link.
  fixture = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const send = (code: number, body = '', type = 'text/html') => (res.writeHead(code, { 'content-type': type }), res.end(body))
    if (u.pathname === '/source') return send(200, '<a href="/ok">Fine page</a> <a href="/walled">Members only</a> <a href="/gone">Gone page</a> <a href="/ratelimited">Busy page</a> <a href="/loop">Looping page</a>')
    if (u.pathname === '/ok') return send(200, 'ok')
    if (u.pathname === '/walled') return send(403, 'login')
    if (u.pathname === '/ratelimited') return send(429, 'slow down')
    if (u.pathname === '/gone') return send(404, 'gone')
    if (u.pathname === '/loop') return (res.writeHead(302, { location: '/loop' }), res.end())
    if (u.pathname === '/nolinks') return send(200, '<p>no links here</p>')
    send(404, 'nope')
  })
  const p2 = await free()
  await new Promise<void>((r) => fixture.listen(p2, '127.0.0.1', r))
  fixtureOrigin = `http://127.0.0.1:${p2}`
})
afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => (fixture ? fixture.close(() => r()) : r()))
})

const site = () => `${origin}${LINKSITE_PATH}`

async function runCheck(meta: Record<string, unknown>, opts: { attempt?: number; siteUrl?: string; url?: string; allow?: string[] } = {}) {
  const lib = createCheckLibrary()
  registerHouseBotChecks(lib, { allowHosts: opts.allow ?? [host, fixtureOrigin.replace('http://', '')] })
  const unit = { ref: 'link-1', url: opts.url ?? String(meta.link_url ?? ''), artifact_ids: [], meta } as Delivery['deliverables'][number]['units'][number]
  const ctx = { job_id: 'job_x', contract: { inputs: { site_url: opts.siteUrl ?? `${site()}/` } } as never, deliverable_id: 'D1', unit, test: { check: 'broken_link_confirmed', params: {} }, attempt: opts.attempt ?? 1, artifact: async () => null, saveEvidence: async () => 'ev_1' } as CheckContext
  return lib.get('broken_link_confirmed')!.run(ctx)
}
const unitOf = (b: (typeof KNOWN_BROKEN)[number]) => ({ source_page: `${site()}${b.source}`, link_url: `${site()}${b.target}`, anchor_text: b.text, status: b.status })

describe('the Sandbox Web link-check site', () => {
  it('serves the answer key, and its links behave as described', async () => {
    const j = (await fetch(`${origin}${LINKSITE_PATH.replace('/site', '')}/site.json`).then((r) => r.json())) as { known_broken: unknown[] }
    expect(j.known_broken).toHaveLength(KNOWN_BROKEN.length)
    expect((await fetch(`${site()}/pricing-v1`, { redirect: 'manual' })).status).toBe(301)
    expect((await fetch(`${site()}/blog/launch-2019`)).status).toBe(410)
    expect((await fetch(`${site()}/files/brochure.pdf`, { method: 'HEAD' })).status).toBe(405)
    expect((await fetch(`${site()}/files/brochure.pdf`)).status).toBe(200)
    expect((await fetch(`${site()}/docs`, { redirect: 'manual' })).status).toBe(301)
  })
})

describe('broken_link_confirmed', () => {
  it('passes every broken link of the site: the link is on the source page, with its anchor text, and is still broken', async () => {
    for (const b of KNOWN_BROKEN) {
      const r = await runCheck(unitOf(b))
      expect(r, `${b.source} -> ${b.target}`).toMatchObject({ status: 'pass' })
    }
  })

  it('a persistent server error passes when the unit claims it too; claimed as something else it is pending, then counts on the second look', async () => {
    const b = KNOWN_BROKEN.find((x) => x.status === 500)!
    expect(await runCheck(unitOf(b), { attempt: 1 })).toMatchObject({ status: 'pass' })
    const other = { ...unitOf(b), status: 404 }
    expect(await runCheck(other, { attempt: 1 })).toMatchObject({ status: 'pending' })
    expect(await runCheck(other, { attempt: 2 })).toMatchObject({ status: 'pass' })
  })

  it('fails a link that works, a link that is not on the source page, and the wrong anchor text', async () => {
    const works = { source_page: `${site()}/docs/`, link_url: `${site()}/docs/api`, anchor_text: 'API reference', status: 404 }
    expect(await runCheck(works)).toMatchObject({ status: 'fail', detail: expect.stringContaining('works now') })
    const notThere = { source_page: `${site()}/blog/`, link_url: `${site()}/docs/old-guide`, anchor_text: 'Old guide', status: 404 }
    expect(await runCheck(notThere)).toMatchObject({ status: 'fail', detail: expect.stringContaining('not on the source page') })
    const wrongText = { ...unitOf(KNOWN_BROKEN[1]!), anchor_text: 'Totally different words' }
    expect(await runCheck(wrongText)).toMatchObject({ status: 'fail', detail: expect.stringContaining('anchor text') })
    // spacing and case do not matter
    expect((await runCheck({ ...unitOf(KNOWN_BROKEN[1]!), anchor_text: '  MEET   the team ' })).status).toBe('pass')
    // a source page that is itself gone cannot serve the link
    expect(await runCheck({ source_page: `${site()}/team`, link_url: `${site()}/docs/old-guide`, anchor_text: 'x' })).toMatchObject({ status: 'fail', detail: expect.stringContaining('no longer serves') })
  })

  it('does not call a login wall, a rate limit or a working redirect broken, and treats a redirect loop as broken', async () => {
    const f = fixtureOrigin
    const one = (path: string, text: string) => ({ source_page: `${f}/source`, link_url: `${f}${path}`, anchor_text: text })
    const opts = { siteUrl: `${f}/source` }
    expect(await runCheck(one('/walled', 'Members only'), opts)).toMatchObject({ status: 'fail', detail: expect.stringContaining('not a broken link') })
    expect(await runCheck(one('/ratelimited', 'Busy page'), opts)).toMatchObject({ status: 'fail', detail: expect.stringContaining('429') })
    expect(await runCheck(one('/ok', 'Fine page'), opts)).toMatchObject({ status: 'fail' })
    expect(await runCheck(one('/gone', 'Gone page'), opts)).toMatchObject({ status: 'pass' })
    expect(await runCheck(one('/loop', 'Looping page'), opts)).toMatchObject({ status: 'pass', detail: expect.stringContaining('redirect') })
  })

  it('binds the unit to the contract: a source page on another site, a bad URL, no site input', async () => {
    const f = fixtureOrigin
    expect(await runCheck({ source_page: `${f}/source`, link_url: `${f}/gone`, anchor_text: 'Gone page' })).toMatchObject({ status: 'fail', detail: expect.stringContaining("not on the contract's site") })
    expect(await runCheck({ source_page: 'nope', link_url: `${site()}/team` })).toMatchObject({ status: 'fail' })
    expect(await runCheck({ source_page: `${site()}/about`, link_url: '' }, { url: '' })).toMatchObject({ status: 'fail' })
    expect(await runCheck(unitOf(KNOWN_BROKEN[1]!), { siteUrl: 'not a url' })).toMatchObject({ status: 'fail', detail: expect.stringContaining('site_url') })
    // the SSRF guard applies: a private address that is not allow-listed is refused, never fetched
    expect(await runCheck({ source_page: 'http://169.254.169.254/latest', link_url: 'http://169.254.169.254/x' }, { siteUrl: 'http://169.254.169.254/', allow: [] })).toMatchObject({ status: 'fail' })
  })

  it('checks a crawl report by re-fetching the pages it says it crawled', async () => {
    const report = (sample: string[]) => ({ kind: 'crawl_report', start_url: `${site()}/`, pages_sample: sample, pages_crawled: sample.length })
    expect(await runCheck(report([`${site()}/`, `${site()}/about`, `${site()}/docs/`]), { url: `${site()}/` })).toMatchObject({ status: 'pass' })
    expect(await runCheck(report([`${site()}/`, `${site()}/team`]), { url: `${site()}/` })).toMatchObject({ status: 'fail', detail: expect.stringContaining('does not answer') })
    expect(await runCheck(report([]), { url: `${site()}/` })).toMatchObject({ status: 'fail' })
    expect(await runCheck(report([`${fixtureOrigin}/ok`]), { url: `${site()}/` })).toMatchObject({ status: 'fail', detail: expect.stringContaining('outside') })
    expect(await runCheck({ kind: 'crawl_report', start_url: `${fixtureOrigin}/ok`, pages_sample: [`${fixtureOrigin}/ok`] })).toMatchObject({ status: 'fail' })
  })
})
