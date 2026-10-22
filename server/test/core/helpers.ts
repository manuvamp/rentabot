// Test harness: a real core (simulated rail, in-memory SQLite, temp DATA_DIR, fake clock, fake
// intelligence) plus a `call` that validates inputs AND outputs against the shared zod schemas,
// exactly like the adapters do.
import { opByName, type JobSpec, type OpName, type OpOutput } from '@rentabot/shared'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type CoreImpl } from '../../src/core/index.ts'
import { OpError, type OpContext, type Principal } from '../../src/core/types.ts'
import { fakeIntelligence, type MediatorScript } from '../fakes/intelligence.ts'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export interface Harness {
  core: CoreImpl
  intel: ReturnType<typeof fakeIntelligence>
  clock: { t: number; advance(ms: number): void }
  dataDir: string
  buyer: Principal
  seller: Principal
  stranger: Principal
  bots: Record<string, string>
  keys: { orano_growth_agent: { agent_id: string; api_key: string; mandate_id: string }; glob_studio_bots: { agent_id: string; api_key: string } }
  call<N extends OpName>(name: N, who: Principal, input: Record<string, unknown>): Promise<OpOutput<N>>
  fails(name: OpName, who: Principal, input: Record<string, unknown>): Promise<OpError>
  settle(): Promise<void>
  tick(): Promise<void>
  close(): Promise<void>
}

export async function harness(opts: { mediator?: MediatorScript; captureStatus?: 'COMPLETED' | 'PENDING'; dropWebhooks?: boolean; confident?: boolean; fetch?: typeof fetch; config?: Record<string, unknown>; /** SQLite file (default in-memory). */ dbFile?: string } = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rab-core-'))
  const clock = { t: Date.parse('2026-11-02T10:00:00.000Z'), advance(ms: number) { this.t += ms } }
  const intel = fakeIntelligence({ mediator: opts.mediator, now: () => new Date(clock.t), ...(opts.confident !== undefined ? { confident: opts.confident } : {}) })
  const core = await createCore({
    intelligence: intel,
    config: { dataDir, tickMs: 0, demoMode: false, rail: 'simulated', sealKey: 'a'.repeat(64), publicUrl: 'http://test.local', paypal: { clientId: '', clientSecret: '', webhookId: '', env: 'sandbox' }, ...opts.config },
    dbFile: opts.dbFile === undefined ? ':memory:' : opts.dbFile === '' ? join(dataDir, 'rentabot.db') : opts.dbFile,
    now: () => new Date(clock.t),
    simulated: { webhookDelayMs: 1, captureStatus: opts.captureStatus, dropWebhooks: opts.dropWebhooks },
    fetch: opts.fetch,
  })
  const keys = JSON.parse(readFileSync(join(dataDir, 'demo-keys.json'), 'utf8'))
  const buyer: Principal = { kind: 'agent', agent_id: keys.orano_growth_agent.agent_id, owner_id: null }
  const seller: Principal = { kind: 'agent', agent_id: keys.glob_studio_bots.agent_id, owner_id: null }
  const reg = await core.handlers.register_agent(ctx({ kind: 'public' }), { name: 'Stranger Bot' })
  const stranger: Principal = { kind: 'agent', agent_id: reg.agent.id, owner_id: null }
  const h: Harness = {
    core,
    intel,
    clock,
    dataDir,
    buyer,
    seller,
    stranger,
    bots: keys.bots,
    keys,
    async call(name, who, input) {
      const def = opByName[name]
      const parsed = def.input.parse(input)
      const out = await (core.handlers[name] as (c: OpContext, i: unknown) => Promise<unknown>)(ctx(who), parsed)
      return def.output.parse(out) as never
    },
    async fails(name, who, input) {
      try {
        await h.call(name, who, input)
      } catch (e) {
        if (e instanceof OpError) return e
        throw e
      }
      throw new Error(`${name} was expected to fail`)
    },
    settle: () => core.internal.drain(),
    async tick() {
      await core.internal.tick()
      await core.internal.drain()
    },
    async close() {
      await core.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return h
}

let n = 0
export const ctx = (principal: Principal): OpContext => ({ principal, surface: 'rest', request_id: `req-${++n}` })

export function directorySpec(quantity = 4, deadline = '2026-11-09T10:00:00.000Z'): JobSpec {
  return {
    skill_id: 'directory_submission',
    goal: 'Get ORANO listed on AI and productivity directories before launch.',
    deliverables: [
      {
        id: 'D1',
        description: `${quantity} live directory listings for ORANO`,
        quantity,
        acceptance: [{ check: 'url_live', params: {} }, { check: 'page_mentions', params: { must_include: ['ORANO'] } }, { check: 'artifact_attached', params: {} }],
        rubric: '',
      },
    ],
    deadline,
    budget_cap: { value: '80.00', currency: 'USD' },
    out_of_scope: [],
    context: 'ORANO: oranoai.com',
    context_artifact_ids: [],
  }
}

export const quoteFor = (quantity: number, unit = '1.50') => ({
  lines: [{ deliverable_id: 'D1', model: 'per_unit', unit_price: unit, quantity, max_total: (Number(unit) * quantity).toFixed(2) }],
  total_max: { value: (Number(unit) * quantity).toFixed(2), currency: 'USD' },
  turnaround: 'P7D',
  excludes: [],
  valid_until: '2026-12-31T00:00:00.000Z',
})

export const requirements = {
  inputs_schema: { type: 'object', properties: { tagline_60: { type: 'string' } }, required: ['tagline_60'] },
  access: [{ id: 'A1', kind: 'inbox_verification', why: 'Directories email confirmation links', scope: 'read-only, label:verify', required: true }],
  assumptions: ['Free directories only'],
  questions: [{ id: 'Q1', text: 'Which founder name should appear?' }],
}

/** Open a job and negotiate it to AGREED (or stop earlier). */
export async function agreedJob(h: Harness, opts: { quantity?: number; unit?: string; bot?: string; deadline?: string; stopAt?: 'negotiating' } = {}) {
  const q = opts.quantity ?? 4
  const created = await h.call('create_job', h.buyer, { bot_id: opts.bot ?? h.bots['Directory Blaster'], spec: directorySpec(q, opts.deadline), idempotency_key: `create-${Math.random()}` })
  const job_id = created.job.id
  await h.call('submit_requirements', h.seller, { job_id, requirements })
  await h.call('send_quote', h.seller, { job_id, quote: quoteFor(q, opts.unit) })
  await h.call('provide_inputs', h.buyer, { job_id, answers: { Q1: 'Manu' }, inputs: { tagline_60: 'Save anything, act on it.' } })
  if (opts.stopAt === 'negotiating') return job_id
  const j = await h.call('get_job', h.seller, { job_id })
  await h.call('accept_contract', h.seller, { job_id, contract_hash: j.job.contract_hash })
  const r = await h.call('accept_contract', h.buyer, { job_id, contract_hash: j.job.contract_hash })
  if (r.job.state !== 'AGREED') throw new Error(`expected AGREED, got ${r.job.state}`)
  return job_id
}

export async function fundedJob(h: Harness, opts: Parameters<typeof agreedJob>[1] = {}) {
  const job_id = await agreedJob(h, opts)
  const r = await h.call('fund_job', h.buyer, { job_id, idempotency_key: `fund-${job_id}` })
  await h.settle()
  if (r.job.state !== 'IN_PROGRESS') throw new Error(`expected IN_PROGRESS, got ${r.job.state}`)
  return job_id
}

/** Units: meta drives the fake checks, e.g. { url_live: 'fail' }. */
export const units = (n: number, meta: (i: number) => Record<string, string | undefined> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ ref: `listing-${i + 1}`, url: `https://dir${i + 1}.example/orano`, artifact_ids: [], meta: meta(i) as Record<string, string> }))

export async function deliver(h: Harness, job_id: string, list: ReturnType<typeof units>) {
  return h.call('submit_delivery', h.seller, { job_id, delivery: { deliverables: [{ deliverable_id: 'D1', units: list, note: '' }], note: 'Done' } })
}
