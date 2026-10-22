// Test plumbing: a real Sandbox Web on a local port, the platform's own check library, a WorkTools stand-in,
// and small fixture web servers.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { targetAllowed, type AcceptanceTest, type AccessRequest, type Delivery, type JobSpec, type Message } from '@rentabot/shared'
import { NO_AI, type Ai } from '../src/ai.ts'
import { silentLogger } from '../src/log.ts'
import { RabError, type RabClient } from '../src/rab.ts'
import type { SealedSecret, SkillCard, WorkJob, WorkTools } from '../src/runtime.ts'
import { createCheckLibrary } from '../../server/src/intelligence/checks/library.ts'
import type { CheckContext, CheckLibrary } from '../../server/src/intelligence/types.ts'
import { registerHouseBotChecks } from '../../server/src/housebots/checks.ts'
import { registerSandbox } from '../../server/src/sandbox/index.ts'

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
}

export interface SandboxBox {
  origin: string
  sandboxUrl: string
  checks: CheckLibrary
  app: FastifyInstance
  dataDir: string
  close(): Promise<void>
}

/** Sandbox Web on a real port; `timeScale` 0.002 makes a nominal minute last 120 ms. */
export async function startSandbox(opts: { timeScale?: number; extraAllow?: string[] } = {}): Promise<SandboxBox> {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scratch-rentabot-bots-'))
  const checks = createCheckLibrary({ allowHosts: [`127.0.0.1:${port}`, ...(opts.extraAllow ?? [])] })
  registerHouseBotChecks(checks, { allowHosts: [`127.0.0.1:${port}`, ...(opts.extraAllow ?? [])] })
  const app = Fastify()
  await registerSandbox(app, { checks, publicUrl: origin, dataDir, timeScale: opts.timeScale ?? 0.002 })
  await app.listen({ port, host: '127.0.0.1' })
  return {
    origin,
    sandboxUrl: `${origin}/sandbox`,
    checks,
    app,
    dataDir,
    async close() {
      await app.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** A local fixture site. Handler gets (path, req) and returns [status, body, headers?]. Logs every request. */
export async function startSite(handler: (url: URL, req: http.IncomingMessage) => [number, string, Record<string, string>?]) {
  const hits: { path: string; ua: string }[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push({ path: url.pathname + url.search, ua: String(req.headers['user-agent'] ?? '') })
    const [status, body, headers] = handler(url, req)
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

export interface FakeTools extends WorkTools {
  uploads: { id: string; name: string; mime: string; text?: string }[]
  logs: { action: string; extra?: Record<string, unknown> }[]
  progressCalls: { percent: number; text: string }[]
  fake: FakeRab
}

export interface LoggedAction {
  action: string
  target: string
  access_id: string | null
  unit_ref: string | null
  external_ref: string | null
  count: number
  accepted: boolean
  /** Position among everything the fake platform saw (log_action, put_locker_item, send_message ...). */
  order: number
}
export interface Handover {
  deliverable_id: string
  unit_ref: string
  site: string
  label: string
  secret: { kind: string; url?: string; username?: string; password?: string; notes?: string }
  order: number
}

export interface FakeRabOptions {
  /** Consent of access A1 (what the contract would say). Omit for a contract without consent. */
  consent?: { actions?: string[]; max_total?: number; max_per_day?: number; targets?: string[] }
  state?: string
}

/**
 * The marketplace as the bots see it, enough for the acting bots: log_action with the real consent rules (actions, targets, caps; a
 * refusal is a RabError policy_blocked and is counted), the locker (handovers recorded, usage reported), and a Job Room
 * (send_message / get_messages, blocker -> BLOCKED, unblock -> IN_PROGRESS). `rejected` counts every refused log_action: a bot that
 * respects its caps leaves it at 0.
 */
export interface FakeRab extends RabClient {
  calls: { name: string; args: Record<string, unknown> }[]
  actions: LoggedAction[]
  handovers: Handover[]
  room: Message[]
  state: string
  rejected: number
  /** Everything the platform saw, in order: [kind, detail]. */
  timeline: [string, string][]
  /** A buyer message in the room (e.g. an approval via provide_inputs). */
  buyerInputs(inputs: Record<string, unknown>): void
  /** An access answer the bot reads from the locker: the platform room gets the secret_id message and the item is `available`. */
  share(access_id: string, secret: { kind: 'login'; url: string; username: string; password: string }): SealedSecret
}

export function fakeRab(opts: FakeRabOptions = {}): FakeRab {
  const calls: FakeRab['calls'] = []
  const actions: LoggedAction[] = []
  const handovers: Handover[] = []
  const room: Message[] = []
  const timeline: [string, string][] = []
  const rab: FakeRab = {
    url: 'http://fake.rab',
    calls,
    actions,
    handovers,
    room,
    state: opts.state ?? 'IN_PROGRESS',
    rejected: 0,
    timeline,
    getInstructions: () => undefined,
    close: async () => {},
    buyerInputs(inputs) {
      post('inputs', { kind: 'agent', id: 'buyer', role: 'buyer' }, 'Additional inputs', { inputs, supplemental: true })
    },
    share(access_id, secret) {
      return { access_id, label: 'inbox', value: JSON.stringify({ ...secret, notes: '' }) }
    },
    call: (async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args })
      switch (name) {
        case 'list_locker_items': {
          const accepted = actions.filter((a) => a.accepted)
          const max_total = opts.consent?.max_total ?? null
          const max_per_day = opts.consent?.max_per_day ?? null
          const used = accepted.reduce((n, a) => n + a.count, 0)
          return {
            items: handovers.map((h, i) => ({ id: `sec_fake${i}`, direction: 'handover', unit_ref: h.unit_ref, deliverable_id: h.deliverable_id, status: 'locked', kind: h.secret.kind, site: h.site, label: h.label })),
            consent: opts.consent ? [{ access_id: 'A1', kind: 'x', required: false, text: '', answered: false, usage: { access_id: 'A1', used_total: used, max_total, used_today: used, max_per_day } }] : [],
            actions,
            audit: [],
          }
        }
        case 'log_action': {
          const a = args as { action: string; target: string; access_id?: string; unit_ref?: string; external_ref?: string; count?: number }
          const count = a.count ?? 1
          const c = opts.consent
          const used = actions.filter((x) => x.accepted).reduce((n, x) => n + x.count, 0)
          let why = ''
          if (!c) why = `no access grant in the contract consents to ${a.action}`
          else if (!(c.actions ?? ['send_email', 'fill_form', 'create_account', 'browse']).includes(a.action)) why = `access ${a.access_id ?? 'A1'} has no consent for ${a.action}`
          else if (!targetAllowed(a.target, c.targets ?? [])) why = `${a.target} is not one of the consented targets`
          else if (c.max_total && used + count > c.max_total) why = `over the limit of ${c.max_total} (already ${used})`
          else if (c.max_per_day && used + count > c.max_per_day) why = `over the daily limit of ${c.max_per_day} (already ${used} in the last 24 hours)`
          const rec: LoggedAction = { action: a.action, target: a.target, access_id: a.access_id ?? null, unit_ref: a.unit_ref ?? null, external_ref: a.external_ref ?? null, count, accepted: !why, order: timeline.length }
          actions.push(rec)
          timeline.push(['action', `${a.action} ${a.target} ${a.external_ref ?? ''}`.trim()])
          if (why) {
            rab.rejected++
            throw new RabError('policy_blocked', `Not allowed by the buyer's consent: ${why}.`)
          }
          const total = used + count
          return { receipt: {}, usage: { access_id: a.access_id ?? 'A1', used_total: total, max_total: c?.max_total ?? null, used_today: total, max_per_day: c?.max_per_day ?? null } }
        }
        case 'list_encryption_keys':
          return { yours: [], buyer: [], seller: [] }
        case 'put_locker_item': {
          const a = args as { deliverable_id: string; unit_ref: string; label: string; site: string; secret: Handover['secret'] }
          handovers.push({ deliverable_id: a.deliverable_id, unit_ref: a.unit_ref, label: a.label, site: a.site, secret: a.secret, order: timeline.length })
          timeline.push(['handover', a.unit_ref])
          return { item: { id: `sec_fake${handovers.length - 1}`, status: 'locked' } }
        }
        case 'get_job':
          return { job: { state: rab.state }, your_role: 'seller', next_actions: [] }
        case 'send_message': {
          const a = args as { type: string; text: string; artifact_ids?: string[] }
          if (a.type === 'blocker') rab.state = 'BLOCKED'
          if (a.type === 'unblock') {
            if (rab.state !== 'BLOCKED') throw new RabError('invalid_state', 'The job is not blocked.')
            rab.state = 'IN_PROGRESS'
          }
          const m = post(a.type, { kind: 'agent', id: 'seller', role: 'seller' }, a.text, {}, a.artifact_ids ?? [])
          timeline.push(['message', a.type])
          return { message: m, job: { state: rab.state }, your_role: 'seller', next_actions: [] }
        }
        case 'get_messages': {
          const after = Number((args as { after_seq?: number }).after_seq ?? -1)
          return { messages: room.filter((m) => m.seq > after) }
        }
        default:
          throw new RabError('invalid_input', `fakeRab does not implement ${name}`)
      }
    }) as RabClient['call'],
  }
  function post(type: string, from: Message['from'], text: string, body: Record<string, unknown> = {}, artifact_ids: string[] = []): Message {
    const m = { id: `msg_${room.length}`, job_id: 'job_test000001', seq: room.length, from, type, text, body, artifact_ids, prev_hash: null, hash: 'x'.repeat(64), ts: new Date().toISOString() } as unknown as Message
    room.push(m)
    return m
  }
  return rab
}

/** A contract that carries the given access requests (and nothing else the acting bots read). */
export const contractWith = (access: AccessRequest[]): WorkJob['contract'] => ({ requirements: { inputs_schema: {}, access, assumptions: [], questions: [] } }) as never

/** The A1 access request as a bot's requirements() would write it, for tests that give a bot a contract. */
export const accessA1 = (kind: AccessRequest['kind'], consent?: { actions: string[]; max_total?: number; max_per_day?: number; targets: string[] }): AccessRequest => ({ id: 'A1', kind, why: 'test', scope: 'test', required: false, ...(consent ? { consent } : {}) }) as AccessRequest

export function fakeTools(ai: Ai = NO_AI, rabOpts?: FakeRabOptions): FakeTools {
  const uploads: FakeTools['uploads'] = []
  const logs: FakeTools['logs'] = []
  const progressCalls: FakeTools['progressCalls'] = []
  const fake = fakeRab(rabOpts)
  return {
    rab: fake,
    fake,
    ai,
    signal: new AbortController().signal,
    uploads,
    logs,
    progressCalls,
    log: (action, extra) => void logs.push({ action, extra }),
    progress: async (percent, text) => void progressCalls.push({ percent, text }),
    uploadArtifact: async (a) => {
      const id = `art_${String(uploads.length + 1).padStart(8, '0')}`
      uploads.push({ id, name: a.name, mime: a.mime, text: a.text })
      return id
    },
  }
}

const skill = (id: string, checks: string[]): SkillCard => ({ id, title: id, pricing: { model: 'per_unit', currency: 'USD', price: '1.50', unit: 'unit' }, turnaround: 'P7D', checks })

export function makeSpec(over: Partial<JobSpec> & { quantity?: number; acceptance?: AcceptanceTest[]; skill_id?: string } = {}): JobSpec {
  const { quantity = 3, acceptance = [{ check: 'artifact_attached', params: {} }], skill_id = 'x', ...rest } = over
  return {
    skill_id,
    goal: 'Do the thing for the product, honestly and politely.',
    deliverables: [{ id: 'D1', description: 'The units asked for', quantity, acceptance, rubric: '' }],
    deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    budget_cap: { value: '100.00', currency: 'USD' },
    out_of_scope: [],
    context: '',
    context_artifact_ids: [],
    ...rest,
  }
}

export function makeJob(spec: JobSpec, inputs: Record<string, unknown>, skillId = spec.skill_id, extra: Partial<WorkJob> = {}): WorkJob {
  return { id: 'job_test000001', job: {} as never, spec, contract: null, inputs, answers: {}, secrets: [], skill: skill(skillId, []), cure: null, attempt: 1, ...extra }
}

/** Run the contract's acceptance tests the way the platform does, over a delivery; returns pass/fail per unit and check. */
export async function runAcceptance(lib: CheckLibrary, spec: JobSpec, delivery: Delivery, tools: FakeTools, inputs: Record<string, unknown> = {}, attempt = 1) {
  const results: { deliverable: string; unit: string; check: string; status: string; detail: string }[] = []
  for (const d of delivery.deliverables) {
    const def = spec.deliverables.find((x) => x.id === d.deliverable_id)!
    for (const unit of d.units)
      for (const test of def.acceptance) {
        const ctx: CheckContext = {
          job_id: 'job_test000001',
          contract: { inputs } as never,
          deliverable_id: d.deliverable_id,
          unit,
          test,
          attempt,
          artifact: async (id) => {
            const u = tools.uploads.find((x) => x.id === id)
            return u ? { meta: { id, name: u.name, mime: u.mime, bytes: (u.text ?? '').length } as never, bytes: new TextEncoder().encode(u.text ?? '') } : null
          },
          saveEvidence: async () => 'ev_test',
        }
        const r = await lib.get(test.check)!.run(ctx)
        results.push({ deliverable: d.deliverable_id, unit: unit.ref, check: test.check, status: r.status, detail: r.detail })
      }
  }
  return results
}

/** Units that passed every acceptance test. */
export const passedUnits = (results: Awaited<ReturnType<typeof runAcceptance>>) => {
  const refs = [...new Set(results.map((r) => r.unit))]
  return refs.filter((u) => results.filter((r) => r.unit === u).every((r) => r.status === 'pass'))
}

export { NO_AI, silentLogger }
