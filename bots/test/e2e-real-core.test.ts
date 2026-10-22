// End to end on the REAL core (simulated PayPal rail, in-memory database): a buyer agent hires each house bot
// over the public MCP endpoint; the bots negotiate, wait for funding, work, deliver; the platform runs the
// acceptance checks itself and the buyer settles. Wired exactly as server/src/index.ts should be (see the report).
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
import { commission } from '../../server/src/core/fees.ts'
import { buildApp } from '../../server/src/http/app.ts'
import { registerHouseBotChecks } from '../../server/src/housebots/checks.ts'
import { createIntelligence } from '../../server/src/intelligence/index.ts'
import { registerSandbox } from '../../server/src/sandbox/index.ts'

type Site = Awaited<ReturnType<typeof startSite>>
type J = any // eslint-disable-line @typescript-eslint/no-explicit-any

const KIT = 'Product: ORANO\nURL: https://oranoai.com\nOne-liner: ORANO is an AI productivity companion that saves links, extracts tasks and exposes an MCP server for agents.\nORANO is live on iOS and Android and built for solo builders who work with AI agents. Contact: hello@oranoai.com'
const cf = (s: string, key = 0x2b) => key.toString(16).padStart(2, '0') + [...s].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('')

let dataDir: string
let base: string
let core: CoreImpl
let app: Awaited<ReturnType<typeof buildApp>>
let stopBots: () => Promise<void>
let site: Site
let buyer: Client
const clients: Client[] = []
const log = memoryLogger()
let operatorKey = ''

// Dispute fixtures: a page listing 100 lead addresses; the test later removes some of them (the page "changed after delivery").
const LEADS = 100
const hiddenLeads: Record<string, Set<number>> = { split: new Set(), redo: new Set(), open: new Set() }
const leadAddr = (name: string, i: number) => `p${i}@lead-${name}.com`
const leadPage = (name: string) => `<html><body>${Array.from({ length: LEADS }, (_, k) => k + 1).filter((i) => !hiddenLeads[name]!.has(i)).map((i) => `<a href="mailto:${leadAddr(name, i)}">contact ${i}</a>`).join('\n')}</body></html>`

// Offline DNS: the lead-* test domains accept mail, everything else has no MX.
const resolveMx = async (d: string) => (d.endsWith('.com') && d.startsWith('lead') ? [{ exchange: `mx.${d}`, priority: 10 }] : Promise.reject(Object.assign(new Error('nx'), { code: 'ENODATA' })))

async function freePort() {
  return new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

async function mcp(key: string, toolsets = 'buyer'): Promise<Client> {
  const c = new McpClient({ name: 'e2e', version: '0' }, { capabilities: {} })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?toolsets=${toolsets}`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
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
    if (Date.now() > end) {
      fs.writeFileSync(path.join(os.tmpdir(), 'rentabot-e2e-log.json'), JSON.stringify(log.entries.slice(-60), null, 1))
      throw new Error(`timed out waiting for ${label}`)
    }
    await sleep(60)
  }
}

/** The buyer side of one job, up to DELIVERED, through the public MCP tools only. */
async function hire(a: { bot: string; skill: string; goal: string; quantity: number; budget: string; context: string; inputs: Record<string, unknown>; key: string; tweak?: (spec: J) => void; beforeFund?: (job: string) => Promise<void>; whileWorking?: (job: string) => Promise<void> }): Promise<J> {
  const found = (await call(buyer, 'search_bots', { query: a.bot })).bots as { id: string; name: string }[]
  const bot = found.find((b) => b.name === a.bot)
  if (!bot) throw new Error(`bot ${a.bot} not found`)
  const draft = await call(buyer, 'draft_job_spec', { bot_id: bot.id, skill_id: a.skill, goal: a.goal, quantity: a.quantity, budget_cap: a.budget, context: a.context })
  a.tweak?.(draft.spec)
  const job: string = (await call(buyer, 'create_job', { bot_id: bot.id, spec: draft.spec, idempotency_key: `e2e-${a.key}-create` })).job.id
  await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, `${a.bot} quote`)
  await call(buyer, 'provide_inputs', { job_id: job, inputs: a.inputs })
  const signed = await until(async () => {
    const j = await call(buyer, 'get_job', { job_id: job })
    return j.job.accepted_by.some((x: J) => x.role === 'seller' && x.contract_hash === j.job.contract_hash) ? j : null
  }, 30_000, `${a.bot} signature`)
  await call(buyer, 'accept_contract', { job_id: job, contract_hash: signed.job.contract_hash })
  await a.beforeFund?.(job)
  const funded = await call(buyer, 'fund_job', { job_id: job, idempotency_key: `e2e-${a.key}-fund` })
  expect(funded.job.state).toBe('IN_PROGRESS') // inside the mandate: no human needed
  const side = a.whileWorking?.(job)
  const delivered = await until(async () => {
    const j = await call(buyer, 'get_job', { job_id: job })
    return j.job.state === 'DELIVERED' ? j : null
  }, 120_000, `${a.bot} delivery`)
  await side
  if (process.env.E2E_DUMP) {
    const r = await call(buyer, 'run_checks', { job_id: job })
    const bad = r.checks.filter((c: J) => c.status !== 'pass')
    fs.writeFileSync(path.join(os.tmpdir(), `rentabot-e2e-${a.key}.json`), JSON.stringify({ fulfilment: r.fulfilment, failing: bad.slice(0, 12).map((c: J) => [c.unit_ref, c.check, c.status, c.detail]) }, null, 1))
  }
  return delivered
}

beforeAll(async () => {
  site = await startSite((u) => {
    switch (u.pathname) {
      case '/team':
        return [200, '<a href="mailto:hello@lead-one.com">hello</a>']
      case '/cf':
        return [200, `<a data-cfemail="${cf('sales@lead-two.com')}">[email&#160;protected]</a>`]
      case '/leads-split':
      case '/leads-redo':
      case '/leads-open':
        return [200, leadPage(u.pathname.slice('/leads-'.length))]
      case '/robots.txt':
        return [200, 'User-agent: *\nAllow: /\n', { 'content-type': 'text/plain' }]
      case '/llms.txt':
        return [200, '# Acme\n> Acme sells widgets to agents.\n', { 'content-type': 'text/plain' }]
      case '/':
        return [200, '<html><body><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script><a href="/pricing">Pricing</a></body></html>']
      case '/pricing':
        return [200, '<h1>Pricing</h1>']
      default:
        return [404, 'not found', { 'content-type': 'text/plain' }]
    }
  })
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-e2e-'))
  const allowHosts = [site.host]
  // Exactly the boot wiring: intelligence -> house-bot checks -> core -> app -> Sandbox Web.
  const intelligence = await createIntelligence({ publicUrl: base, allowHosts, env: {} })
  registerHouseBotChecks(intelligence.checks, { allowHosts: [...allowHosts, `127.0.0.1:${port}`], resolveMx })
  core = await createCore({
    intelligence,
    config: { dataDir, tickMs: 0, demoMode: false, rail: 'simulated', sealKey: 'b'.repeat(64), publicUrl: base, paypal: { clientId: '', clientSecret: '', webhookId: '', env: 'sandbox' } },
    dbFile: ':memory:',
  })
  app = await buildApp(core, { logger: !!process.env.E2E_LOG })
  await registerSandbox(app, { checks: intelligence.checks, publicUrl: base, dataDir, timeScale: 0.002 })
  await app.listen({ port, host: '127.0.0.1' })
  const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'demo-keys.json'), 'utf8'))
  operatorKey = keys.glob_studio_bots.api_key
  buyer = await mcp(keys.orano_growth_agent.api_key)
  stopBots = await startHouseBots({
    url: base,
    keys: { glob_studio_bots: operatorKey },
    ai: NO_AI,
    log,
    pollSeconds: 1,
    allowHosts,
    directoryBlaster: { pollMs: 50, retryCapMs: 50 },
    accountSetup: { pollMs: 50, retryCapMs: 50, settleMs: 10_000 },
    applicationFiller: { pollMs: 50, approvalWaitMs: 60_000 },
    mx: { resolveMx },
  })
}, 60_000)

afterAll(async () => {
  await stopBots?.()
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
  await app?.close()
  await core?.close()
  await site?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('house bots on the real core', () => {
  it('Cold Email Writer: 12 emails (its $6.00 minimum job), platform email_lint passes all, buyer accepts and the bot is paid', async () => {
    const more = ['Copper Lane Partners', 'Fjord Capital', 'Meridian Seed', 'Quartz Hill Ventures', 'Tidewater Fund', 'Juniper Angels', 'Lantern Street Capital', 'Harbor Light Capital', 'Saltmarsh Ventures'].map((company) => ({ company, angle: 'Developer tools and infrastructure for AI agents.' }))
    const j = await hire({
      bot: 'Cold Email Writer', skill: 'write_cold_emails', goal: 'Write 12 personal cold emails for ORANO to investors.', quantity: 12, budget: '6.00', context: KIT, key: 'cold',
      inputs: { facts_kit: KIT, recipients: [{ name: 'Maya Okafor', company: 'Northwind Ventures', angle: 'Developer tools and infrastructure for AI agents.' }, { name: 'Hana Sato', company: 'Origami Ventures', angle: 'Creative tools and generative media.' }, { company: 'Kiln Seed Fund', angle: 'Marketplaces where trust and payments are the product.' }, ...more] },
    })
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 12, passed_units: 12, failed_units: 0 })
    const done = await call(buyer, 'review_delivery', { job_id: j.job.id, decision: 'accept' })
    await core.internal.drain()
    const after = await call(buyer, 'get_job', { job_id: j.job.id })
    expect(['DELIVERED', 'SETTLED']).toContain(after.job.state)
    expect(done.job.id).toBe(j.job.id)
    const escrow = (await call(buyer, 'get_escrow', { job_id: j.job.id })).escrow
    expect(Number(escrow.captured.value)).toBeCloseTo(6, 2) // 12 x $0.50, only for emails the platform verified
  }, 90_000)

  it('Lead Verifier: the platform re-verifies every lead and agrees, including an honest rejection', async () => {
    const leads = [
      { to: 'hello@lead-one.com', company: 'Lead One Ltd', email_source_url: `${site.origin}/team`, country: 'UK' },
      { to: 'sales@lead-two.com', company: 'Lead Two', email_source_url: `${site.origin}/cf`, country: 'US' },
      { to: 'ghost@lead-three.com', company: 'Lead Three', email_source_url: `${site.origin}/team`, country: 'US' },
    ]
    const j = await hire({ bot: 'Lead Verifier', skill: 'verify_leads', goal: 'Verify these 3 business leads: the address must be on the cited page and the domain must accept mail.', quantity: 3, budget: '5.00', context: 'Public business addresses only.', key: 'leads', inputs: { leads_jsonl: leads.map((l) => JSON.stringify(l)).join('\n') } })
    expect(j.job.fulfilment[0]).toMatchObject({ passed_units: 3, failed_units: 0 }) // 2 verified + 1 honest "not verified" (the spec asks for 50: the skill's minimum, only 3 leads were given)
    const room = (await call(buyer, 'get_messages', { job_id: j.job.id })).messages as J[]
    const units = room.find((m) => m.type === 'delivery')!.body.delivery.deliverables[0].units
    expect(units.map((u: J) => u.meta.verified)).toEqual([true, true, false])
  }, 90_000)

  it('Agent-Readiness Auditor: report artifact plus findings the platform re-fetches', async () => {
    const j = await hire({ bot: 'Agent-Readiness Auditor', skill: 'agent_readiness_audit', goal: `Audit ${site.origin} for AI-agent readiness.`, quantity: 1, budget: '12.00', context: 'Public site.', key: 'audit', inputs: { site_url: site.origin } })
    const f = j.job.fulfilment[0]
    expect(f.failed_units).toBe(0)
    expect(f.passed_units).toBeGreaterThanOrEqual(1)
  }, 90_000)

  it('Directory Blaster: 40 submitted, 34 delivered live, and after the removals the platform counts 31 of 40', async () => {
    const t0 = Date.now()
    const j = await hire({
      bot: 'Directory Blaster', skill: 'directory_submission', goal: 'Get ORANO listed on 40 AI and productivity directories for under $70 before launch.', quantity: 40, budget: '70.00',
      context: 'Product: ORANO, https://oranoai.com. A friendly AI productivity companion.', key: 'dirs',
      // The copilot also asks listing pages to mention "oranoai.com"; Sandbox Web shows the product URL only as a link target, so the buyer keeps the product name.
      tweak: (spec) => { for (const t of spec.deliverables[0].acceptance) if (t.check === 'page_mentions') t.params = { must_include: ['ORANO'] } },
      inputs: { product_name: 'ORANO', url: 'https://oranoai.com', tagline_60: 'Your AI productivity companion', description_300: 'ORANO saves links, extracts tasks and exposes an MCP server so agents can work with your saved content.', category: 'AI Tools', contact_email: 'hello@oranoai.com' },
    })
    const first = j.job.fulfilment[0]
    expect(first.expected_units).toBe(40)
    expect(first.passed_units).toBeGreaterThanOrEqual(31)
    // Moderation and removals settle; the platform re-runs its checks and finds 31 live listings.
    await sleep(Math.max(0, 9000 - (Date.now() - t0)))
    const rerun = await call(buyer, 'run_checks', { job_id: j.job.id })
    const f = rerun.fulfilment[0]
    expect(f.passed_units).toBe(31)
    expect(f.failed_units).toBeLessThanOrEqual(3) // listings that disappeared after the bot saw them (those it saw vanish while it waited are simply not delivered)
    const room = (await call(buyer, 'get_messages', { job_id: j.job.id, limit: 200 })).messages as J[]
    expect(room.find((m) => m.type === 'delivery')!.text).toContain('skipped because they declare payment or human verification')
  }, 180_000)

  it('Open job: Lead Verifier and Budget Lead Verifier both bid, the buyer awards the cheaper bid, and it settles like any job', async () => {
    const N = 80 // the budget bot's minimum
    const rows = Array.from({ length: N }, (_, k) => k + 1).map((i) => JSON.stringify({ to: leadAddr('open', i), company: `Open Co ${i}`, email_source_url: `${site.origin}/leads-open`, country: 'US' }))
    const bot = ((await call(buyer, 'search_bots', { query: 'Lead Verifier' })).bots as { id: string; name: string }[]).find((b) => b.name === 'Lead Verifier')!
    const draft = await call(buyer, 'draft_job_spec', { bot_id: bot.id, skill_id: 'verify_leads', goal: `Verify these ${N} business leads: the address must be on the cited page and the domain must accept mail.`, quantity: N, budget_cap: '10.00', context: 'Public business addresses only.' })
    draft.spec.deadline = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const posted = await call(buyer, 'post_open_job', { spec: draft.spec, bid_window: 'PT30M', award: 'manual', idempotency_key: 'e2e-open-post' })
    const open = posted.open_job.id as string
    expect(posted.open_job.matching_bots).toBe(2)
    // The public board shows it without the private context.
    const board = (await (await fetch(`${base}/api/ops/list_open_jobs?open_job_id=${open}`)).json()) as J
    expect(board.open_jobs[0].spec.context).toBe('')
    const lb = await until(async () => {
      const r = await call(buyer, 'list_bids', { open_job_id: open })
      return r.bids.length === 2 ? r : null
    }, 30_000, 'two house-bot bids')
    const by = Object.fromEntries(lb.bids.map((b: J) => [b.bot_name, b]))
    expect(by['Lead Verifier'].price.value).toBe('8.00') // 80 x $0.10, turnaround PT2H
    expect(by['Budget Lead Verifier'].price.value).toBe('5.60') // 80 x $0.07, turnaround PT10H
    expect(by['Budget Lead Verifier'].turnaround).toBe('PT10H')
    expect(lb.recommended.lowest_price).toBe(by['Budget Lead Verifier'].id)
    const won = await call(buyer, 'award_bid', { open_job_id: open, bid_id: by['Budget Lead Verifier'].id })
    const job = won.job.id as string
    expect(won.job).toMatchObject({ state: 'NEGOTIATING', origin: { open_job_id: open } })
    expect(won.job.contract.quote.total_max.value).toBe('5.60')
    expect(won.job.escrow.status).toBe('none') // nothing held before funding
    await call(buyer, 'provide_inputs', { job_id: job, inputs: { leads_jsonl: rows.join('\n') } })
    const signed = await until(async () => {
      const j = await call(buyer, 'get_job', { job_id: job })
      return j.job.accepted_by.some((x: J) => x.role === 'seller' && x.contract_hash === j.job.contract_hash) ? j : null
    }, 30_000, 'the awarded bot signing the contract')
    await call(buyer, 'accept_contract', { job_id: job, contract_hash: signed.job.contract_hash })
    expect((await call(buyer, 'fund_job', { job_id: job, idempotency_key: 'e2e-open-fund' })).job.state).toBe('IN_PROGRESS')
    const delivered = await until(async () => {
      const j = await call(buyer, 'get_job', { job_id: job })
      return j.job.state === 'DELIVERED' ? j : null
    }, 120_000, 'the awarded bot delivering')
    expect(delivered.job.fulfilment[0]).toMatchObject({ expected_units: N, passed_units: N, failed_units: 0 })
    await call(buyer, 'review_delivery', { job_id: job, decision: 'accept' })
    await core.internal.drain()
    const e = (await call(buyer, 'get_escrow', { job_id: job })).escrow
    expect(e.captured.value).toBe('5.60')
    // The other bid was declined and the open job is closed; the losing bot got its event.
    const closed = await call(buyer, 'list_bids', { open_job_id: open })
    expect(closed.open_job).toMatchObject({ state: 'awarded', job_id: job })
    expect(closed.bids.find((b: J) => b.bot_name === 'Lead Verifier').status).toBe('declined')
    expect(log.entries.filter((x) => x.action === 'submit_bid' && x.ok).length).toBeGreaterThanOrEqual(2)
  }, 240_000)

  // ---- the acting bots: the buyer's own inbox, accounts handed over through the locker, approval before submitting ----
  const mailboxFor = async (address: string): Promise<string> => ((await (await fetch(`${base}/sandbox/mail/mailboxes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })).json()) as { app_password: string }).app_password
  const shareLogin = (job: string, username: string, password: string) =>
    call(buyer, 'put_locker_item', { job_id: job, access_id: 'A1', label: 'inbox', secret: { kind: 'login', url: 'imap://sandbox', username, password, notes: '' } })

  it("Investor Outreach Bot: sends from the buyer's own mailbox with its app password, every send is logged first, and the platform sees smtp_auth", async () => {
    const address = 'founder@e2e-orano.com'
    const pw = await mailboxFor(address)
    const j = await hire({
      bot: 'Investor Outreach Bot', skill: 'investor_outreach', goal: 'Email 5 investors whose thesis fits ORANO, from my own address.', quantity: 5, budget: '20.00', context: KIT, key: 'investors',
      inputs: { facts_kit: KIT },
      beforeFund: async (job) => void (await shareLogin(job, address, pw)),
    })
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 5, failed_units: 0 }) // it checked fit before quoting: 5 fit this kit, so 5 were accepted
    expect(j.job.fulfilment[0].passed_units).toBeGreaterThanOrEqual(1)
    const lock = await call(buyer, 'list_locker_items', { job_id: j.job.id })
    const sends = (lock.actions as J[]).filter((x) => x.action === 'send_email')
    expect(sends.length).toBe(j.job.fulfilment[0].passed_units + j.job.fulfilment[0].failed_units + j.job.fulfilment[0].pending_units)
    expect(lock.consent[0].usage.used_total).toBeLessThanOrEqual(lock.consent[0].usage.max_total)
    const room = (await call(buyer, 'get_messages', { job_id: j.job.id, limit: 200 })).messages as J[]
    expect(room.some((m) => m.type === 'system' && /Integrity flag/.test(m.text))).toBe(false)
    const units = room.find((m) => m.type === 'delivery')!.body.delivery.deliverables[0].units
    for (const u of units) expect(u.meta.from).toBe(address)
    expect(JSON.stringify(room)).not.toContain(pw)
  }, 150_000)

  it('Account Setup Bot: five accounts, logins locked in the locker until their units are paid, nothing secret in the room, the platform re-checks every profile', async () => {
    const address = 'owner@e2e-orano.com'
    const pw = await mailboxFor(address)
    const j = await hire({
      bot: 'Account Setup Bot', skill: 'account_setup', goal: 'Open accounts for ORANO on the analytics, newsletter, social, status page and forum services.', quantity: 5, budget: '10.00', context: KIT, key: 'accounts',
      tweak: (spec) => { for (const t of spec.deliverables[0].acceptance) if (t.check === 'page_mentions') t.params = { must_include: ['ORANO'] } },
      inputs: { product_name: 'ORANO', url: 'https://oranoai.com', tagline_60: 'Your AI productivity companion', description_300: 'ORANO saves links, extracts tasks and exposes an MCP server so agents can work with your saved content.', contact_email: address, logo_url: 'https://oranoai.com/logo.png' },
      beforeFund: async (job) => void (await shareLogin(job, address, pw)),
    })
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 5, passed_units: 5, failed_units: 0 })
    const job = j.job.id as string
    const handovers = ((await call(buyer, 'list_locker_items', { job_id: job })).items as J[]).filter((x) => x.direction === 'handover')
    expect(handovers).toHaveLength(5)
    expect(new Set(handovers.map((x) => x.unit_ref)).size).toBe(5)
    expect(handovers.every((x) => x.status === 'locked' && x.kind === 'login')).toBe(true) // delivered, not yet paid
    await expect(call(buyer, 'open_locker_item', { job_id: job, item_id: handovers[0].id })).rejects.toThrow()
    await call(buyer, 'review_delivery', { job_id: job, decision: 'accept' })
    await core.internal.drain()
    const after = ((await call(buyer, 'list_locker_items', { job_id: job })).items as J[]).filter((x) => x.direction === 'handover')
    expect(after.every((x) => x.status !== 'locked')).toBe(true)
    const opened = await call(buyer, 'open_locker_item', { job_id: job, item_id: after[0].id })
    expect(opened.secret).toMatchObject({ kind: 'login', username: address })
    expect(String(opened.secret.password).length).toBeGreaterThanOrEqual(20)
    const room = JSON.stringify((await call(buyer, 'get_messages', { job_id: job, limit: 200 })).messages)
    expect(room).not.toContain(opened.secret.password)
    expect(room).not.toContain(pw)
  }, 180_000)

  it("Application Filler: fills the forms, blocks for the buyer's approval with a preview, then submits only what was approved", async () => {
    const address = 'maya@e2e-orano.com'
    let approvedId = ''
    const j = await hire({
      bot: 'Application Filler', skill: 'application_filling', goal: 'Apply ORANO to three accelerator, grant and launch programmes.', quantity: 3, budget: '12.00', context: KIT, key: 'applications',
      tweak: (spec) => { for (const t of spec.deliverables[0].acceptance) if (t.check === 'page_mentions') t.params = { must_include: ['ORANO'] } },
      inputs: { facts_kit: KIT, applicant_name: 'Maya Okafor', applicant_email: address, amount_usd: 50000 },
      whileWorking: async (job) => {
        const blocked = await until(async () => {
          const m = ((await call(buyer, 'get_messages', { job_id: job, limit: 200 })).messages as J[]).find((x) => x.type === 'blocker' && x.from.role === 'seller')
          return m ?? null
        }, 60_000, 'the approval request')
        expect(blocked.text.startsWith('Approval needed:')).toBe(true)
        expect((await call(buyer, 'get_job', { job_id: job })).job.state).toBe('BLOCKED')
        const ids = blocked.text.split('\n').filter((l: string) => /^- [a-z0-9-]+: /.test(l)).map((l: string) => l.slice(2).split(':')[0]!)
        expect(ids).toHaveLength(3)
        await sleep(300) // nothing is submitted while it waits
        const wait = (await call(buyer, 'list_locker_items', { job_id: job })).actions as J[]
        expect(wait).toHaveLength(3) // the three fill_form actions, no submit yet
        approvedId = ids[0]!
        await call(buyer, 'provide_inputs', { job_id: job, inputs: { approved_applications: ids.slice(0, 2).join(',') } })
      },
    })
    const f = j.job.fulfilment[0]
    expect(f.expected_units).toBe(3)
    expect(f.passed_units).toBe(2) // two approved and submitted; the third stays a draft
    const room = (await call(buyer, 'get_messages', { job_id: j.job.id, limit: 200 })).messages as J[]
    const units = room.find((m) => m.type === 'delivery')!.body.delivery.deliverables[0].units
    expect(units).toHaveLength(2)
    expect(units.map((u: J) => u.ref)).toContain(approvedId)
    expect(room.some((m) => m.type === 'system' && /Integrity flag/.test(m.text))).toBe(false)
  }, 180_000)

  /** A Lead Verifier job of 100 leads that all verify; then 20 addresses vanish from the cited page, so the platform now fails them. */
  async function disputedLeadJob(name: 'split' | 'redo'): Promise<string> {
    const rows = Array.from({ length: LEADS }, (_, k) => k + 1).map((i) => JSON.stringify({ to: leadAddr(name, i), company: `Lead Co ${i}`, email_source_url: `${site.origin}/leads-${name}`, country: 'US' }))
    const j = await hire({ bot: 'Lead Verifier', skill: 'verify_leads', goal: `Verify these ${LEADS} business leads: the address must be on the cited page and the domain must accept mail.`, quantity: LEADS, budget: '10.00', context: 'Public business addresses only.', key: `dispute-${name}`, inputs: { leads_jsonl: rows.join('\n') } })
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: LEADS, passed_units: LEADS, failed_units: 0 })
    for (let i = 5; i <= LEADS; i += 5) hiddenLeads[name]!.add(i) // 20 addresses gone from the page
    const rerun = await call(buyer, 'run_checks', { job_id: j.job.id })
    expect(rerun.fulfilment[0]).toMatchObject({ passed_units: 80, failed_units: 20 })
    await call(buyer, 'open_dispute', { job_id: j.job.id, reason: 'Twenty leads no longer verify: their addresses are gone from the cited page.', claims: ['20 of 100 leads fail the lead_verified check'] })
    return j.job.id
  }
  const mediationOf = async (job: string, kind: string) => {
    const m = await until(async () => {
      const x = (await call(buyer, 'get_mediation', { job_id: job })).mediation
      return x?.status === 'negotiating' ? x : null
    }, 30_000, 'the mediator proposals')
    return { med: m, target: m.proposals.find((p: J) => p.by === 'mediator' && p.kind === kind) as J }
  }
  const settled = (job: string) => until(async () => {
    const j = await call(buyer, 'get_job', { job_id: job })
    const e = j.job.escrow
    const sent = e.events.filter((x: J) => x.kind === 'payout_sent').length
    const done = e.events.filter((x: J) => x.kind === 'payout_succeeded').length
    return j.job.state === 'SETTLED' && sent === done ? j : null
  }, 60_000, 'settlement')

  it('Dispute: the buyer opens a dispute after a partial delivery and the bot accepts the verified split; the agreement executes with one capture', async () => {
    const job = await disputedLeadJob('split')
    const { target } = await mediationOf(job, 'split')
    expect(target.terms).toMatchObject({ release_now: '8.00', refund_now: '2.00' }) // 80 verified leads x $0.10
    await call(buyer, 'respond_to_proposal', { job_id: job, proposal_id: target.id, answer: 'accept' })
    const done = await settled(job)
    expect(done.job.mediation.status).toBe('agreed')
    expect(done.job.mediation.agreed_proposal_id).toBe(target.id)
    const agreed = done.job.mediation.proposals.find((p: J) => p.id === target.id)
    expect(agreed.responses.seller).toMatchObject({ answer: 'accept' }) // the bot answered by itself
    const e = (await call(buyer, 'get_escrow', { job_id: job })).escrow
    expect(e.events.filter((x: J) => x.kind === 'captured')).toHaveLength(1)
    expect(e.events.filter((x: J) => x.kind === 'payout_sent')).toHaveLength(1)
    expect(e.captured.value).toBe('8.00')
    expect(e.voided.value).toBe('2.00')
    expect(Number(e.paid_out.value)).toBeCloseTo((800 - commission(800)) / 100, 2) // gross minus commission
    expect(e.fees.value).toBe((commission(800) / 100).toFixed(2))
    // The bot used next_actions only and never put text addressed to the mediator in its answer.
    const room = (await call(buyer, 'get_messages', { job_id: job })).messages as J[]
    const answer = room.find((m) => m.type === 'proposal_response' && m.from.role === 'seller')!
    expect(answer.text).toMatch(/accepted proposal/)
    expect(room.some((m) => m.type === 'system' && /Integrity flag/.test(m.text))).toBe(false)
  }, 240_000)

  it('Dispute: the bot accepts an agreed redo, redelivers exactly the agreed leads, and the job settles with one capture', async () => {
    const job = await disputedLeadJob('redo')
    const { target } = await mediationOf(job, 'redo')
    const redoUnits: string[] = target.terms.redo.units
    expect(redoUnits).toHaveLength(20)
    expect(target.terms).toMatchObject({ release_now: '8.00', refund_now: '0.00' })
    expect(target.terms.redo.amount_on_success).toBe('2.00')
    await call(buyer, 'respond_to_proposal', { job_id: job, proposal_id: target.id, answer: 'accept' })
    const done = await settled(job)
    expect(done.job.mediation.status).toBe('agreed')
    expect(done.job.mediation.agreed_proposal_id).toBe(target.id)
    const room = (await call(buyer, 'get_messages', { job_id: job })).messages as J[]
    const deliveries = room.filter((m) => m.type === 'delivery')
    expect(deliveries).toHaveLength(2)
    const redelivered = deliveries[1]!.body.delivery.deliverables[0].units.map((u: J) => u.ref).sort()
    expect(redelivered).toEqual([...redoUnits].sort()) // exactly the agreed units, nothing else
    // The agreed checks passed on the redo units (the bot now honestly reports them as not verified, which the platform confirms): the held $2.00 is earned.
    expect(done.job.fulfilment[0]).toMatchObject({ passed_units: LEADS, failed_units: 0 })
    const e = (await call(buyer, 'get_escrow', { job_id: job })).escrow
    expect(e.events.filter((x: J) => x.kind === 'captured')).toHaveLength(1)
    expect(e.events.filter((x: J) => x.kind === 'payout_sent')).toHaveLength(1)
    expect(e.captured.value).toBe('10.00')
    expect(e.voided.value).toBe('0.00')
    expect(Number(e.paid_out.value)).toBeCloseTo((1000 - commission(1000)) / 100, 2)
  }, 240_000)

  it('keeps keys out of the logs and used only next_actions-driven operations', () => {
    const text = JSON.stringify(log.entries)
    expect(text).not.toContain(operatorKey)
    const actions = new Set(log.entries.map((e) => e.action))
    for (const a of ['submit_requirements', 'send_quote', 'accept_contract', 'submit_delivery', 'upload_artifact']) expect(actions.has(a)).toBe(true)
  })
})
