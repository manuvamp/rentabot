// End to end on the REAL core (simulated PayPal rail), wired like server/src/index.ts: a buyer agent hires the web bots (Deliverability
// Doctor, Broken Link Hunter, Web Data Extractor, Uptime Watch) over the public MCP endpoint; the bots negotiate, work, deliver; the
// platform's own checks decide what is paid. DNS is scripted (two separate scripts: the bot's and the platform's, so a lie shows).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHouseBots } from '../src/index.ts'
import { memoryLogger } from '../src/log.ts'
import { NO_AI, sleep, startSite } from './helpers.ts'
import { createCore, type CoreImpl } from '../../server/src/core/index.ts'
import { buildApp } from '../../server/src/http/app.ts'
import { registerHouseBotChecks } from '../../server/src/housebots/checks.ts'
import { createIntelligence } from '../../server/src/intelligence/index.ts'
import { registerSandbox } from '../../server/src/sandbox/index.ts'
import { fakeDns, goodZone, messyZone, type Zone } from '../../server/test/housebots/fake-dns.ts'
import { LINKSITE_PATH } from '../../server/src/sandbox/linksite.ts'

type J = any // eslint-disable-line @typescript-eslint/no-explicit-any

let dataDir: string
let base: string
let core: CoreImpl
let app: Awaited<ReturnType<typeof buildApp>>
let stopBots: () => Promise<void>
let buyer: Client
const clients: Client[] = []
const log = memoryLogger()
let operatorKey = ''
let cleanSite: Awaited<ReturnType<typeof startSite>>
let shopSite: Awaited<ReturnType<typeof startSite>>
const MAIL = ['good-mail.com', 'messy-mail.com', 'third-mail.com', 'fourth-mail.com', 'fifth-mail.com', 'sixth-mail.com']
const botZone: Zone = {}
const platformZone: Zone = {}

async function freePort() {
  return new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}
async function mcp(key: string): Promise<Client> {
  const c = new McpClient({ name: 'e2e-webbots', version: '0' }, { capabilities: {} })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?toolsets=buyer`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
  clients.push(c)
  return c
}
async function callRaw(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: J; text: string }> {
  const res = await c.callTool({ name, arguments: args })
  const text = (res.content as { text: string }[])[0]!.text
  return { ok: !res.isError, data: res.isError ? null : (res.structuredContent ?? JSON.parse(text.slice(text.indexOf('\n') + 1))), text }
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<J> => {
  const r = await callRaw(c, name, args)
  if (!r.ok) throw new Error(`${name}: ${r.text}`)
  return r.data
}
async function until<T>(fn: () => Promise<T | null | false | undefined>, ms = 30_000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await sleep(60)
  }
}

/** Send inputs, wait for the bot to sign the new hash, and accept it as the buyer. */
async function inputsAndAccept(job: string, inputs: Record<string, unknown>) {
  await call(buyer, 'provide_inputs', { job_id: job, inputs })
  const signed = await until(async () => {
    const j = await call(buyer, 'get_job', { job_id: job })
    return j.job.accepted_by.some((x: J) => x.role === 'seller' && x.contract_hash === j.job.contract_hash) ? j : null
  }, 30_000, 'the bot signing the contract')
  await call(buyer, 'accept_contract', { job_id: job, contract_hash: signed.job.contract_hash })
}

async function newJob(botName: string, skill: string, goal: string, quantity: number, budget: string, context = '', tweak?: (spec: J) => void): Promise<string> {
  const bot = ((await call(buyer, 'search_bots', { query: botName })).bots as { id: string; name: string }[]).find((b) => b.name === botName)
  if (!bot) throw new Error(`${botName} not listed`)
  const draft = await call(buyer, 'draft_job_spec', { bot_id: bot.id, skill_id: skill, goal, quantity, budget_cap: budget, context })
  tweak?.(draft.spec)
  return (await call(buyer, 'create_job', { bot_id: bot.id, spec: draft.spec, idempotency_key: `e2e-webbots-${skill}-${Date.now()}-${Math.random()}` })).job.id
}

/** Fund, wait for DELIVERED and return the job. */
async function fundAndDeliver(job: string, ms = 60_000) {
  expect((await call(buyer, 'fund_job', { job_id: job, idempotency_key: `e2e-fund-${job}` })).job.state).toBe('IN_PROGRESS')
  return until(async () => {
    const x = await call(buyer, 'get_job', { job_id: job })
    return x.job.state === 'DELIVERED' ? x : null
  }, ms, 'delivery')
}
const deliveryOf = async (job: string) => ((await call(buyer, 'get_messages', { job_id: job })).messages as J[]).find((m) => m.type === 'delivery')!.body.delivery
async function acceptAndSettle(job: string) {
  await call(buyer, 'review_delivery', { job_id: job, decision: 'accept' })
  await core.internal.drain()
  return (await call(buyer, 'get_escrow', { job_id: job })).escrow
}

beforeAll(async () => {
  for (const d of MAIL) Object.assign(botZone, d === 'messy-mail.com' ? messyZone(d) : goodZone(d))
  Object.assign(platformZone, structuredClone(botZone))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-webbots-'))
  // A tiny clean site (no broken links) for the report-only case.
  cleanSite = await startSite((u) => (u.pathname === '/robots.txt' ? [404, ''] : u.pathname === '/' ? [200, '<h1>Clean</h1><a href="/a">Page A</a> <a href="/b">Page B</a>'] : [200, '<h1>Page</h1><a href="/">Home</a>']))
  // A shop with product pages for the Web Data Extractor.
  shopSite = await startSite((u) => {
    const m = u.pathname.match(/^\/p\/(\d+)$/)
    if (u.pathname === '/robots.txt') return [404, '']
    if (!m) return [404, 'gone']
    const n = m[1]
    return [200, `<!doctype html><html><head><title>Widget ${n} | Shop</title><meta name="description" content="Widget ${n} for testing."></head><body><h1>Widget ${n}</h1><p>Only $${n}.99 today.</p><a href="mailto:shop${n}@shop.test">Email us</a></body></html>`]
  })
  const allow = [`127.0.0.1:${port}`, cleanSite.host, shopSite.host]
  const intelligence = await createIntelligence({ publicUrl: base, allowHosts: [], env: {} })
  registerHouseBotChecks(intelligence.checks, { allowHosts: allow, dns: fakeDns(platformZone) })
  core = await createCore({
    intelligence,
    config: { dataDir, tickMs: 0, demoMode: false, rail: 'simulated', sealKey: 'c'.repeat(64), publicUrl: base, paypal: { clientId: '', clientSecret: '', webhookId: '', env: 'sandbox' } },
    dbFile: ':memory:',
  })
  app = await buildApp(core, { logger: false })
  await registerSandbox(app, { checks: intelligence.checks, publicUrl: base, dataDir, timeScale: 0.002 })
  await app.listen({ port, host: '127.0.0.1' })
  const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'demo-keys.json'), 'utf8'))
  operatorKey = keys.glob_studio_bots.api_key
  buyer = await mcp(keys.orano_growth_agent.api_key)
  stopBots = await startHouseBots({ url: base, keys: { glob_studio_bots: operatorKey }, ai: NO_AI, log, pollSeconds: 1, allowHosts: allow, dns: fakeDns(botZone), brokenLinkHunter: { retryDelayMs: 0 }, only: ['deliverability-doctor', 'broken-link-hunter', 'web-data-extractor'] })
}, 60_000)

afterAll(async () => {
  await stopBots?.()
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
  await app?.close()
  await core?.close()
  await cleanSite?.close()
  await shopSite?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('Deliverability Doctor on the real core', () => {
  it('audits six domains; the platform re-resolves every claim; the $7.50 job settles in full', async () => {
    const job = await newJob('Deliverability Doctor', 'deliverability_audit', 'Audit the mail setup of our six domains and give me the DNS records to fix SPF, DMARC and DKIM.', 6, '7.50')
    const quoted = await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    expect(quoted.total_max.value).toBe('7.50')
    expect(quoted.excludes).toEqual([])
    await inputsAndAccept(job, { domains: MAIL.join('\n'), dkim_selectors: 'selector1' })
    const j = await fundAndDeliver(job)
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 6, passed_units: 6, failed_units: 0 })
    const delivery = await deliveryOf(job)
    const messy = delivery.deliverables[0].units.find((u: J) => u.ref === 'messy-mail.com')
    expect(messy.meta.fixes.map((f: J) => f.name)).toEqual(expect.arrayContaining(['_dmarc.messy-mail.com', 'messy-mail.com']))
    expect((await acceptAndSettle(job)).captured.value).toBe('7.50')
  }, 90_000)

  it('a unit whose claim the platform cannot reproduce is not paid, and the rest still settle', async () => {
    // The bot sees one DMARC record; the platform's DNS has another for that domain: the bot "lied" as far as the platform can tell.
    botZone['_dmarc.third-mail.com'] = { TXT: ['v=DMARC1; p=none'] }
    try {
      const job = await newJob('Deliverability Doctor', 'deliverability_audit', 'Audit the mail setup of our six domains and give me the DNS records to fix SPF, DMARC and DKIM.', 6, '7.50')
      await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
      await inputsAndAccept(job, { domains: MAIL.join('\n') })
      const j = await fundAndDeliver(job)
      expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 6, passed_units: 5, failed_units: 1 })
      const checks = (await call(buyer, 'run_checks', { job_id: job })).checks as J[]
      expect(checks.find((c) => c.unit_ref === 'third-mail.com' && c.check === 'dns_claims_hold')).toMatchObject({ status: 'fail', detail: expect.stringContaining('DMARC') })
      expect((await acceptAndSettle(job)).captured.value).toBe('6.25') // 5 x $1.25
    } finally {
      delete botZone['_dmarc.third-mail.com']
    }
  }, 90_000)

  it('refuses to change DNS for the buyer, and keeps the key out of the logs', async () => {
    const job = await newJob('Deliverability Doctor', 'deliverability_audit', 'Log in to my registrar and change the DNS records for me directly, six domains.', 6, '7.50')
    const declined = await until(async () => ((await call(buyer, 'get_messages', { job_id: job })).messages as J[]).find((m) => m.type === 'decline'), 30_000, 'the decline')
    expect(declined.text).toMatch(/only read DNS/)
    expect(JSON.stringify(log.entries)).not.toContain(operatorKey)
  }, 60_000)
})

/**
 * The two-deliverable shape the Broken Link Hunter quotes: D1 the broken links, D2 the crawl report. The Spec Copilot drafts it
 * itself now (the skill declares the report as a recommended extra), with the report's own check, so the buyer edits nothing.
 */
const withReport = (spec: J) => {
  expect(spec.deliverables.map((d: J) => d.id)).toEqual(['D1', 'D2'])
  expect(spec.deliverables[1]).toMatchObject({ quantity: 1, acceptance: [{ check: 'report_sections_present' }] })
}

describe('Broken Link Hunter on the real core', () => {
  it('crawls the Sandbox Web site; the platform re-fetches each source page and link; the links and the report are paid', async () => {
    const job = await newJob('Broken Link Hunter', 'broken_link_audit', 'Crawl our public documentation site and list every broken link with the page it is on.', 24, '12.00', '', withReport)
    const quoted = await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    expect(quoted.total_max.value).toBe('11.00') // 24 x $0.25 + the $5.00 report
    expect(quoted.lines.map((l: J) => [l.deliverable_id, l.model, l.max_total])).toEqual([['D1', 'per_unit', '6.00'], ['D2', 'fixed', '5.00']])
    await inputsAndAccept(job, { site_url: `${base}${LINKSITE_PATH}/` })
    const j = await fundAndDeliver(job, 120_000)
    expect(j.job.fulfilment.find((f: J) => f.deliverable_id === 'D1')).toMatchObject({ expected_units: 24, passed_units: 6 })
    const delivery = await deliveryOf(job)
    const links = delivery.deliverables.find((d: J) => d.deliverable_id === 'D1').units
    expect(links.map((u: J) => u.meta.anchor_text).sort()).toEqual(['Launch announcement', 'Legacy pricing', 'Meet the team', 'Old guide', 'Old guide', 'Support portal'])
    const checks = (await call(buyer, 'run_checks', { job_id: job })).checks as J[]
    expect(checks.filter((c) => c.check === 'broken_link_confirmed' && c.status === 'pass').length).toBe(6) // the six links    expect(checks.filter((c) => c.status === 'fail' || c.status === 'error')).toEqual([])
    expect((await acceptAndSettle(job)).captured.value).toBe('6.50') // 6 x $0.25 + $5.00
  }, 150_000)

  it('a clean site finds nothing, and the flat crawl report still settles at the $5.00 minimum', async () => {
    const job = await newJob('Broken Link Hunter', 'broken_link_audit', 'Crawl our public site and list every broken link with the page it is on.', 24, '12.00', '', withReport)
    await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    await inputsAndAccept(job, { site_url: `${cleanSite.origin}/`, check_external: false })
    await fundAndDeliver(job, 90_000)
    expect(cleanSite.hits.filter((h) => h.ua.includes('RentABotLinkChecker')).map((h) => h.path)).toEqual(['/robots.txt', '/', '/a', '/b']) // it announced itself, read robots.txt first and crawled the three pages
    expect((await acceptAndSettle(job)).captured.value).toBe('5.00')
  }, 120_000)

  it('declines a job that asks it to crawl behind a login, and keeps the key out of the logs', async () => {
    const job = await newJob('Broken Link Hunter', 'broken_link_audit', 'Log in to our members area with this password and list the broken links behind the login.', 24, '10.00')
    const declined = await until(async () => ((await call(buyer, 'get_messages', { job_id: job })).messages as J[]).find((m) => m.type === 'decline'), 30_000, 'the decline')
    expect(declined.text).toMatch(/only crawl public pages/)
    expect(JSON.stringify(log.entries)).not.toContain(operatorKey)
  }, 60_000)
})

describe('Web Data Extractor on the real core', () => {
  it('reads 30 pages (replacing two that are gone); the platform fetches each page and finds every quote; 30 x $0.20 settles', async () => {
    const job = await newJob('Web Data Extractor', 'web_extraction', 'Extract the title, h1, price and contact email from each product page in my list.', 30, '10.00')
    const quoted = await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    expect(quoted.total_max.value).toBe('6.00')
    expect(quoted.excludes).toEqual([])
    const list = [`${shopSite.origin}/gone/1`, `${shopSite.origin}/gone/2`, ...Array.from({ length: 30 }, (_, i) => `${shopSite.origin}/p/${i + 1}`)].join('\n')
    await inputsAndAccept(job, { urls: list, fields: 'title\nh1\nprices\nemails' })
    const j = await fundAndDeliver(job, 150_000)
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 30, passed_units: 30, failed_units: 0 })
    const delivery = await deliveryOf(job)
    const units = delivery.deliverables[0].units
    expect(units).toHaveLength(30)
    expect(units[0].meta.data).toMatchObject({ title: 'Widget 1 | Shop', h1: 'Widget 1', prices: ['$1.99'], emails: ['shop1@shop.test'] })
    expect(units[0].meta.quotes.emails).toEqual(['shop1@shop.test'])
    expect(shopSite.hits.filter((h) => h.ua.includes('RentABotExtractor')).map((h) => h.path)[0]).toBe('/robots.txt')
    const checks = (await call(buyer, 'run_checks', { job_id: job })).checks as J[]
    expect(checks.filter((c) => c.check === 'page_extraction_verified' && c.status === 'pass')).toHaveLength(30)
    expect((await acceptAndSettle(job)).captured.value).toBe('6.00')
  }, 200_000)

  it('declines a job that needs a login, and keeps the key out of the logs', async () => {
    const job = await newJob('Web Data Extractor', 'web_extraction', 'Log in to our members portal with my password and extract the invoice titles behind the login.', 30, '10.00')
    const declined = await until(async () => ((await call(buyer, 'get_messages', { job_id: job })).messages as J[]).find((m) => m.type === 'decline'), 30_000, 'the decline')
    expect(declined.text).toMatch(/only read public pages/)
    expect(JSON.stringify(log.entries)).not.toContain(operatorKey)
  }, 60_000)
})
