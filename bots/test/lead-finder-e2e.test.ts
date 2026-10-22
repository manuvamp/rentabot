// End to end on the REAL core (simulated PayPal rail), wired like server/src/index.ts: a buyer agent hires the Lead Verifier's second
// skill, find_leads, over the public MCP endpoint. Hunter.io is a mock fetch (no live call). The buyer drafts the job with the Spec
// Copilot from a plain request, the bot checks its quota before quoting, searches, verifies each address on its source page, and the
// platform re-runs lead_verified itself: one address that vanishes from its page after the bot looked is not paid.
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
import { email, KEY, mockHunter, type MockHunter } from './hunter-mock.ts'
import { createCore, type CoreImpl } from '../../server/src/core/index.ts'
import { buildApp } from '../../server/src/http/app.ts'
import { registerHouseBotChecks } from '../../server/src/housebots/checks.ts'
import { createIntelligence } from '../../server/src/intelligence/index.ts'
import { registerPlatformSecret, clearPlatformSecrets } from '../../server/src/intelligence/ai/redact-guard.ts'
import { registerSandbox } from '../../server/src/sandbox/index.ts'

type J = any // eslint-disable-line @typescript-eslint/no-explicit-any

let dataDir: string
let base: string
let core: CoreImpl
let app: Awaited<ReturnType<typeof buildApp>>
let stopBots: () => Promise<void>
let buyer: Client
let site: Awaited<ReturnType<typeof startSite>>
let hunter: MockHunter
const clients: Client[] = []
const log = memoryLogger()
const oldKey = process.env.HUNTER_API_KEY
const globexHits = { n: 0 }

const acme = Array.from({ length: 10 }, (_, i) => `a${i + 1}@acme-corp.com`)
const globex = Array.from({ length: 10 }, (_, i) => `g${i + 1}@globex-inc.com`)
const FLICKER = 'g10@globex-inc.com'
const page = (list: string[]) => `<html><body>${list.map((a) => `<a href="mailto:${a}">${a}</a>`).join('\n')}</body></html>`
const resolveMx = async (d: string) => (['acme-corp.com', 'globex-inc.com'].includes(d) ? [{ exchange: `mx.${d}`, priority: 10 }] : Promise.reject(Object.assign(new Error('nx'), { code: 'ENODATA' })))

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
  const c = new McpClient({ name: 'e2e-find-leads', version: '0' }, { capabilities: {} })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?toolsets=buyer`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
  clients.push(c)
  return c
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<J> => {
  const res = await c.callTool({ name, arguments: args })
  const text = (res.content as { text: string }[])[0]!.text
  if (res.isError) throw new Error(`${name}: ${text}`)
  return res.structuredContent ?? JSON.parse(text.slice(text.indexOf('\n') + 1))
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

beforeAll(async () => {
  // The server has the Hunter key, so the shelf lists find_leads (seed reads it); the bots get a mock fetch.
  process.env.HUNTER_API_KEY = KEY
  registerPlatformSecret(KEY)
  site = await startSite((u) => {
    if (u.pathname === '/acme') return [200, page(acme)]
    if (u.pathname === '/many') return [200, page(Array.from({ length: 60 }, (_, i) => `m${i + 1}@acme-corp.com`))]
    // the platform looks later than the bot: from the second visit on, one address is gone
    if (u.pathname === '/globex') return [200, page(++globexHits.n === 1 ? globex : globex.filter((a) => a !== FLICKER))]
    return [404, 'not found']
  })
  hunter = mockHunter({
    'acme-corp.com': { organization: 'Acme Corp', emails: acme.map((a) => email(a, `${site.origin}/acme`)) },
    'globex-inc.com': { organization: 'Globex', emails: globex.map((a) => email(a, `${site.origin}/globex`)) },
  })
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-findleads-'))
  const allowHosts = [site.host]
  const intelligence = await createIntelligence({ publicUrl: base, allowHosts, env: {} })
  registerHouseBotChecks(intelligence.checks, { allowHosts: [...allowHosts, `127.0.0.1:${port}`], resolveMx })
  core = await createCore({
    intelligence,
    config: { dataDir, tickMs: 0, demoMode: false, rail: 'simulated', sealKey: 'b'.repeat(64), publicUrl: base, paypal: { clientId: '', clientSecret: '', webhookId: '', env: 'sandbox' } },
    dbFile: ':memory:',
  })
  app = await buildApp(core, { logger: false })
  await registerSandbox(app, { checks: intelligence.checks, publicUrl: base, dataDir, timeScale: 0.002 })
  await app.listen({ port, host: '127.0.0.1' })
  const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'demo-keys.json'), 'utf8'))
  buyer = await mcp(keys.orano_growth_agent.api_key)
  stopBots = await startHouseBots({
    url: base,
    keys: { glob_studio_bots: keys.glob_studio_bots.api_key },
    only: ['lead-verifier', 'lead-finder'], // both skills of one bot card on one host: each job goes to the skill its spec names
    ai: NO_AI,
    log,
    pollSeconds: 1,
    allowHosts,
    mx: { resolveMx },
    hunter: { apiKey: KEY, fetchImpl: hunter.fetchImpl, accountTtlMs: 0 },
  })
}, 60_000)

afterAll(async () => {
  await stopBots?.()
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
  await app?.close()
  await core?.close()
  await site?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  clearPlatformSecrets()
  if (oldKey === undefined) delete process.env.HUNTER_API_KEY
  else process.env.HUNTER_API_KEY = oldKey
})

describe('find_leads on the real core', () => {
  it('shelf: the Lead Verifier lists the skill and a bot-owned Hunter.io connection with its monthly limit', async () => {
    const bot = ((await call(buyer, 'search_bots', { query: 'Lead Verifier' })).bots as { id: string; name: string }[]).find((b) => b.name === 'Lead Verifier')!
    const got = (await call(buyer, 'get_bot', { bot_id: bot.id })).bot
    expect(got.skills.map((s: J) => s.id)).toEqual(['verify_leads', 'find_leads'])
    const skill = got.skills.find((s: J) => s.id === 'find_leads')
    expect(skill.pricing).toMatchObject({ price: '0.35', unit: 'verified_lead', min_units: 18, max_units: 100 })
    expect(skill.brief.needs[0].label).toBe('Your target companies')
    expect(got.skills[0].brief.needs[0].label).toBe('Your lead list (JSONL)') // the other skill keeps its own brief
    const conn = got.passport.connections.find((c: J) => c.name === 'Hunter.io')
    expect(conn).toMatchObject({ kind: 'data_api', owner: 'bot', verified: true })
    expect(conn.purpose).toMatch(/50 domain searches a month/)
  })

  it('a plain request becomes a find_leads job; the bot quotes after reading its quota; the platform pays only leads it re-verifies', async () => {
    const bot = ((await call(buyer, 'search_bots', { query: 'Lead Verifier' })).bots as { id: string; name: string }[]).find((b) => b.name === 'Lead Verifier')!
    const draft = await call(buyer, 'draft_job_spec', { bot_id: bot.id, skill_id: 'find_leads', goal: 'Find 20 marketing leads at acme-corp.com and globex-inc.com.', quantity: 20, budget_cap: '10.00' })
    expect(draft.spec.skill_id).toBe('find_leads')
    expect(draft.spec.deliverables[0]).toMatchObject({ quantity: 20, acceptance: [{ check: 'lead_verified' }] })
    expect(draft.estimate.value).toBe('7.00')
    const job: string = (await call(buyer, 'create_job', { bot_id: bot.id, spec: draft.spec, idempotency_key: 'e2e-find-create' })).job.id
    const quoted = await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'the quote')
    expect(quoted.total_max.value).toBe('7.00')
    expect(quoted.lines[0]).toMatchObject({ unit_price: '0.35', quantity: 20 })
    // before any deal: the free account call, no domain search
    expect(hunter.calls.filter((c) => c.path === '/v2/domain-search')).toHaveLength(0)
    expect(hunter.calls.some((c) => c.path === '/v2/account')).toBe(true)

    await call(buyer, 'provide_inputs', { job_id: job, inputs: { domains: ['acme-corp.com', 'globex-inc.com'] } })
    const signed = await until(async () => {
      const j = await call(buyer, 'get_job', { job_id: job })
      return j.job.accepted_by.some((x: J) => x.role === 'seller' && x.contract_hash === j.job.contract_hash) ? j : null
    }, 30_000, 'the bot signing the contract')
    await call(buyer, 'accept_contract', { job_id: job, contract_hash: signed.job.contract_hash })
    expect((await call(buyer, 'fund_job', { job_id: job, idempotency_key: 'e2e-find-fund' })).job.state).toBe('IN_PROGRESS')
    const delivered = await until(async () => {
      const j = await call(buyer, 'get_job', { job_id: job })
      return j.job.state === 'DELIVERED' ? j : null
    }, 90_000, 'the delivery')

    // 20 leads delivered (10 per domain); the platform re-checked each; the one that left its page fails and is not paid
    expect(hunter.calls.filter((c) => c.path === '/v2/domain-search').map((c) => c.query.domain)).toEqual(['acme-corp.com', 'globex-inc.com'])
    expect(hunter.calls.filter((c) => c.path === '/v2/domain-search').every((c) => c.query.department === 'marketing' && c.query.limit === '10')).toBe(true)
    expect(delivered.job.fulfilment[0]).toMatchObject({ expected_units: 20, passed_units: 19, failed_units: 1 })
    expect(Number(delivered.job.fulfilment[0].earned.value)).toBeCloseTo(6.65, 2)
    const run = await call(buyer, 'run_checks', { job_id: job })
    const failing = run.checks.filter((c: J) => c.status !== 'pass')
    expect(failing).toHaveLength(1)
    expect(failing[0].detail).toMatch(/not verified.*address not on the source page/)

    await call(buyer, 'review_delivery', { job_id: job, decision: 'accept' })
    await core.internal.drain()
    const escrow = (await call(buyer, 'get_escrow', { job_id: job })).escrow
    expect(Number(escrow.captured.value)).toBeCloseTo(6.65, 2) // 19 x $0.35: only leads the platform verified

    // the key never reached the room, the job, the escrow, a delivery, a log line, or any request URL
    const messages = await call(buyer, 'get_messages', { job_id: job })
    const everything = JSON.stringify({ messages, delivered, escrow, run, log: log.entries, urls: hunter.calls.map((c) => c.url) })
    expect(everything).not.toContain(KEY)
    expect(hunter.calls.every((c) => c.key === KEY)).toBe(true) // it was sent, in the header, every time
  }, 120_000)

  it('the Lead Verifier first skill still works beside it: a verify_leads job on the same host goes to the verifier, not the finder', async () => {
    const bot = ((await call(buyer, 'search_bots', { query: 'Lead Verifier' })).bots as { id: string; name: string }[]).find((b) => b.name === 'Lead Verifier')!
    const searchesBefore = hunter.calls.filter((c) => c.path === '/v2/domain-search').length
    const leads = Array.from({ length: 60 }, (_, i) => JSON.stringify({ to: `m${i + 1}@acme-corp.com`, company: 'Acme Corp', email_source_url: `${site.origin}/many` })).join('\n')
    const draft = await call(buyer, 'draft_job_spec', { bot_id: bot.id, skill_id: 'verify_leads', goal: 'Verify these 60 business leads.', quantity: 60, budget_cap: '6.00' })
    const job: string = (await call(buyer, 'create_job', { bot_id: bot.id, spec: draft.spec, idempotency_key: 'e2e-verify-create' })).job.id
    await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'the quote')
    await call(buyer, 'provide_inputs', { job_id: job, inputs: { leads_jsonl: leads } })
    const signed = await until(async () => {
      const j = await call(buyer, 'get_job', { job_id: job })
      return j.job.accepted_by.some((x: J) => x.role === 'seller' && x.contract_hash === j.job.contract_hash) ? j : null
    }, 30_000, 'the bot signing the contract')
    await call(buyer, 'accept_contract', { job_id: job, contract_hash: signed.job.contract_hash })
    await call(buyer, 'fund_job', { job_id: job, idempotency_key: 'e2e-verify-fund' })
    const delivered = await until(async () => {
      const j = await call(buyer, 'get_job', { job_id: job })
      return j.job.state === 'DELIVERED' ? j : null
    }, 90_000, 'the delivery')
    expect(delivered.job.fulfilment[0]).toMatchObject({ expected_units: 60, passed_units: 60 })
    expect(hunter.calls.filter((c) => c.path === '/v2/domain-search').length).toBe(searchesBefore) // no Hunter search for a verify job
  }, 120_000)
})
