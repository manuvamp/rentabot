// Shared plumbing for the core services: storage of job records, rendering the public Job,
// role resolution, state changes (only along machine.TRANSITIONS), room + event publishing,
// per-job locks and the clock.
import { Contract, TERMINAL_STATES, type Agent, type BotCard, type Job, type JobState, type Message, type MessageType, type Role } from '@rentabot/shared'
import type { AppConfig } from '../config.ts'
import { scaleMs } from '../config.ts'
import { json, type Db } from '../db/index.ts'
import type { Intelligence } from '../intelligence/types.ts'
import type { PaymentRail } from '../rails/types.ts'
import { EventBus, type Audience } from './events.ts'
import type { FeePolicy } from './fees.ts'
import { canTransition, nextActions, type MachineView } from './machine.ts'
import { emptyRequirements, heldCents, type JobRecord } from './model.ts'
import { PLATFORM, Room, type From } from './room.ts'
import { OpError, type Principal } from './types.ts'
import { durationMs, hashCanonical, toAmount, toCents, usd } from './util.ts'

/** A proposal's terms in one line, for next_actions and logs. */
export function termsSummary(t: { release_now: string; refund_now: string; redo: { units: string[]; deliverable_id: string; amount_on_success: string } | null; wait_until: string | null; cancel: boolean }): string {
  const parts = [`release $${t.release_now} to the seller`, `refund $${t.refund_now} to the buyer`]
  if (t.redo) parts.push(`$${t.redo.amount_on_success} held for ${t.redo.units.length} unit(s) of ${t.redo.deliverable_id} to be redone`)
  if (t.wait_until) parts.push(`rest held until ${t.wait_until}`)
  if (t.cancel) parts.push('job closes')
  return parts.join(', ')
}

/** Who is acting, resolved from a Principal. */
export interface Actor {
  principal: Principal
  /** The agent this caller acts as (agent principals: itself; people: act_as). */
  agent_id: string
  /** Every agent this caller may act for (a person may act for any agent they own). */
  agents: Set<string>
  user_id: string | null
  isArbiter: boolean
  key: string // idempotency principal key
}

export class Domain {
  readonly db: Db
  readonly cfg: AppConfig
  readonly room: Room
  readonly bus: EventBus
  readonly intel: Intelligence
  rail: PaymentRail
  readonly clock: () => Date
  private locks = new Map<string, Promise<unknown>>()
  /** Background work (mediation steps, delayed webhooks) tests can await. */
  readonly background = new Set<Promise<unknown>>()

  constructor(db: Db, cfg: AppConfig, intel: Intelligence, rail: PaymentRail, clock: () => Date) {
    this.db = db
    this.cfg = cfg
    this.intel = intel
    this.rail = rail
    this.clock = clock
    this.room = new Room(db, clock)
    this.bus = new EventBus(db, (u, a) => this.agentsOfUser(u, a), clock)
  }

  nowMs = () => this.clock().getTime()
  nowIso = () => this.clock().toISOString()
  /** A contract duration in wall-clock ms, scaled in demo mode. */
  dur = (iso: string) => scaleMs(this.cfg, durationMs(iso))
  /** PayPal's own limits (3-day honor, 29-day validity): real time on PayPal, scaled on the simulated rail in demo mode. */
  railMs = (ms: number) => (this.rail.kind === 'simulated' ? scaleMs(this.cfg, ms) : ms)

  // ---------- locks ----------
  /** Serialize everything that touches one job (ops, webhooks, timers), across awaits. */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const chained = prev.then(() => mine)
    this.locks.set(key, chained)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === chained) this.locks.delete(key)
    }
  }
  track<T>(p: Promise<T>): Promise<T> {
    const t = p.catch((e) => console.error('[core] background task failed:', e instanceof Error ? e.message : e)).finally(() => this.background.delete(t))
    this.background.add(t)
    return p
  }

  // ---------- agents, users, bots ----------
  agent(id: string): Agent | null {
    const r = this.db.get<{ data: string }>('SELECT data FROM agents WHERE id = ?', id)
    return r ? json<Agent>(r.data) : null
  }
  agentsOfUser(userId: string, actAs: string): string[] {
    const own = this.db.all<{ id: string }>('SELECT id FROM agents WHERE owner_id = ?', userId).map((r) => r.id)
    return [...new Set([actAs, ...own])]
  }
  bot(id: string): BotCard | null {
    const r = this.db.get<{ data: string }>('SELECT data FROM bots WHERE id = ?', id)
    return r ? json<BotCard>(r.data) : null
  }

  actor(p: Principal): Actor {
    if (p.kind === 'agent') return { principal: p, agent_id: p.agent_id, agents: new Set([p.agent_id]), user_id: null, isArbiter: false, key: `agent:${p.agent_id}` }
    if (p.kind === 'user') {
      const a = this.agent(p.act_as)
      if (!a || a.owner_id !== p.user_id) throw new OpError('forbidden', 'You can only act through an agent you own.', 'Sign in again or pick one of your own agents.')
      return { principal: p, agent_id: p.act_as, agents: new Set(this.agentsOfUser(p.user_id, p.act_as)), user_id: p.user_id, isArbiter: p.roles.includes('arbiter'), key: `user:${p.user_id}` }
    }
    throw new OpError('unauthenticated', 'This operation needs an API key or a signed-in person.', 'Call register_agent to get an API key, then send it as a Bearer token.')
  }

  /** The caller's role in a job, or null when they are not a party (arbiters read everything). */
  roleIn(rec: JobRecord, a: Actor): Role | null {
    const buyer = a.agents.has(rec.buyer_agent_id)
    const seller = a.agents.has(rec.seller_agent_id)
    if (buyer && seller) return a.agent_id === rec.seller_agent_id ? 'seller' : 'buyer'
    if (buyer) return 'buyer'
    if (seller) return 'seller'
    if (a.isArbiter) return 'arbiter'
    return null
  }
  from(a: Actor, role: Role): From {
    return a.user_id ? { kind: 'user', id: a.user_id, role } : { kind: 'agent', id: a.agent_id, role }
  }
  agentFor(rec: JobRecord, role: Role) {
    return role === 'buyer' ? rec.buyer_agent_id : rec.seller_agent_id
  }

  // ---------- job records ----------
  load(id: string): JobRecord {
    const r = this.db.get<{ data: string }>('SELECT data FROM jobs WHERE id = ?', id)
    if (!r) throw new OpError('not_found', `Job ${id} not found.`, 'Check the job_id; list_jobs shows your jobs.')
    return this.upgrade(json<JobRecord>(r.data))
  }
  tryLoad(id: string): JobRecord | null {
    const r = this.db.get<{ data: string }>('SELECT data FROM jobs WHERE id = ?', id)
    return r ? this.upgrade(json<JobRecord>(r.data)) : null
  }
  /** Records saved before negotiation-first mediation: add the new fields; a case that was open starts mediation again. */
  private upgrade(rec: JobRecord): JobRecord {
    const f = rec.fees as Partial<JobRecord['fees']>
    if (f.floor === undefined || f.min_settlement === undefined) {
      const p = rec.fee_policy ?? this.cfg.fees
      rec.fees = { platform_bps: f.platform_bps ?? p.commission_bps, mediation_flat: f.mediation_flat ?? this.cfg.mediationFlat, floor: toAmount(p.floor_cents), min_settlement: toAmount(p.min_settlement_cents) }
    }
    rec.amendments ??= []
    rec.agreement ??= null
    const m = rec.mediation as (JobRecord['mediation'] & { status?: string }) | null
    if (m && !m.state) {
      rec.mediation = { opened_by: m.opened_by, reason: m.reason, claims: m.claims, opened_at: m.opened_at, closed_at: null, released_cents: rec.escrow.seller_release, questions: [], answer_until: null, state: { status: 'investigating', round: 0, deadline: null, assessment: null, proposals: [], agreed_proposal_id: null } }
    }
    if (rec.mediation && rec.mediation.released_cents === undefined) rec.mediation.released_cents = rec.escrow.seller_release
    return rec
  }
  /** The fee policy frozen into this job's contract (commission, floor, minimum settlement) plus the platform's PayPal cost estimates. */
  feePolicy(rec: JobRecord): FeePolicy {
    return { ...this.cfg.fees, commission_bps: rec.fees.platform_bps, floor_cents: toCents(rec.fees.floor), min_settlement_cents: toCents(rec.fees.min_settlement) }
  }
  save(rec: JobRecord) {
    rec.updated_at = this.nowIso()
    this.db.run(
      `INSERT INTO jobs (id, state, buyer_agent_id, seller_agent_id, seller_bot_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
      rec.id,
      rec.state,
      rec.buyer_agent_id,
      rec.seller_agent_id,
      rec.seller_bot_id,
      JSON.stringify(rec),
      rec.created_at,
      rec.updated_at,
    )
  }
  openJobIds(): string[] {
    return this.db.all<{ id: string }>(`SELECT id FROM jobs WHERE state NOT IN (${TERMINAL_STATES.map(() => '?').join(',')})`, ...TERMINAL_STATES).map((r) => r.id)
  }

  // ---------- contract ----------
  buildContract(rec: JobRecord): Contract | null {
    if (!rec.quote) return null
    return Contract.parse({
      job_id: rec.id,
      version: rec.version,
      buyer_agent_id: rec.buyer_agent_id,
      seller_bot_id: rec.seller_bot_id,
      seller_agent_id: rec.seller_agent_id,
      spec: rec.spec,
      requirements: rec.requirements ?? emptyRequirements(),
      answers: rec.answers,
      inputs: rec.inputs,
      quote: rec.quote,
      timers: rec.timers,
      fees: rec.fees,
      amendments: rec.amendments,
    })
  }
  /** Hash of the contract content without its version: decides whether a change is real. */
  private contentHash(rec: JobRecord) {
    return hashCanonical({ spec: rec.spec, requirements: rec.requirements, answers: rec.answers, inputs: rec.inputs, quote: rec.quote, timers: rec.timers, fees: rec.fees, amendments: rec.amendments })
  }
  /** Apply a change to the contract parts. A real change bumps the version, re-hashes and clears acceptances. */
  amend(rec: JobRecord, mutate: () => void): boolean {
    const before = this.contentHash(rec)
    mutate()
    if (this.contentHash(rec) === before) return false
    rec.version += 1
    rec.accepted_by = []
    const c = this.buildContract(rec)
    rec.contract_hash = c ? hashCanonical(c) : null
    return true
  }

  // ---------- rendering ----------
  render(rec: JobRecord): Job {
    const contract = this.buildContract(rec)
    const e = rec.escrow
    return {
      id: rec.id,
      state: rec.state,
      title: rec.title,
      buyer_agent_id: rec.buyer_agent_id,
      seller_bot_id: rec.seller_bot_id,
      seller_agent_id: rec.seller_agent_id,
      skill_id: rec.skill_id,
      contract,
      contract_hash: rec.contract_hash,
      accepted_by: rec.accepted_by,
      escrow: {
        job_id: rec.id,
        rail: e.rail,
        mode: e.mode,
        status: e.status,
        authorized: usd(e.authorized),
        captured: usd(e.captured),
        voided: usd(e.voided),
        refunded: usd(e.refunded),
        fees: usd(e.platform_fee + e.platform_extra + e.seller_fee + (e.refund_fee ?? 0)),
        paid_out: usd(e.paid_out),
        approval_url: e.approval_url,
        paypal: {
          order_id: e.order_id,
          authorization_id: e.authorization_id,
          capture_ids: e.capture_ids,
          refund_ids: e.refund_ids,
          payout_item_ids: e.payouts.map((p) => p.item_id ?? p.sender_item_id),
        },
        honor_expires_at: e.honor_expires_at,
        authorization_expires_at: e.authorization_expires_at,
        events: e.events,
      },
      fulfilment: rec.fulfilment,
      ruling: rec.ruling,
      mediation: rec.mediation?.state ?? null,
      deadlines: rec.deadlines,
      policy: rec.policy,
      message_count: this.room.count(rec.id),
      ...(rec.origin ? { origin: { open_job_id: rec.origin.open_job_id, bid_id: rec.origin.bid_id } } : {}),
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    }
  }

  view(rec: JobRecord, job = this.render(rec)): MachineView {
    const required = Array.isArray((rec.requirements?.inputs_schema as { required?: unknown })?.required)
      ? ((rec.requirements!.inputs_schema as { required: unknown[] }).required.filter((k) => typeof k === 'string') as string[])
      : []
    // An access request counts as answered only by a live locker item shared for the request as it stands (same hash).
    const current = new Map((rec.requirements?.access ?? []).map((a) => [a.id, hashCanonical(a)]))
    const shared = new Set(
      this.db
        .all<{ access_id: string; access_hash: string | null }>("SELECT access_id, access_hash FROM locker_items WHERE job_id = ? AND direction = 'access' AND shredded_at IS NULL", rec.id)
        .filter((r) => r.access_hash === current.get(r.access_id))
        .map((r) => r.access_id),
    )
    return {
      job,
      now: this.nowMs(),
      has_quote: !!rec.quote,
      has_requirements: !!rec.requirements,
      accepted_roles: rec.accepted_by.filter((a) => a.contract_hash === rec.contract_hash).map((a) => a.role),
      open_questions: (rec.requirements?.questions ?? []).map((q) => q.id).filter((id) => !rec.answers[id]),
      missing_inputs: required.filter((k) => rec.inputs[k] === undefined || rec.inputs[k] === '' || rec.inputs[k] === null),
      missing_access: (rec.requirements?.access ?? []).filter((a) => a.required && !shared.has(a.id)).map((a) => a.id),
      has_delivery: !!rec.delivery,
      delivery_accepted: rec.review.accepted,
      deliver_by_passed: !!rec.deadlines.deliver_by && this.nowMs() > Date.parse(rec.deadlines.deliver_by),
      ruling_accepted_by: rec.ruling_accepted_by,
      mediator_questions: (rec.mediation?.questions ?? []).filter((q) => q.answer === null).map((q) => ({ id: q.id, to: q.to })),
      mediation: rec.mediation ? { status: rec.mediation.state.status, round: rec.mediation.state.round, deadline: rec.mediation.state.deadline } : null,
      proposals: (rec.mediation?.state.proposals ?? []).map((p) => ({
        id: p.id,
        round: p.round,
        status: p.status,
        kind: p.kind,
        by: p.by,
        answered: (['buyer', 'seller'] as const).filter((r) => !!p.responses[r]),
        summary: termsSummary(p.terms),
      })),
      agreement_active: !!rec.agreement && !TERMINAL_STATES.includes(rec.state),
      secret_ids: this.db.all<{ id: string }>("SELECT id FROM locker_items WHERE job_id = ? AND direction = 'access' AND shredded_at IS NULL ORDER BY created_at", rec.id).map((r) => r.id),
      cursor: this.bus.latestCursor(),
    }
  }

  result(rec: JobRecord, role: Role) {
    const job = this.render(rec)
    return { job, your_role: role, next_actions: nextActions(this.view(rec, job), role) }
  }

  held(rec: JobRecord) {
    return heldCents(rec.escrow)
  }

  // ---------- room, events, state ----------
  audience(rec: JobRecord, extra: Partial<Audience> = {}): Audience {
    const disputed = ['DISPUTED', 'RULED', 'APPEALED'].includes(rec.state)
    return { agents: [rec.buyer_agent_id, rec.seller_agent_id], arbiter: disputed, ...extra }
  }

  post(rec: JobRecord, from: From, type: MessageType, text: string, body: Record<string, unknown> = {}, artifact_ids: string[] = []): Message {
    const m = this.room.post(rec.id, from, type, text, body, artifact_ids)
    this.bus.publish('message', rec.id, this.audience(rec), `${from.role} ${type}: ${text}`.slice(0, 300), { message_id: m.id, seq: m.seq, type, from: from.role, state: rec.state })
    return m
  }
  system(rec: JobRecord, text: string, body: Record<string, unknown> = {}) {
    return this.post(rec, PLATFORM, 'system', text, body)
  }

  /** Change state along an allowed transition; posts a system message and a state event. */
  setState(rec: JobRecord, to: JobState, why: string, body: Record<string, unknown> = {}) {
    const from = rec.state
    if (from === to) return
    if (!canTransition(from, to)) throw new OpError('internal', `Illegal transition ${from} → ${to}.`, 'This is a platform bug; nothing was changed.')
    rec.state = to
    this.system(rec, `${from} → ${to}: ${why}`, { from, to, ...body })
    this.bus.publish('state', rec.id, this.audience(rec), `Job is now ${to}`, { from, to, why })
    if (TERMINAL_STATES.includes(to)) this.onTerminal?.(rec)
  }
  onTerminal?: (rec: JobRecord) => void

  /** `<job_id>:<transition>:<n>`: same n on retries after unknown outcomes, next n after a definitive answer. */
  requestId(rec: JobRecord, transition: string): string {
    return `${rec.id}:${transition}:${rec.req[transition] ?? 1}`
  }
  bumpRequest(rec: JobRecord, transition: string) {
    rec.req[transition] = (rec.req[transition] ?? 1) + 1
  }
}
