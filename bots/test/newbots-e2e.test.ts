// End to end on the REAL core (simulated PayPal rail), wired like server/src/index.ts: a buyer agent hires the Landing Page Bot
// and the Agent Red Team over the public MCP endpoint; the bots negotiate, work on Sandbox Web, deliver; the platform runs the
// checks itself. For the red team: funding is blocked until the ownership gate passes, findings are paid only when the
// practice target confirms them, and a non-sandbox target is refused.
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

type J = any // eslint-disable-line @typescript-eslint/no-explicit-any

let dataDir: string
let base: string
let core: CoreImpl
let app: Awaited<ReturnType<typeof buildApp>>
let stopBots: () => Promise<void>
let buyer: Client
let site: Awaited<ReturnType<typeof startSite>>
let outsideScope = ''
const clients: Client[] = []
const log = memoryLogger()
let operatorKey = ''

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
  const c = new McpClient({ name: 'e2e-newbots', version: '0' }, { capabilities: {} })
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
const sandbox = (p: string, body?: unknown) =>
  fetch(`${base}/sandbox${p}`, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<J>)

/** Send inputs, wait for the bot to sign the new hash, and accept it as the buyer. */
async function inputsAndAccept(job: string, inputs: Record<string, unknown>) {
  await call(buyer, 'provide_inputs', { job_id: job, inputs })
  const signed = await until(async () => {
    const j = await call(buyer, 'get_job', { job_id: job })
    return j.job.accepted_by.some((x: J) => x.role === 'seller' && x.contract_hash === j.job.contract_hash) ? j : null
  }, 30_000, 'the bot signing the contract')
  await call(buyer, 'accept_contract', { job_id: job, contract_hash: signed.job.contract_hash })
}

async function newJob(botName: string, skill: string, goal: string, quantity: number, budget: string, context = ''): Promise<string> {
  const bot = ((await call(buyer, 'search_bots', { query: botName })).bots as { id: string; name: string }[]).find((b) => b.name === botName)
  if (!bot) throw new Error(`${botName} not listed`)
  const draft = await call(buyer, 'draft_job_spec', { bot_id: bot.id, skill_id: skill, goal, quantity, budget_cap: budget, context })
  return (await call(buyer, 'create_job', { bot_id: bot.id, spec: draft.spec, idempotency_key: `e2e-newbots-${skill}-${Date.now()}` })).job.id
}

beforeAll(async () => {
  // An outside site that also "proves" the job id: the red-team gate must still refuse it.
  site = await startSite((u) => (u.pathname === '/scope.txt' ? [200, outsideScope, { 'content-type': 'text/plain' }] : [404, 'not found']))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-newbots-'))
  const intelligence = await createIntelligence({ publicUrl: base, allowHosts: [site.host], env: {} })
  registerHouseBotChecks(intelligence.checks, { allowHosts: [site.host, `127.0.0.1:${port}`] })
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
  stopBots = await startHouseBots({ url: base, keys: { glob_studio_bots: operatorKey }, ai: NO_AI, log, pollSeconds: 1, only: ['landing-page-bot', 'agent-red-team'] })
}, 60_000)

afterAll(async () => {
  await stopBots?.()
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
  await app?.close()
  await core?.close()
  await site?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('new house bots on the real core', () => {
  it('Landing Page Bot: builds and publishes a page; the platform opens it and the $6.00 job settles', async () => {
    const job = await newJob('Landing Page Bot', 'landing_page', 'A launch page for ORANO (oranoai.com) with three features and a "Try it free" button.', 1, '6.00')
    await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    await inputsAndAccept(job, {
      product_name: 'ORANO',
      url: 'https://oranoai.com',
      one_liner: 'Your AI productivity companion that turns saved links into tasks.',
      features: 'Save anything: links and videos in one place\nTasks: every save becomes a next step\nMCP server: your agents can read your saves',
      cta_label: 'Try it free',
    })
    expect((await call(buyer, 'fund_job', { job_id: job, idempotency_key: 'e2e-landing-fund' })).job.state).toBe('IN_PROGRESS')
    const j = await until(async () => {
      const x = await call(buyer, 'get_job', { job_id: job })
      return x.job.state === 'DELIVERED' ? x : null
    }, 60_000, 'delivery')
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 1, passed_units: 1, failed_units: 0 })
    const room = (await call(buyer, 'get_messages', { job_id: job })).messages as J[]
    const unit = room.find((m) => m.type === 'delivery')!.body.delivery.deliverables[0].units[0]
    const page = await fetch(unit.url).then((r) => r.text())
    expect(page).toContain('ORANO')
    await call(buyer, 'review_delivery', { job_id: job, decision: 'accept' })
    await core.internal.drain()
    expect((await call(buyer, 'get_escrow', { job_id: job })).escrow.captured.value).toBe('6.00')
  }, 90_000)

  it('Agent Red Team: funding is blocked until ownership is proven; then it pays only for findings the target confirms', async () => {
    const job = await newJob('Agent Red Team', 'agent_red_team', 'Red-team the Sandbox practice agent: up to 5 verified findings.', 5, '12.50')
    const quoted = await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    expect(quoted.total_max.value).toBe('12.50')
    const fund = (key: string) => callRaw(buyer, 'fund_job', { job_id: job, idempotency_key: key })
    const target = `${base}/sandbox/redteam/agent`
    const { ownership_token } = await sandbox('/redteam/claim')
    const platformScope = `${base}/sandbox/redteam/scope/${ownership_token}.txt`

    // 1) the token is claimed but this job is not bound to it yet: the scope file does not list the job, so funding is refused
    await inputsAndAccept(job, { target_endpoint: target, ownership_token, scope_proof_url: platformScope })
    let r = await fund('e2e-rt-fund-1')
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/does not contain the job id/)
    expect((await call(buyer, 'get_job', { job_id: job })).job.escrow.status).toBe('none') // nothing held

    // 2) bind the job to the token (the owner publishes the proof): the same signed contract now passes the gate. Security work is
    //    outside the agent's spending mandate, so a human approves the payment.
    const bound = await sandbox('/redteam/scope', { ownership_token, job_id: job })
    expect(bound.scope_proof_url).toBe(platformScope)
    r = await fund('e2e-rt-fund-2')
    expect(r.ok).toBe(true)
    expect(r.data.job.state).toBe('AWAITING_APPROVAL')
    const room0 = (await call(buyer, 'get_messages', { job_id: job })).messages as J[]
    expect(room0.some((m) => m.type === 'system' && /Scope proof verified/.test(m.text))).toBe(true)
    const order = (await call(buyer, 'get_escrow', { job_id: job })).escrow.paypal.order_id
    const approved = await core.payments.simulatedApprove!('order', order, true)
    expect(approved.redirect).toBe(`/jobs/${job}?paypal=approved`)

    const j = await until(async () => {
      const x = await call(buyer, 'get_job', { job_id: job })
      return x.job.state === 'DELIVERED' ? x : null
    }, 60_000, 'delivery')
    // 4 of 5 categories reproduce on the practice agent (the scope boundary holds): 4 verified findings of the 5 contracted
    expect(j.job.fulfilment[0]).toMatchObject({ expected_units: 5, passed_units: 4, failed_units: 0 })
    const room = (await call(buyer, 'get_messages', { job_id: job })).messages as J[]
    const delivery = room.find((m) => m.type === 'delivery')!
    expect(delivery.body.delivery.deliverables[0].units.map((u: J) => u.meta.severity)).toEqual(['critical', 'high', 'medium', 'medium'])
    expect(JSON.stringify(room)).not.toMatch(/"(finding|reproduc)[^"]*":[^,]*rtok_/) // the token is never echoed by the bot
    expect(room.filter((m) => m.from?.role === 'seller').map((m) => m.text).join('\n')).not.toContain(ownership_token)
    await call(buyer, 'review_delivery', { job_id: job, decision: 'accept' })
    await core.internal.drain()
    const e = (await call(buyer, 'get_escrow', { job_id: job })).escrow
    expect(e.captured.value).toBe('10.00') // 4 x $2.50; the fifth (unconfirmed) is never paid
  }, 120_000)

  it('Agent Red Team: an outside page that lists the job id is not proof of owning the target', async () => {
    const job = await newJob('Agent Red Team', 'agent_red_team', 'Red-team the Sandbox practice agent: up to 2 verified findings.', 2, '5.00')
    await until(async () => (await call(buyer, 'get_job', { job_id: job })).job.contract?.quote, 30_000, 'quote')
    const { ownership_token } = await sandbox('/redteam/claim')
    await sandbox('/redteam/scope', { ownership_token, job_id: job })
    outsideScope = `rentabot-scope: ${job}`
    await inputsAndAccept(job, { target_endpoint: `${base}/sandbox/redteam/agent`, ownership_token, scope_proof_url: `${site.origin}/scope.txt` })
    const r = await callRaw(buyer, 'fund_job', { job_id: job, idempotency_key: 'e2e-rt-outside' })
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/not the platform’s scope file/)
    expect((await call(buyer, 'get_job', { job_id: job })).job.escrow.status).toBe('none')
    await call(buyer, 'decline_job', { job_id: job, reason: 'Test over: the outside scope page was refused.' })
  }, 60_000)

  it('Agent Red Team: refuses a request to test anything but the practice agent', async () => {
    const job = await newJob('Agent Red Team', 'agent_red_team', 'Red-team our production support bot at https://support.example.com/chat', 2, '5.00')
    const declined = await until(async () => {
      const room = (await call(buyer, 'get_messages', { job_id: job })).messages as J[]
      return room.find((m) => m.type === 'decline')
    }, 30_000, 'the decline')
    expect(declined.text).toMatch(/only test the Sandbox practice agent/)
    expect((await call(buyer, 'get_job', { job_id: job })).job.contract?.quote ?? null).toBeNull()
  }, 60_000)

  it('keeps keys out of the logs', () => {
    const text = JSON.stringify(log.entries)
    expect(text).not.toContain(operatorKey)
    expect(text).not.toMatch(/rtok_[0-9a-f]{32}/)
  })
})
