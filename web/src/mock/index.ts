// In-browser fake API (VITE_MOCK=1). Patches window.fetch for /api/* so every page works without the server.
import { z } from 'zod'
import { OPS } from '@rentabot/shared'
import { eventLog } from './bus'
import type { Db, Persona } from './db'
import { IDS } from './db'
import { fail, MockError, type Caller } from './logic'
import { registerReadOps } from './ops-read'
import { registerWriteOps } from './ops-write'
import { registerOpenJobOps } from './ops-open'
import { handlers } from './registry'
import { seedDb } from './seed'
import { cents } from './util'

const PERSONA_KEY = 'rab_mock_persona'
let db: Db

export const getDb = () => db

function persona(): Persona | null {
  try {
    return (localStorage.getItem(PERSONA_KEY) as Persona | null) ?? null
  } catch {
    return null
  }
}

function callerFor(headers: Headers): Caller {
  const p = persona()
  const user = p ? (Object.values(db.users).find((u) => u.role === p) ?? null) : null
  let agent_id = user?.agent_id ?? null
  const act = headers.get('X-Act-As')
  if (act && user && db.agents[act]?.owner_id === user.id) agent_id = act
  return { user, agent_id }
}

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function coerce(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v) && !v.startsWith('0')) return Number(v)
  return v
}

function opsMeta() {
  return {
    ops: OPS.map((o) => ({
      name: o.name,
      title: o.title,
      description: o.description,
      toolset: o.toolset,
      caller: o.caller,
      surfaces: o.surfaces,
      annotations: o.annotations,
      input_schema: z.toJSONSchema(o.input, { io: 'input', unrepresentable: 'any' }),
      output_schema: z.toJSONSchema(o.output, { io: 'output', unrepresentable: 'any' }),
    })),
  }
}

function stats() {
  const jobs = Object.values(db.jobs)
  const sum = (f: (j: (typeof jobs)[number]) => string) => jobs.reduce((a, j) => a + cents(f(j)), 0)
  return {
    bots: Object.values(db.bots).filter((b) => b.status === 'listed').length,
    jobs_total: 124 + jobs.length,
    jobs_settled: 96 + jobs.filter((j) => j.state === 'SETTLED').length,
    units_verified: 3381 + jobs.reduce((a, j) => a + j.fulfilment.reduce((x, f) => x + f.passed_units, 0), 0),
    escrow_held: ((184000 + jobs.reduce((a, j) => a + Math.max(cents(j.escrow.authorized.value) - cents(j.escrow.captured.value) - cents(j.escrow.voided.value) - cents(j.escrow.refunded.value), 0), 0)) / 100).toFixed(2),
    paid_out: ((520165 + sum((j) => j.escrow.paid_out.value)) / 100).toFixed(2),
    voided: ((61125 + sum((j) => j.escrow.voided.value)) / 100).toFixed(2),
    disputes_ruled: 8 + jobs.filter((j) => j.ruling).length,
    payment_rail: db.rail,
  }
}

const SEED_FEED = [
  ['escrow', 'Lead Verifier: 212 leads re-checked, $21.20 authorized', 9],
  ['ruling', 'Ruling issued: remaining $13.50 voided, injection attempt flagged', 14],
  ['escrow', 'Agent-Readiness Auditor signed a contract, $9.00 authorized, not taken', 26],
  ['escrow', 'Cold Email Writer: 48 emails passed the linter, $24.00 captured', 41],
  ['message', 'Investor Outreach Bot quoted 60 verified leads for $36.00', 58],
  ['bot', 'New agent registered, claim link sent, spending locked until approved', 77],
  ['ruling', 'Arbiter confirmed a ruling: $46.50 released, $13.50 voided', 95],
] as const

function feed(limit: number) {
  const live = eventLog()
    .slice(-limit)
    .reverse()
    .map((e) => ({ cursor: e.cursor, type: e.type, summary: e.summary, ts: e.ts, job_id: e.job_id }))
  const seeded = SEED_FEED.map(([type, summary, mins], i) => ({ cursor: i, type, summary, ts: new Date(Date.now() - mins * 60_000).toISOString(), job_id: null }))
  return { events: [...live, ...seeded].slice(0, limit) }
}

async function route(url: URL, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  const path = url.pathname
  const body = init?.body && typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  await wait(60 + Math.random() * 120)
  const caller = callerFor(headers)

  if (path === '/api/meta/ops') return json(200, opsMeta())
  if (path === '/api/public/stats') return json(200, stats())
  if (path === '/api/public/feed') return json(200, feed(Number(url.searchParams.get('limit') ?? 20)))

  if (path === '/api/session' && method === 'GET') {
    const u = caller.user
    if (!u) return json(200, { user: null, agents: [] })
    const agents = Object.values(db.agents).filter((a) => a.owner_id === u.id)
    return json(200, { user: { id: u.id, name: u.name, role: u.role, email: u.email }, agents })
  }
  if (path === '/api/session/demo' && method === 'POST') {
    const p = body.persona as Persona
    if (!['owner', 'arbiter', 'seller'].includes(p)) return json(400, { error: { code: 'invalid_input', message: 'Unknown persona.', hint: 'Use owner, arbiter or seller.', next_actions: [] } })
    localStorage.setItem(PERSONA_KEY, p)
    return json(200, { ok: true })
  }
  if (path === '/api/session/logout') {
    localStorage.removeItem(PERSONA_KEY)
    return json(200, { ok: true })
  }

  const art = /^\/api\/artifacts\/([^/]+)$/.exec(path)
  if (art) {
    const a = db.artifacts[art[1]]
    return a ? json(200, a) : json(404, { error: { code: 'not_found', message: 'No such artifact.', hint: '', next_actions: [] } })
  }

  const sim = /^\/api\/sim\/paypal\/([^/]+)\/([^/]+)$/.exec(path)
  if (sim && method === 'GET') return run('__sim_paypal_info', { kind: sim[1], id: sim[2] }, caller)
  if (path === '/api/sim/paypal/approve' && method === 'POST') return run('__sim_paypal_approve', body, caller)

  const op = /^\/api\/ops\/([a-z_]+)$/.exec(path)
  if (op) {
    const input = method === 'GET' ? Object.fromEntries([...url.searchParams].map(([k, v]) => [k, coerce(v)])) : body
    return run(op[1], input, caller)
  }
  return json(404, { error: { code: 'not_found', message: `No mock route for ${method} ${path}.`, hint: '', next_actions: [] } })
}

async function run(name: string, input: unknown, caller: Caller): Promise<Response> {
  const h = handlers[name]
  if (!h) return json(404, { error: { code: 'not_found', message: `Mock does not implement ${name} yet.`, hint: 'Run against the real server (npm run dev) for this operation.', next_actions: [] } })
  try {
    const out = await h(input ?? {}, { db, caller })
    // dev aid: warn when a handler returns something the shared schema would reject
    const def = OPS.find((o) => o.name === name)
    if (def) {
      const r = def.output.safeParse(out)
      if (!r.success) console.warn('[mock] output does not match the shared schema for', name, r.error.issues.slice(0, 3))
    }
    return json(200, out)
  } catch (e) {
    if (e instanceof MockError) return json(e.status, { error: { code: e.code, message: e.message, hint: e.hint, next_actions: e.next_actions } })
    console.error('[mock]', name, e)
    return json(500, { error: { code: 'internal', message: e instanceof Error ? e.message : 'Mock handler crashed.', hint: 'This is the in-browser mock. Check the console.', next_actions: [] } })
  }
}

export function installMock() {
  db = seedDb()
  registerReadOps()
  registerWriteOps()
  registerOpenJobOps()
  const real = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, window.location.origin)
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) return route(url, init)
    return real(input, init)
  }
  // handy in the console while demoing: window.__mockDb
  ;(window as unknown as { __mockDb: Db }).__mockDb = db
  console.info('%cRent-A-Bot mock API active', 'color:#FFD84D;font-weight:bold', 'persona:', persona(), 'ids:', IDS)
}

export { fail }
