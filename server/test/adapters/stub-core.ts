// An in-memory `Core` with realistic behaviour for adapter tests and `npm run dev:stub`.
// It is not the real core: no PayPal, no AI, no persistence. It does follow the protocol closely enough
// (state machine, next_actions, events, escrow numbers) that every output validates against the op schemas.
import { createHash, randomBytes } from 'node:crypto'
import { amount, cents, type Event, type EventType } from '@rentabot/shared'
import { OpError, type Core, type EventFilter, type FeedItem, type Handlers, type Principal, type PublicStats } from '../../src/core/types.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type A = any

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`
const sha = (v: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(v)).digest('hex')
const ts = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
const money = (value: string) => ({ value, currency: 'USD' as const })
const DAY = 86_400_000

export interface StubOptions {
  publicUrl?: string
  demoMode?: boolean
  simulated?: boolean
  /** Seed the demo story (ORANO Growth Agent, Directory Blaster, a 31/40 job with a ruling). Default true. */
  seed?: boolean
}

interface StubJob {
  job: A
  messages: A[]
  checks: A[]
  secrets: Map<string, { access_id: string; label: string; value: string }>
  autoSeller: boolean
}

export interface StubCore extends Core {
  /** Test hooks. */
  stub: { emit(type: EventType, jobId: string | null, summary: string, audience: string[], data?: Record<string, unknown>): Event; keys: { buyer: string; seller: string }; jobs: Map<string, StubJob> }
}

const CHECKS = [
  { id: 'listing_url_live', title: 'Listing URL is live', description: 'The submitted URL returns HTTP 200.', params: { type: 'object', properties: { status: { type: 'integer', default: 200 } } }, per_unit: true, delayed: true },
  { id: 'listing_mentions_product', title: 'Listing mentions the product', description: 'The page text includes every required string.', params: { type: 'object', properties: { must_include: { type: 'array', items: { type: 'string' } } } }, per_unit: true, delayed: false },
  { id: 'screenshot_attached', title: 'Screenshot attached', description: 'Each unit carries a screenshot artifact.', params: { type: 'object' }, per_unit: true, delayed: false },
  { id: 'email_sent', title: 'Email sent', description: 'A Message-ID exists in the sender\'s Sent folder and the recipient domain accepted it.', params: { type: 'object' }, per_unit: true, delayed: false },
  { id: 'json_schema_valid', title: 'Output matches a JSON Schema', description: 'The delivered JSON validates against the schema in params.', params: { type: 'object', properties: { schema: { type: 'object' } } }, per_unit: false, delayed: false },
]

export function createStubCore(opts: StubOptions = {}): StubCore {
  const publicUrl = (opts.publicUrl ?? 'http://localhost:8790').replace(/\/+$/, '')
  const rail: PublicStats['payment_rail'] = opts.simulated === false ? 'paypal_sandbox' : 'simulated'
  const agents = new Map<string, A>()
  const keys = new Map<string, string>() // api key -> agent id
  const claimCodes = new Map<string, string>()
  const bots = new Map<string, A>()
  const jobs = new Map<string, StubJob>()
  const mandates = new Map<string, A>() // agent id -> mandate
  const artifacts = new Map<string, { mime: string; name: string; bytes: Uint8Array; meta: A }>()
  const fundKeys = new Map<string, A>()
  const events: { e: Event; audience: string[] }[] = []
  const listeners = new Set<{ filter: Omit<EventFilter, 'after_cursor'>; fn: (e: Event) => void }>()
  const waiters = new Set<() => void>()
  const demoKeys = { buyer: 'rab_demo_buyer_key_orano', seller: 'rab_demo_seller_key_blaster' }

  // ---------- events ----------
  const agentOf = (p: Principal): string | null => (p.kind === 'agent' ? p.agent_id : p.kind === 'user' ? p.act_as : null)
  const visible = (p: Principal, audience: string[]) => audience.includes('public') || (agentOf(p) !== null && audience.includes(agentOf(p)!))
  const matches = (f: Omit<EventFilter, 'after_cursor'>, e: Event, audience: string[]) =>
    visible(f.principal, audience) && (!f.job_id || e.job_id === f.job_id) && (!f.types || f.types.includes(e.type))
  function emit(type: EventType, jobId: string | null, summary: string, audience: string[], data: Record<string, unknown> = {}): Event {
    const e: Event = { cursor: events.length + 1, type, job_id: jobId, summary, data, ts: ts() }
    events.push({ e, audience })
    for (const l of listeners) if (matches(l.filter, e, audience)) l.fn(e)
    for (const w of [...waiters]) w()
    return e
  }
  const emitJob = (js: StubJob, type: EventType, summary: string, data: Record<string, unknown> = {}) =>
    emit(type, js.job.id, summary, [js.job.buyer_agent_id, js.job.seller_agent_id], { state: js.job.state, ...data })

  const list = async (f: EventFilter, limit = 100) => {
    const out = events.filter((x) => x.e.cursor > f.after_cursor && matches(f, x.e, x.audience)).slice(0, limit).map((x) => x.e)
    return { events: out, cursor: out.length ? out[out.length - 1]!.cursor : Math.max(f.after_cursor, 0) }
  }

  // ---------- builders ----------
  const emptyEscrow = (job_id: string): A => ({
    job_id, rail, mode: 'hold', status: 'none',
    authorized: money('0.00'), captured: money('0.00'), voided: money('0.00'), refunded: money('0.00'), fees: money('0.00'), paid_out: money('0.00'),
    approval_url: null, paypal: { order_id: null, authorization_id: null, capture_ids: [], refund_ids: [], payout_item_ids: [] },
    honor_expires_at: null, authorization_expires_at: null, events: [],
  })
  const reputation = (jobs: number) => ({ jobs_completed: jobs, on_time_rate: jobs ? 0.96 : null, dispute_rate: jobs ? 0.08 : null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: jobs ? 0.91 : null, settled_by_agreement: 0 })
  const summary = (b: A) => ({ id: b.id, name: b.name, tagline: b.tagline, capability_class: b.capability_class, mode: b.mode, reputation: b.reputation, skills: b.skills.map((s: A) => ({ id: s.id, title: s.title, pricing: s.pricing, turnaround: s.turnaround, checks: s.checks })) })

  const addAgent = (name: string, extra: A = {}) => {
    const agent = { id: id('agt'), name, description: '', owner_id: null, claimed: false, payout_email: null, created_at: ts(), ...extra }
    agents.set(agent.id, agent)
    return agent
  }
  const addBot = (b: A) => {
    const bot = { policy: { class: 'standard', requires_scope_proof: false, notes: '' }, a2a_url: null, status: 'listed', created_at: ts(), reputation: reputation(0), ...b }
    bots.set(bot.id, bot)
    return bot
  }

  function addMessage(js: StubJob, from: A, type: string, text: string, body: A = {}, artifact_ids: string[] = []) {
    const prev = js.messages.at(-1)
    const base = { id: id('msg'), job_id: js.job.id, seq: js.messages.length, from, type, text, body, artifact_ids, prev_hash: prev?.hash ?? null, ts: ts() }
    const msg = { ...base, hash: sha(base) }
    js.messages.push(msg)
    js.job.message_count = js.messages.length
    js.job.updated_at = ts()
    return msg
  }
  const who = (js: StubJob, role: 'buyer' | 'seller') => ({ kind: 'agent', id: role === 'buyer' ? js.job.buyer_agent_id : js.job.seller_agent_id, role })
  const platform = { kind: 'platform', id: 'platform', role: 'platform' }

  // ---------- job helpers ----------
  const principalAgent = (p: Principal): string => {
    const a = agentOf(p)
    if (!a) throw new OpError('unauthenticated', 'Sign in first.', 'Call register_agent or send a Bearer key.')
    return a
  }
  function loadJob(ctx: { principal: Principal }, jobId: string): { js: StubJob; role: 'buyer' | 'seller' } {
    const js = jobs.get(jobId)
    if (!js) throw new OpError('not_found', `No job ${jobId}.`, 'Use list_jobs to see your jobs.')
    const me = principalAgent(ctx.principal)
    const role = me === js.job.buyer_agent_id ? 'buyer' : me === js.job.seller_agent_id ? 'seller' : null
    if (!role) throw new OpError('forbidden', 'You are not a party to this job.', 'Use list_jobs to see your jobs.')
    return { js, role }
  }
  const need = (js: StubJob, role: string, wantRole: 'buyer' | 'seller' | null, states: string[], op: string) => {
    if (wantRole && role !== wantRole) throw new OpError('forbidden', `${op} is for the ${wantRole}.`, `You are the ${role} on this job.`)
    if (!states.includes(js.job.state)) throw new OpError('invalid_state', `${op} is not allowed in state ${js.job.state}.`, 'Call get_job and use next_actions.', nextActions(js, role))
  }

  function nextActions(js: StubJob, role: string): A[] {
    const j = js.job
    const id_ = j.id
    const hash = j.contract_hash
    const acc = (r: string) => j.accepted_by.some((a: A) => a.role === r && a.contract_hash === hash)
    const wait = { op: 'wait_for_events', why: 'Nothing for you to do yet; wait for the other side.', args: { job_id: id_ } }
    switch (j.state) {
      case 'NEGOTIATING':
        if (role === 'seller') return !j.contract ? [{ op: 'submit_requirements', why: 'State what you need.', args: { job_id: id_ } }, { op: 'send_quote', why: 'Price the work.', args: { job_id: id_ } }] : acc('seller') ? [wait] : [{ op: 'accept_contract', why: 'Sign the contract.', args: { job_id: id_, contract_hash: hash } }]
        return !j.contract ? [wait] : acc('buyer') ? [wait] : [{ op: 'provide_inputs', why: 'Answer the seller\'s questions.', args: { job_id: id_ } }, { op: 'accept_contract', why: 'Sign the contract if the terms are right.', args: { job_id: id_, contract_hash: hash } }]
      case 'AGREED':
      case 'AWAITING_APPROVAL':
        return role === 'buyer' ? [{ op: 'fund_job', why: j.state === 'AGREED' ? 'Put the money in escrow.' : 'A human must approve; retry fund_job to get the link again.', args: { job_id: id_ } }] : [wait]
      case 'IN_PROGRESS':
      case 'BLOCKED':
        return role === 'seller' ? [{ op: 'get_secret', why: 'Read sealed access.', args: { job_id: id_ } }, { op: 'submit_delivery', why: 'Deliver when done.', args: { job_id: id_ } }] : [wait, { op: 'open_dispute', why: 'Only if the deadline is missed.', args: { job_id: id_ } }]
      case 'DELIVERED':
        return role === 'buyer' ? [{ op: 'review_delivery', why: 'Accept or reject the delivery.', args: { job_id: id_ } }, { op: 'open_dispute', why: 'If you disagree with the checks.', args: { job_id: id_ } }] : [wait]
      case 'CURE':
        return role === 'seller' ? [{ op: 'submit_delivery', why: 'Fix the rejected items and redeliver.', args: { job_id: id_ } }] : [wait]
      case 'DISPUTED': {
        const open = (j.mediation?.proposals ?? []).filter((p: A) => p.status === 'open' && !p.responses[role])
        return open.length
          ? open.map((p: A) => ({ op: 'respond_to_proposal', why: `Answer proposal ${p.id}: accept, reject (reason required) or counter (terms required).`, args: { job_id: id_, proposal_id: p.id } }))
          : [{ op: 'add_statement', why: 'Add evidence.', args: { job_id: id_ } }, wait]
      }
      case 'RULED':
        return [{ op: 'accept_ruling', why: 'Accept the remedy.', args: { job_id: id_ } }, { op: 'appeal_ruling', why: 'Appeal to a human.', args: { job_id: id_ } }]
      case 'APPEALED':
        return [wait]
      default:
        return [{ op: 'get_escrow', why: 'See where the money went.', args: { job_id: id_ } }]
    }
  }
  const result = (js: StubJob, role: string, extra: A = {}) => ({ job: js.job, your_role: role, next_actions: nextActions(js, role), ...extra })

  function rebuildContract(js: StubJob, parts: { requirements?: A; quote?: A; spec?: A }) {
    const j = js.job
    const prev = j.contract ?? {}
    const c = {
      job_id: j.id, version: (prev.version ?? 0) + 1, buyer_agent_id: j.buyer_agent_id, seller_bot_id: j.seller_bot_id, seller_agent_id: j.seller_agent_id,
      spec: parts.spec ?? prev.spec ?? (js as A).spec, requirements: parts.requirements ?? prev.requirements ?? (js as A).requirements ?? null, answers: prev.answers ?? {}, inputs: prev.inputs ?? {},
      quote: parts.quote ?? prev.quote ?? (js as A).quote ?? null,
      timers: { fund_by: 'PT24H', inputs_by: 'PT24H', review_window: 'PT72H', cure_window: 'PT48H', appeal_window: 'PT48H', verify_window: 'PT0H' },
      fees: { platform_bps: 500, mediation_flat: '2.00', floor: '3.00', min_settlement: '5.00' },
      amendments: [],
    }
    Object.assign(js as A, { spec: c.spec, requirements: c.requirements, quote: c.quote })
    if (c.requirements && c.quote) {
      j.contract = c
      j.contract_hash = sha({ spec: c.spec, requirements: c.requirements, answers: c.answers, inputs: c.inputs, quote: c.quote, timers: c.timers })
      j.accepted_by = []
    }
  }
  function mockSellerReply(js: StubJob) {
    const spec = (js as A).spec
    const d = spec.deliverables[0]
    const bot = bots.get(js.job.seller_bot_id)!
    const skill = bot.skills.find((s: A) => s.id === spec.skill_id) ?? bot.skills[0]
    const requirements = {
      inputs_schema: skill.needs, access: [{ id: 'A1', kind: 'inbox_verification', why: 'Some directories email a confirmation link', scope: 'read-only, label:verify', required: false }],
      assumptions: ['Free directories only'], questions: [{ id: 'Q1', text: 'Which founder name should appear on listings?' }],
    }
    const unit = skill.pricing.price
    const total = amount(cents(unit) * d.quantity)
    const quote = { lines: [{ deliverable_id: d.id, model: skill.pricing.model, unit_price: unit, quantity: d.quantity, max_total: total }], total_max: money(total), turnaround: skill.turnaround, excludes: [], valid_until: ts(3 * DAY) }
    rebuildContract(js, { requirements, quote })
    addMessage(js, who(js, 'seller'), 'requirements', 'Here is what I need.', requirements)
    addMessage(js, who(js, 'seller'), 'quote', `Quote: $${total} maximum.`, quote)
    emitJob(js, 'message', 'Seller sent requirements and a quote', { type: 'quote' })
  }
  function setFulfilment(js: StubJob) {
    const spec = js.job.contract.spec
    const quote = js.job.contract.quote
    js.job.fulfilment = spec.deliverables.map((d: A) => {
      const rs = js.checks.filter((c: A) => c.deliverable_id === d.id)
      const refs = [...new Set(rs.map((c: A) => c.unit_ref))]
      const passed = refs.filter((r) => rs.filter((c: A) => c.unit_ref === r).every((c: A) => c.status === 'pass')).length
      const price = quote.lines.find((l: A) => l.deliverable_id === d.id)
      const per = price?.model === 'per_unit' ? cents(price.unit_price) : Math.round(cents(price?.unit_price ?? '0.00') / Math.max(d.quantity, 1))
      return { deliverable_id: d.id, expected_units: d.quantity, passed_units: passed, pending_units: 0, failed_units: refs.length - passed, earned: money(amount(per * passed)) }
    })
  }
  function setEscrowAuthorized(js: StubJob, via: string) {
    const total = js.job.contract.quote.total_max.value
    const e = js.job.escrow
    Object.assign(e, { status: 'authorized', authorized: money(total), approval_url: null, authorization_expires_at: ts(29 * DAY), honor_expires_at: ts(3 * DAY) })
    e.paypal = { ...e.paypal, order_id: e.paypal.order_id ?? 'SIMORDER' + randomBytes(4).toString('hex').toUpperCase(), authorization_id: 'SIMAUTH' + randomBytes(4).toString('hex').toUpperCase() }
    e.events.push({ kind: 'authorized', amount: money(total), paypal_id: e.paypal.authorization_id, webhook_event: 'PAYMENT.AUTHORIZATION.CREATED', note: via, ts: ts() })
    js.job.state = 'IN_PROGRESS'
    js.job.deadlines.deliver_by = ts(7 * DAY)
    addMessage(js, platform, 'system', `Escrow authorized for $${total} (${via}).`)
    emit('escrow', js.job.id, `Escrow authorized $${total}`, [js.job.buyer_agent_id, js.job.seller_agent_id], { state: 'IN_PROGRESS' })
    emitJob(js, 'state', 'Job is IN_PROGRESS')
  }
  function settle(js: StubJob, release: string) {
    const e = js.job.escrow
    const total = cents(e.authorized.value)
    const fee = Math.round(cents(release) * 0.05)
    Object.assign(e, { status: 'settled', captured: money(release), voided: money(amount(total - cents(release))), fees: money(amount(fee)), paid_out: money(amount(cents(release) - fee)) })
    e.events.push({ kind: 'captured', amount: money(release), paypal_id: 'SIMCAP' + randomBytes(3).toString('hex'), webhook_event: 'PAYMENT.CAPTURE.COMPLETED', note: '', ts: ts() })
    e.events.push({ kind: 'voided', amount: e.voided, paypal_id: e.paypal.authorization_id, webhook_event: 'PAYMENT.AUTHORIZATION.VOIDED', note: '', ts: ts() })
    js.job.state = 'SETTLED'
    emit('escrow', js.job.id, `Captured $${release}, voided $${e.voided.value}`, [js.job.buyer_agent_id, js.job.seller_agent_id], { state: 'SETTLED' })
    emitJob(js, 'state', 'Job is SETTLED')
  }
  const earnedTotal = (js: StubJob) => amount(js.job.fulfilment.reduce((s: number, f: A) => s + cents(f.earned.value), 0))

  function newJob(buyer: string, bot: A, spec: A, title: string, autoSeller: boolean, jobId = id('job')): StubJob {
    const now = ts()
    const js: StubJob = {
      job: {
        id: jobId, state: 'NEGOTIATING', title, buyer_agent_id: buyer, seller_bot_id: bot.id, seller_agent_id: bot.operator_agent_id, skill_id: spec.skill_id,
        contract: null, contract_hash: null, accepted_by: [], escrow: emptyEscrow(jobId), fulfilment: [], ruling: null, mediation: null,
        deadlines: { fund_by: null, deliver_by: null, review_until: null, cure_until: null, appeal_until: null, verify_until: null },
        policy: { class: 'standard', reasons: [] }, message_count: 0, created_at: now, updated_at: now,
      },
      messages: [], checks: [], secrets: new Map(), autoSeller,
    }
    ;(js as A).spec = spec
    jobs.set(jobId, js)
    return js
  }

  const rulingFixture = (js: StubJob, passed: number, expected: number): A => {
    const unit = cents(js.job.contract.quote.lines[0].unit_price)
    const release = amount(unit * passed)
    return {
      id: id('rul'), job_id: js.job.id, contract_hash: js.job.contract_hash, tier: 'T2',
      findings: [{ deliverable_id: 'D1', status: passed === expected ? 'met' : 'partly_met', fulfilment: passed / expected, evidence: ['check results'], clauses: ['spec.deliverables[0].quantity', 'spec.deliverables[0].acceptance[0]'], note: `${passed} of ${expected} units passed their acceptance checks.` }],
      buyer_fault: [], seller_fault: passed < expected ? [`${expected - passed} listings never went live`] : [],
      remedy: { type: 'split', release_to_seller: money(release), refund_to_buyer: money(amount(cents(js.job.contract.quote.total_max.value) - cents(release))), fees: { platform: money(amount(Math.round(cents(release) * 0.05))), mediation: money('2.00') }, redo_deadline: null },
      confidence: 0.93,
      jury: [{ model: 'juror-a', release_fraction: passed / expected, confidence: 0.9, summary: 'Pay for verified units only.' }, { model: 'juror-b', release_fraction: passed / expected, confidence: 0.95, summary: 'Checks are decisive; no evidence of buyer fault.' }],
      integrity_flags: [], escalated: false, escalation_reason: null,
      reasoning: `The contract prices each verified listing at $${amount(unit)}. ${passed} of ${expected} passed listing_url_live; the rest returned 404. Remedy: release $${release} to the seller and refund the remainder.`,
      appealable_until: ts(2 * DAY), decided_by: 'mediator:jury', created_at: ts(),
    }
  }

  /** A mediation like the real one produces: neutral assessment, a split and a redo in round 1 (more rounds when no agreement). */
  const mediationFixture = (js: StubJob, passed: number, expected: number, status: 'negotiating' | 'no_agreement'): A => {
    const unit = cents(js.job.contract.quote.lines[0].unit_price)
    const total = cents(js.job.contract.quote.total_max.value)
    const verified = unit * passed
    const mk = (round: number, kind: string, release: number, held: number, rationale: string): A => ({
      id: 'prp_' + randomBytes(6).toString('hex'), round, by: 'mediator', kind, status: status === 'negotiating' ? 'open' : 'rejected',
      terms: { release_now: amount(release), refund_now: amount(total - release - held), redo: held ? { deliverable_id: 'D1', units: Array.from({ length: expected - passed }, (_, n) => `directory-${passed + n + 1}`), instruction: 'Fix the failed listings so they pass the checks.', deadline: ts(2 * DAY), amount_on_success: amount(held), acceptance: js.job.contract.spec.deliverables[0].acceptance } : null, wait_until: null, cancel: false, note: '' },
      rationale, flags: [],
      preview: { capture_now: amount(release), void_now: amount(total - release - held), held: amount(held), platform_commission: amount(Math.round(release * 0.05)), seller_payout_now: amount(release - Math.round(release * 0.05)), held_commission: amount(Math.round(held * 0.05)), held_seller_payout: amount(held - Math.round(held * 0.05)) },
      counters: null, responses: {}, created_at: ts(),
    })
    const proposals = [mk(1, 'split', verified, 0, `Pays exactly what the checks verified (${amount(verified)}); the rest goes back to the buyer.`), mk(1, 'redo', verified, total - verified, 'Pays the verified work now and gives the seller one chance to fix the failed units.')]
    if (status === 'no_agreement') proposals.push(mk(2, 'split', verified + Math.round((total - verified) / 4), 0, 'Moves toward the middle of the fair range.'), mk(3, 'split', verified + Math.round((total - verified) / 2), 0, 'Last fair offer.'))
    return {
      status, round: status === 'no_agreement' ? 3 : 1, deadline: status === 'negotiating' ? ts(2 * 3_600_000) : null, agreed_proposal_id: null, proposals,
      assessment: {
        verified_value: amount(verified), claimed_value: amount(total), fair_range: [amount(verified), amount(total)],
        findings: [{ deliverable_id: 'D1', status: passed === expected ? 'met' : 'partly_met', fulfilment: passed / expected, evidence: ['check results'], clauses: ['spec.deliverables[0].quantity'], note: `${passed} of ${expected} units passed their acceptance checks.` }],
        integrity_flags: [], jury: [], faults: { buyer: [], seller: [] }, summary: `${passed} of ${expected} units passed every check (${amount(verified)}). Fair range for the seller: ${amount(verified)}-${amount(total)}.`, confidence: 0.9, basis: 'checks', escalation_reasons: [],
      },
    }
  }

  function runChecks(js: StubJob, delivery: A) {
    const spec = js.job.contract.spec
    js.checks = []
    for (const d of delivery.deliverables) {
      const def = spec.deliverables.find((x: A) => x.id === d.deliverable_id)
      if (!def) continue
      for (const u of d.units)
        for (const t of def.acceptance) {
          const fail = !u.url || u.meta?.fail === true
          js.checks.push({ id: id('chk'), job_id: js.job.id, deliverable_id: d.deliverable_id, unit_ref: u.ref, check: t.check, status: fail ? 'fail' : 'pass', detail: fail ? 'No live URL' : 'OK', evidence_id: null, attempt: 1, ran_at: ts() })
        }
    }
    setFulfilment(js)
  }

  // ---------- handlers ----------
  const H: Record<string, (ctx: { principal: Principal }, input: A) => Promise<A>> = {
    async register_agent(_c, i) {
      const agent = addAgent(i.name, { description: i.description ?? '', payout_email: i.payout_email ?? null })
      const key = 'rab_' + randomBytes(18).toString('hex')
      const code = randomBytes(5).toString('hex').toUpperCase()
      keys.set(key, agent.id)
      claimCodes.set(code, agent.id)
      return { agent, api_key: key, claim_url: `${publicUrl}/claim/${code}`, claim_code: code, next_actions: [{ op: 'whoami', why: 'See your profile.', args: {} }, { op: 'search_bots', why: 'Find a bot to hire.', args: {} }] }
    },
    async whoami(c) {
      const me = principalAgent(c.principal)
      const agent = agents.get(me)!
      const mine = [...jobs.values()].filter((j) => j.job.buyer_agent_id === me || j.job.seller_agent_id === me)
      const open = (j: StubJob) => !['SETTLED', 'CANCELLED', 'EXPIRED'].includes(j.job.state)
      return {
        agent, owner: agent.owner_id ? { id: agent.owner_id, name: 'Manu' } : null, mandate: mandates.get(me) ?? null,
        bots: [...bots.values()].filter((b) => b.operator_agent_id === me).map(summary),
        jobs: { as_buyer_open: mine.filter((j) => j.job.buyer_agent_id === me && open(j)).length, as_seller_open: mine.filter((j) => j.job.seller_agent_id === me && open(j)).length, needs_your_action: mine.filter((j) => open(j) && nextActions(j, j.job.buyer_agent_id === me ? 'buyer' : 'seller').some((a) => a.op !== 'wait_for_events')).length },
        payment_rail: rail,
        next_actions: [{ op: 'list_jobs', why: 'See jobs waiting on you.', args: { needs_action: true } }],
      }
    },
    async request_mandate(c, i) {
      const me = principalAgent(c.principal)
      const mid = id('mdt')
      const m = { id: mid, agent_id: me, owner_id: agents.get(me)?.owner_id ?? null, status: 'pending_approval', monthly_cap: money(i.monthly_cap), per_job_cap: money(i.per_job_cap), categories: i.categories, expires_at: ts(i.expires_in_days * DAY), spent_this_month: money('0.00'), approval_url: `${publicUrl}/sim/paypal/vault/${mid}`, rail, created_at: ts() }
      mandates.set(me, m)
      return { mandate: m, approval_url: m.approval_url, next_actions: [{ op: 'get_mandate', why: 'Poll after giving the approval_url to a human.', args: {} }] }
    },
    async get_mandate(c) {
      return { mandate: mandates.get(principalAgent(c.principal)) ?? null }
    },
    async claim_agent(c, i) {
      const agentId = claimCodes.get(i.claim_code)
      if (!agentId || c.principal.kind !== 'user') throw new OpError('not_found', 'Unknown claim code.', 'Check the claim_code from register_agent.')
      Object.assign(agents.get(agentId)!, { owner_id: c.principal.user_id, claimed: true })
      claimCodes.delete(i.claim_code)
      return { agent: agents.get(agentId) }
    },
    async search_bots(_c, i) {
      const q = (i.query ?? '').toLowerCase()
      const out = [...bots.values()].filter((b) => b.status === 'listed')
        .filter((b) => !q || `${b.name} ${b.tagline} ${b.description} ${b.skills.map((s: A) => s.title + ' ' + s.id).join(' ')}`.toLowerCase().includes(q))
        .filter((b) => !i.capability_class || b.capability_class === i.capability_class)
        .filter((b) => !i.skill || b.skills.some((s: A) => s.id === i.skill))
        .filter((b) => !i.mode || b.mode === i.mode)
        .filter((b) => !i.max_unit_price || b.skills.some((s: A) => cents(s.pricing.price) <= cents(i.max_unit_price)))
      return { bots: out.slice(0, i.limit).map(summary) }
    },
    async get_bot(_c, i) {
      const bot = bots.get(i.bot_id)
      if (!bot) throw new OpError('not_found', `No bot ${i.bot_id}.`, 'Use search_bots.')
      return { bot }
    },
    async list_checks() {
      return { checks: CHECKS }
    },
    async draft_job_spec(c, i) {
      principalAgent(c.principal)
      const bot = bots.get(i.bot_id)
      if (!bot) throw new OpError('not_found', `No bot ${i.bot_id}.`, 'Use search_bots.')
      const skill = bot.skills.find((s: A) => s.id === i.skill_id)
      if (!skill) throw new OpError('invalid_input', `Bot ${bot.id} has no skill ${i.skill_id}.`, `Skills: ${bot.skills.map((s: A) => s.id).join(', ')}.`)
      const qty = i.quantity ?? skill.pricing.min_units ?? 1
      const est = amount(cents(skill.pricing.price) * qty)
      const spec = {
        skill_id: skill.id, goal: i.goal,
        deliverables: [{ id: 'D1', description: `${qty} x ${skill.pricing.unit ?? 'unit'}: ${skill.title}`, quantity: qty, acceptance: skill.checks.map((check: string) => ({ check, params: {} })), rubric: '' }],
        deadline: i.deadline ?? ts(7 * DAY), budget_cap: money(i.budget_cap ?? est), out_of_scope: ['paid placements'], context: i.context ?? '', context_artifact_ids: [],
      }
      return { spec, estimate: money(est), warnings: cents(est) > cents(spec.budget_cap.value) ? ['Estimate exceeds your budget_cap; the seller may quote less or decline.'] : [], policy: { class: 'standard', reasons: [] } }
    },
    async create_job(c, i) {
      const me = principalAgent(c.principal)
      const bot = bots.get(i.bot_id)
      if (!bot) throw new OpError('not_found', `No bot ${i.bot_id}.`, 'Use search_bots.')
      if (i.idempotency_key) {
        const dup = [...jobs.values()].find((j) => (j as A).idem === `${me}:${i.idempotency_key}`)
        if (dup) return result(dup, 'buyer')
      }
      const js = newJob(me, bot, i.spec, i.title ?? i.spec.goal.slice(0, 80), ['agt_dirblaster0001', 'agt_inboxoutreach1'].includes(bot.operator_agent_id) || bot.operator_agent_id.startsWith('agt_house'))
      ;(js as A).idem = i.idempotency_key ? `${me}:${i.idempotency_key}` : undefined
      addMessage(js, who(js, 'buyer'), 'job_spec', i.spec.goal, i.spec)
      emit('message', js.job.id, 'New job for your bot', [js.job.seller_agent_id, js.job.buyer_agent_id], { type: 'job_spec', state: 'NEGOTIATING' })
      if (js.autoSeller) mockSellerReply(js)
      return result(js, 'buyer')
    },
    async submit_requirements(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'seller', ['NEGOTIATING'], 'submit_requirements')
      rebuildContract(js, { requirements: i.requirements })
      addMessage(js, who(js, 'seller'), 'requirements', 'Requirements', i.requirements)
      emitJob(js, 'message', 'Seller sent requirements', { type: 'requirements' })
      return result(js, role)
    },
    async send_quote(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'seller', ['NEGOTIATING'], 'send_quote')
      rebuildContract(js, { quote: i.quote })
      addMessage(js, who(js, 'seller'), 'quote', 'Quote', i.quote)
      emitJob(js, 'message', 'Seller sent a quote', { type: 'quote' })
      return result(js, role)
    },
    async revise_spec(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'buyer', ['NEGOTIATING'], 'revise_spec')
      js.job.contract = null
      js.job.contract_hash = null
      rebuildContract(js, { spec: i.spec })
      addMessage(js, who(js, 'buyer'), 'counter', i.note || 'Revised spec', i.spec)
      if (js.autoSeller) mockSellerReply(js)
      return result(js, role)
    },
    async provide_inputs(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'buyer', ['NEGOTIATING', 'IN_PROGRESS', 'BLOCKED'], 'provide_inputs')
      if (js.job.contract) {
        Object.assign(js.job.contract.answers, i.answers)
        Object.assign(js.job.contract.inputs, i.inputs)
        js.job.contract_hash = sha({ spec: js.job.contract.spec, requirements: js.job.contract.requirements, answers: js.job.contract.answers, inputs: js.job.contract.inputs, quote: js.job.contract.quote, timers: js.job.contract.timers })
        js.job.accepted_by = []
      }
      addMessage(js, who(js, 'buyer'), 'inputs', 'Inputs and answers provided.', { answers: i.answers, inputs: i.inputs })
      emitJob(js, 'message', 'Buyer provided inputs', { type: 'inputs' })
      return result(js, role)
    },
    async accept_contract(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['NEGOTIATING'], 'accept_contract')
      if (!js.job.contract) throw new OpError('invalid_state', 'There is no complete contract yet.', 'Wait for requirements and a quote.', nextActions(js, role))
      if (i.contract_hash !== js.job.contract_hash) throw new OpError('stale_contract', 'The contract changed since you read it.', 'Call get_job, review the terms, and accept the new contract_hash.', nextActions(js, role))
      const sign = (r: 'buyer' | 'seller') => {
        if (!js.job.accepted_by.some((a: A) => a.role === r)) js.job.accepted_by.push({ role: r, agent_id: r === 'buyer' ? js.job.buyer_agent_id : js.job.seller_agent_id, contract_hash: i.contract_hash, ts: ts() })
      }
      sign(role)
      addMessage(js, who(js, role), 'accept', 'Accepted the contract.', { contract_hash: i.contract_hash })
      if (role === 'buyer' && js.autoSeller) sign('seller')
      if (js.job.accepted_by.length === 2) {
        js.job.state = 'AGREED'
        js.job.deadlines.fund_by = ts(DAY)
        emitJob(js, 'state', 'Contract signed; job is AGREED')
      } else emitJob(js, 'message', `${role} accepted the contract`, { type: 'accept' })
      return result(js, role)
    },
    async decline_job(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS'], 'decline_job')
      js.job.state = 'CANCELLED'
      addMessage(js, who(js, role), 'decline', i.reason)
      emitJob(js, 'state', 'Job CANCELLED')
      return result(js, role)
    },
    async send_message(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      if (['SETTLED', 'CANCELLED', 'EXPIRED'].includes(js.job.state)) throw new OpError('invalid_state', 'The room is closed.', 'The job has ended.')
      if (i.type === 'blocker' && js.job.state === 'IN_PROGRESS') js.job.state = 'BLOCKED'
      if (i.type === 'unblock' && js.job.state === 'BLOCKED') js.job.state = 'IN_PROGRESS'
      const message = addMessage(js, who(js, role), i.type, i.text, i.percent !== undefined ? { percent: i.percent } : {}, i.artifact_ids)
      emitJob(js, 'message', `${role}: ${i.type}`, { type: i.type })
      return { message, job: js.job, your_role: role, next_actions: nextActions(js, role) }
    },
    async fund_job(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      const cached = fundKeys.get(`${js.job.id}:${i.idempotency_key}`)
      if (cached) return cached
      need(js, role, 'buyer', ['AGREED', 'AWAITING_APPROVAL'], 'fund_job')
      const m = mandates.get(role === 'buyer' ? js.job.buyer_agent_id : '')
      const total = cents(js.job.contract.quote.total_max.value)
      const bot = bots.get(js.job.seller_bot_id)!
      const covered = m && m.status === 'active' && total <= cents(m.per_job_cap.value) && m.categories.includes(bot.capability_class) && cents(m.spent_this_month.value) + total <= cents(m.monthly_cap.value)
      let out: A
      if (covered) {
        m.spent_this_month = money(amount(cents(m.spent_this_month.value) + total))
        setEscrowAuthorized(js, 'within mandate')
        out = { ...result(js, role), approval_url: null }
      } else {
        const e = js.job.escrow
        e.status = 'pending_approval'
        e.paypal.order_id ??= 'SIMORDER' + randomBytes(4).toString('hex').toUpperCase()
        e.approval_url = `${publicUrl}/sim/paypal/order/${e.paypal.order_id}`
        js.job.state = 'AWAITING_APPROVAL'
        e.events.push({ kind: 'approval_required', amount: money(amount(total)), paypal_id: e.paypal.order_id, webhook_event: null, note: 'No active mandate covers this job', ts: ts() })
        emitJob(js, 'state', 'Awaiting human approval on PayPal')
        out = { ...result(js, role), approval_url: e.approval_url }
      }
      fundKeys.set(`${js.job.id}:${i.idempotency_key}`, out)
      return out
    },
    async get_escrow(c, i) {
      return { escrow: loadJob(c, i.job_id).js.job.escrow }
    },
    async upload_artifact(c, i) {
      const me = principalAgent(c.principal)
      const bytes = i.content_base64 ? Buffer.from(i.content_base64, 'base64') : Buffer.from(i.text ?? i.url ?? '')
      const art = { id: id('art'), job_id: i.job_id ?? null, name: i.name, mime: i.mime, bytes: bytes.length, sha256: sha(Array.from(bytes)), url: i.url ?? '', uploaded_by: me, created_at: ts() }
      art.url ||= `${publicUrl}/api/artifacts/${art.id}`
      artifacts.set(art.id, { mime: i.mime, name: i.name, bytes: new Uint8Array(bytes), meta: art })
      return { artifact: art }
    },
    async share_secret(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'buyer', ['NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED'], 'share_secret')
      const sid = id('sec')
      js.secrets.set(sid, { access_id: i.access_id, label: i.label, value: i.value })
      addMessage(js, platform, 'system', `Buyer shared a secret for ${i.access_id} (${i.label}). Value not logged.`)
      return { secret_id: sid, sealed_until: js.job.state === 'IN_PROGRESS' ? 'now_available' : 'funded' }
    },
    async get_secret(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'seller', ['IN_PROGRESS', 'BLOCKED', 'CURE'], 'get_secret')
      const s = js.secrets.get(i.secret_id)
      if (!s) throw new OpError('not_found', 'No such secret.', 'The buyer has not shared it yet.')
      addMessage(js, platform, 'system', `Seller read secret ${s.access_id}.`)
      return { ...s, expires_at: null }
    },
    async submit_delivery(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'seller', ['IN_PROGRESS', 'CURE'], 'submit_delivery')
      addMessage(js, who(js, 'seller'), 'delivery', i.delivery.note || 'Delivery submitted.', i.delivery)
      runChecks(js, i.delivery)
      js.job.state = 'DELIVERED'
      js.job.deadlines.review_until = ts(3 * DAY)
      emit('check', js.job.id, 'Acceptance checks ran', [js.job.buyer_agent_id, js.job.seller_agent_id], { passed: js.checks.filter((x) => x.status === 'pass').length })
      emitJob(js, 'state', 'Job is DELIVERED')
      return { ...result(js, role), checks: js.checks }
    },
    async run_checks(c, i) {
      const { js } = loadJob(c, i.job_id)
      need(js, 'party', null, ['DELIVERED', 'CURE', 'DISPUTED'], 'run_checks')
      js.checks.forEach((x) => (x.attempt += 1))
      setFulfilment(js)
      return { checks: js.checks, fulfilment: js.job.fulfilment }
    },
    async review_delivery(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, 'buyer', ['DELIVERED'], 'review_delivery')
      addMessage(js, who(js, 'buyer'), 'review', i.decision, { decision: i.decision, rejections: i.rejections })
      if (i.decision === 'accept') settle(js, earnedTotal(js))
      else {
        js.job.state = 'CURE'
        js.job.deadlines.cure_until = ts(2 * DAY)
        emitJob(js, 'state', 'Delivery rejected; seller has a cure window')
      }
      return result(js, role)
    },
    async open_dispute(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['IN_PROGRESS', 'DELIVERED', 'CURE'], 'open_dispute')
      addMessage(js, who(js, role), 'dispute', i.reason, { claims: i.claims })
      js.job.state = 'DISPUTED'
      emitJob(js, 'state', 'Job is DISPUTED')
      // The stub mediator assesses at once and posts its round-1 proposals.
      const f = js.job.fulfilment[0]
      js.job.mediation = mediationFixture(js, f?.passed_units ?? 0, f?.expected_units ?? 1, 'negotiating')
      addMessage(js, { kind: 'mediator', id: 'mediator', role: 'mediator' }, 'proposal', 'Round 1 of 3. Options: a split, or a redo.', { round: 1, proposals: js.job.mediation.proposals.map((p: A) => ({ id: p.id, kind: p.kind, terms: p.terms })) })
      emitJob(js, 'message', 'The mediator posted proposals', { type: 'proposal' })
      return result(js, role)
    },
    async add_statement(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['DISPUTED'], 'add_statement')
      addMessage(js, who(js, role), 'statement', i.text, {}, i.artifact_ids)
      return result(js, role)
    },
    async get_mediation(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      return { mediation: js.job.mediation, your_role: role, next_actions: nextActions(js, role) }
    },
    async respond_to_proposal(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['DISPUTED'], 'respond_to_proposal')
      const m = js.job.mediation
      const p = m?.proposals.find((x: A) => x.id === i.proposal_id)
      if (!p) throw new OpError('not_found', `No proposal ${i.proposal_id}.`, 'get_mediation lists the proposal ids.')
      if (p.status !== 'open') throw new OpError('invalid_state', `Proposal ${p.id} is ${p.status}.`, 'Answer an open proposal.')
      if (p.responses[role]) throw new OpError('invalid_state', 'You already answered this proposal.', 'Answer another open proposal.')
      if (i.answer === 'reject' && !i.reason) throw new OpError('invalid_input', 'A rejection needs a reason.', 'Say why you cannot accept it.')
      if (i.answer === 'counter' && !i.terms) throw new OpError('invalid_input', 'A counter needs terms.', 'Send only the fields you change.')
      p.responses[role] = { answer: i.answer, reason: i.reason ?? '', terms: i.terms ?? null, message_id: null, ts: ts() }
      addMessage(js, who(js, role), 'proposal_response', `${role} ${i.answer}ed proposal ${p.id}`, { proposal_id: p.id, answer: i.answer })
      let explanation = `You answered ${i.answer} on proposal ${p.id}.`
      if (i.answer === 'counter') {
        const total = cents(js.job.contract.quote.total_max.value)
        const release = i.terms.release_now ? cents(i.terms.release_now) : cents(p.terms.release_now)
        if (release > total) throw new OpError('invalid_input', 'Counter not executable: release_now is more than is held.', 'Keep release_now at or below the held amount.')
        m.proposals.push({ ...p, id: 'prp_' + randomBytes(6).toString('hex'), by: role, status: 'open', terms: { ...p.terms, release_now: amount(release), refund_now: amount(total - release), redo: null }, counters: p.id, responses: { [role]: { answer: 'accept', reason: '', terms: null, message_id: null } }, kind: 'split' })
        explanation = `${role}'s counter: release $${amount(release)}. Inside the fair range.`
      }
      const agreed = m.proposals.find((x: A) => x.status === 'open' && (x.by === 'buyer' || x.responses.buyer?.answer === 'accept') && (x.by === 'seller' || x.responses.seller?.answer === 'accept'))
      if (agreed) {
        agreed.status = 'accepted'
        m.agreed_proposal_id = agreed.id
        m.status = 'agreed'
        m.deadline = null
        settle(js, agreed.terms.release_now)
        addMessage(js, { kind: 'mediator', id: 'mediator', role: 'mediator' }, 'settlement', `Both sides accepted ${agreed.id}; executed.`, { proposal_id: agreed.id })
        explanation += ' Both sides accepted; it was executed.'
      }
      return { ...result(js, role), explanation }
    },
    async get_platform_ledger(c, i) {
      if (c.principal.kind !== 'user' || !c.principal.roles.includes('arbiter')) throw new OpError('forbidden', 'Only a human arbiter can read the ledger.', 'Sign in as an arbiter.')
      const moved = [...jobs.values()].filter((j) => cents(j.job.escrow.captured.value) > 0)
      const line = (j: StubJob) => ({ job_id: j.job.id, title: j.job.title, state: j.job.state, captured: j.job.escrow.captured.value, commission: j.job.escrow.fees.value, mediation_fees: '0.00', paypal_capture_fees: '0.00', paypal_payout_fees: '0.00', net: j.job.escrow.fees.value })
      const sum = (k: string) => amount(moved.reduce((n, j) => n + cents(line(j)[k as 'captured']), 0))
      return { currency: 'USD', totals: { jobs: moved.length, captured: sum('captured'), commission: sum('commission'), mediation_fees: '0.00', paypal_capture_fees: '0.00', paypal_payout_fees: '0.00', net: sum('commission') }, jobs: moved.slice(0, i.limit).map(line) }
    },
    async answer_mediator(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['DISPUTED'], 'answer_mediator')
      addMessage(js, who(js, role), 'mediator_answer', i.answer, { question_id: i.question_id })
      return result(js, role)
    },
    async get_ruling(c, i) {
      return { ruling: loadJob(c, i.job_id).js.job.ruling }
    },
    async accept_ruling(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['RULED'], 'accept_ruling')
      settle(js, js.job.ruling.remedy.release_to_seller.value)
      return result(js, role)
    },
    async appeal_ruling(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      need(js, role, null, ['RULED'], 'appeal_ruling')
      js.job.state = 'APPEALED'
      addMessage(js, who(js, role), 'appeal', i.grounds)
      emitJob(js, 'state', 'Ruling appealed to a human arbiter')
      return result(js, role)
    },
    async arbiter_decide(c, i) {
      const js = jobs.get(i.job_id)
      if (!js) throw new OpError('not_found', 'No such job.', 'Check the id.')
      need(js, 'arbiter', null, ['APPEALED'], 'arbiter_decide')
      settle(js, i.decision === 'override' && i.release_to_seller ? i.release_to_seller : js.job.ruling.remedy.release_to_seller.value)
      return result(js, 'arbiter')
    },
    async register_bot(c, i) {
      const me = principalAgent(c.principal)
      const bot = addBot({ id: id('bot'), operator_agent_id: me, ...i, a2a_url: i.a2a_url ?? null })
      emit('bot', null, `New bot listed: ${bot.name}`, ['public'], { bot_id: bot.id })
      return { bot }
    },
    async update_bot(c, i) {
      const bot = bots.get(i.bot_id)
      if (!bot) throw new OpError('not_found', 'No such bot.', 'Use search_bots.')
      if (bot.operator_agent_id !== principalAgent(c.principal)) throw new OpError('forbidden', 'You do not operate this bot.', 'Only the operator can update it.')
      Object.assign(bot, i.patch)
      return { bot }
    },
    async get_job(c, i) {
      const { js, role } = loadJob(c, i.job_id)
      return result(js, role)
    },
    async list_jobs(c, i) {
      if (c.principal.kind === 'user' && c.principal.roles.includes('arbiter') && i.state === 'APPEALED') {
        const q = [...jobs.values()].filter((j) => j.job.state === 'APPEALED').slice(0, i.limit)
        return { jobs: q.map((js) => ({ id: js.job.id, state: js.job.state, title: js.job.title, seller_bot_id: js.job.seller_bot_id, buyer_agent_id: js.job.buyer_agent_id, updated_at: js.job.updated_at, your_role: 'arbiter', held: js.job.escrow.authorized, next_deadline: null })) }
      }
      const me = principalAgent(c.principal)
      const rows = [...jobs.values()].filter((j) => j.job.buyer_agent_id === me || j.job.seller_agent_id === me).map((j) => ({ js: j, role: (j.job.buyer_agent_id === me ? 'buyer' : 'seller') as 'buyer' | 'seller' }))
        .filter((r) => !i.role || r.role === i.role).filter((r) => !i.state || r.js.job.state === i.state)
        .filter((r) => !i.needs_action || (!['SETTLED', 'CANCELLED', 'EXPIRED'].includes(r.js.job.state) && nextActions(r.js, r.role).some((a) => a.op !== 'wait_for_events')))
        .sort((a, b) => b.js.job.updated_at.localeCompare(a.js.job.updated_at)).slice(0, i.limit)
      return { jobs: rows.map(({ js, role }) => ({ id: js.job.id, state: js.job.state, title: js.job.title, seller_bot_id: js.job.seller_bot_id, buyer_agent_id: js.job.buyer_agent_id, updated_at: js.job.updated_at, your_role: role, held: js.job.escrow.status === 'authorized' ? js.job.escrow.authorized : money('0.00'), next_deadline: js.job.deadlines.deliver_by ?? js.job.deadlines.fund_by })) }
    },
    async get_messages(c, i) {
      const { js } = loadJob(c, i.job_id)
      return { messages: js.messages.filter((m) => m.seq > i.after_seq).slice(0, i.limit), chain_valid: true }
    },
    async wait_for_events(c, i) {
      const r = await core.events.wait({ principal: c.principal, after_cursor: i.after_cursor, ...(i.job_id ? { job_id: i.job_id } : {}), ...(i.types ? { types: i.types } : {}) }, i.timeout_seconds * 1000)
      return r
    },
  }

  // ---------- the Core ----------
  const core: StubCore = {
    handlers: H as unknown as Handlers,
    config: { publicUrl, paymentRail: rail, aiProvider: 'stub', demoMode: opts.demoMode ?? true },
    auth: {
      async agentFromApiKey(key) {
        const aid = keys.get(key)
        return aid ? { kind: 'agent', agent_id: aid, owner_id: agents.get(aid)?.owner_id ?? null } : null
      },
      async userFromSession(token) {
        const u = USERS[token.replace(/^sess_/, '') as keyof typeof USERS]
        return u ? { kind: 'user', ...u } : null
      },
      async demoSignIn(persona) {
        const u = USERS[persona]
        return { token: `sess_${persona}`, principal: { kind: 'user', ...u } }
      },
      async session(p) {
        if (p.kind === 'user') {
          const role = p.roles.includes('arbiter') ? 'arbiter' : p.user_id === USERS.seller.user_id ? 'seller' : 'owner'
          return { user: { id: p.user_id, name: p.name, role }, agents: [...agents.values()].filter((a) => a.owner_id === p.user_id) }
        }
        if (p.kind === 'agent') return { user: null, agents: [agents.get(p.agent_id)].filter(Boolean) }
        return { user: null, agents: [] }
      },
    },
    events: {
      list,
      async wait(filter, timeoutMs, signal) {
        const first = await list(filter)
        if (first.events.length || timeoutMs <= 0) return { ...first, timed_out: true }
        return new Promise((resolve) => {
          const done = async (timed_out: boolean) => {
            clearTimeout(timer)
            waiters.delete(check)
            signal?.removeEventListener('abort', onAbort)
            resolve({ ...(await list(filter)), timed_out })
          }
          const check = () => void list(filter).then((r) => r.events.length && void done(false))
          const onAbort = () => void done(true)
          const timer = setTimeout(() => void done(true), timeoutMs)
          waiters.add(check)
          signal?.addEventListener('abort', onAbort)
        })
      },
      subscribe(filter, onEvent) {
        const l = { filter, fn: onEvent }
        listeners.add(l)
        return () => void listeners.delete(l)
      },
      latestCursor: () => events.length,
    },
    payments: {
      async handleWebhook(_h, raw) {
        let type: string | null = null
        try {
          type = JSON.parse(raw).event_type ?? null
        } catch {
          return { accepted: false, event_type: null, note: 'not JSON' }
        }
        return { accepted: true, event_type: type, note: `received ${raw.length} bytes` }
      },
      async onOrderReturn(q) {
        return { redirect: `/jobs?returned=${encodeURIComponent(q.token ?? '')}` }
      },
      async onVaultReturn(q) {
        return { redirect: `/mandates?returned=${encodeURIComponent(q.setup_token_id ?? '')}` }
      },
      ...(rail === 'simulated'
        ? {
            async simulatedInfo(kind: 'order' | 'vault', ident: string) {
              if (kind === 'vault') {
                const m = [...mandates.values()].find((x) => x.id === ident)
                return m ? { kind, id: ident, title: 'Approve a spending mandate', amount: m.monthly_cap.value, currency: 'USD' as const, lines: [{ label: 'Per-job cap', value: `$${m.per_job_cap.value}` }], return_to: '/account' } : null
              }
              const js = [...jobs.values()].find((j) => j.job.escrow.paypal.order_id === ident)
              return js ? { kind, id: ident, title: `Authorize escrow for "${js.job.title}"`, amount: js.job.contract.quote.total_max.value, currency: 'USD' as const, job_id: js.job.id, lines: [{ label: 'Job', value: js.job.title }], return_to: `/jobs/${js.job.id}` } : null
            },
            async simulatedApprove(kind: 'order' | 'vault', ident: string, approve: boolean) {
              if (kind === 'vault') {
                const m = [...mandates.values()].find((x) => x.id === ident)
                if (!m) throw new OpError('not_found', 'No such mandate.', 'Check the id.')
                m.status = approve ? 'active' : 'revoked'
                m.approval_url = null
                emit('mandate', null, `Mandate ${m.status}`, [m.agent_id], { mandate_id: m.id })
                return { redirect: '/mandates' }
              }
              const js = [...jobs.values()].find((j) => j.job.escrow.paypal.order_id === ident)
              if (!js) throw new OpError('not_found', 'No such order.', 'Check the id.')
              if (approve && js.job.state === 'AWAITING_APPROVAL') setEscrowAuthorized(js, 'human approved on PayPal')
              return { redirect: `/jobs/${js.job.id}` }
            },
          }
        : {}),
    },
    artifacts: {
      async read(aid, principal) {
        const a = artifacts.get(aid)
        if (!a) return null
        const me = agentOf(principal)
        const job = a.meta.job_id ? jobs.get(a.meta.job_id) : null
        const party = !!job && !!me && (job.job.buyer_agent_id === me || job.job.seller_agent_id === me)
        const arbiter = principal.kind === 'user' && principal.roles.includes('arbiter')
        if (!(a.meta.uploaded_by === me || party || arbiter)) return null
        return { mime: a.mime, name: a.name, bytes: a.bytes }
      },
    },
    public: {
      async stats() {
        const all = [...jobs.values()]
        const held = all.filter((j) => j.job.escrow.status === 'authorized').reduce((s, j) => s + cents(j.job.escrow.authorized.value), 0)
        return {
          bots_listed: [...bots.values()].filter((b) => b.status === 'listed').length, jobs_total: all.length, jobs_settled: all.filter((j) => j.job.state === 'SETTLED').length,
          held_now: amount(held), released_total: amount(all.reduce((s, j) => s + cents(j.job.escrow.captured.value), 0)), voided_total: amount(all.reduce((s, j) => s + cents(j.job.escrow.voided.value), 0)),
          disputes_total: all.filter((j) => j.job.ruling).length, median_dispute_minutes: 4, payment_rail: rail,
          units_verified: all.reduce((s, j) => s + j.job.fulfilment.reduce((n: number, f: { passed_units: number }) => n + f.passed_units, 0), 0),
        }
      },
      async feed(limit = 30): Promise<FeedItem[]> {
        return events.slice(-limit).reverse().map(({ e }) => ({ ts: e.ts, kind: e.type === 'bot' ? 'bot_listed' : e.type === 'ruling' ? 'ruling' : e.type === 'escrow' ? 'captured' : 'job_opened', text: e.summary, amount: null }))
      },
    },
    demo: {
      async reset() {
        agents.clear(); keys.clear(); bots.clear(); jobs.clear(); mandates.clear(); artifacts.clear(); fundKeys.clear(); events.length = 0
        if (opts.seed !== false) seed()
      },
    },
    async close() {
      listeners.clear()
    },
    stub: { emit, keys: demoKeys, jobs },
  }

  const USERS = {
    owner: { user_id: 'usr_manu0001', name: 'Manu', roles: ['owner' as const], act_as: 'agt_oranogrowth001' },
    arbiter: { user_id: 'usr_arbiter001', name: 'Ava (arbiter)', roles: ['arbiter' as const], act_as: 'agt_arbiter0001' },
    seller: { user_id: 'usr_glob0001', name: 'Glob Studio', roles: ['owner' as const], act_as: 'agt_dirblaster0001' },
  }

  // ---------- seed: the demo story ----------
  function seed() {
    const mk = (agentId: string, name: string, extra: A = {}) => {
      const a = { id: agentId, name, description: '', owner_id: null, claimed: false, payout_email: null, created_at: ts(-30 * DAY), ...extra }
      agents.set(agentId, a)
      return a
    }
    mk('agt_oranogrowth001', 'ORANO Growth Agent', { owner_id: 'usr_manu0001', claimed: true, description: 'Runs launch growth for ORANO.' })
    mk('agt_dirblaster0001', 'Directory Blaster Ops', { owner_id: 'usr_glob0001', claimed: true, payout_email: 'payouts@globstudio.example' })
    mk('agt_inboxoutreach1', 'Inbox Outreach Ops', { owner_id: 'usr_glob0001', claimed: true, payout_email: 'payouts@globstudio.example' })
    mk('agt_redteam000001', 'Red Team Ops', { owner_id: 'usr_glob0001', claimed: true, payout_email: 'payouts@globstudio.example' })
    mk('agt_arbiter0001', 'Arbiter console')
    keys.set(demoKeys.buyer, 'agt_oranogrowth001')
    keys.set(demoKeys.seller, 'agt_dirblaster0001')
    mandates.set('agt_oranogrowth001', { id: 'mdt_oranodemo001', agent_id: 'agt_oranogrowth001', owner_id: 'usr_manu0001', status: 'active', monthly_cap: money('200.00'), per_job_cap: money('100.00'), categories: ['real_world_action', 'reach'], expires_at: ts(30 * DAY), spent_this_month: money('60.00'), approval_url: null, rail, created_at: ts(-2 * DAY) })

    const skill = (sid: string, title: string, price: string, unit: string, checks: string[], extra: A = {}) => ({
      id: sid, title, description: title, needs: { type: 'object', properties: { product_name: { type: 'string' }, url: { type: 'string', format: 'uri' } }, required: ['product_name', 'url'] },
      delivers: { type: 'object', properties: { url: { type: 'string' } } }, checks, pricing: { model: 'per_unit', currency: 'USD', price, unit, min_units: 10, max_units: 200 }, turnaround: 'P7D', verify_window: 'P14D', examples: [], ...extra,
    })
    addBot({ id: 'bot_directoryblaster', operator_agent_id: 'agt_dirblaster0001', name: 'Directory Blaster', tagline: 'Live listings on 120+ startup and AI directories, proven one by one.', description: 'Submits your product to startup, AI and SaaS directories and proves each listing is live.', capability_class: 'real_world_action', mode: 'demo', skills: [skill('directory_submission', 'Submit a product to directories', '1.50', 'verified_listing', ['listing_url_live', 'listing_mentions_product', 'screenshot_attached'])], reputation: reputation(23) })
    addBot({ id: 'bot_inboxoutreach1', operator_agent_id: 'agt_inboxoutreach1', name: 'Inbox Outreach', tagline: 'Investor and press emails from a warmed domain.', description: 'Sends personalised outreach from warmed inboxes and proves delivery.', capability_class: 'reach', mode: 'demo', skills: [skill('investor_outreach', 'Send personalised outreach emails', '0.80', 'sent_email', ['email_sent'])], reputation: reputation(11) })
    addBot({ id: 'bot_redteamprobe01', operator_agent_id: 'agt_redteam000001', name: 'Red Team Probe', tagline: 'Prompt-injection tests against your own agent.', description: 'Authorized offensive testing; needs scope proof.', capability_class: 'security', mode: 'demo', policy: { class: 'restricted', requires_scope_proof: true, notes: 'Scope proof required.' }, skills: [skill('agent_red_team', 'Red-team an agent', '5.00', 'finding', ['json_schema_valid'], { pricing: { model: 'per_unit', currency: 'USD', price: '5.00', unit: 'finding', min_units: 10, max_units: 200, extras: [{ id: 'crawl_report', title: 'Crawl report', price: '5.00', checks: ['report_sections_present'], recommended: true }] } })], reputation: reputation(4) })

    // The demo job: 31 of 40 listings verified, disputed, ruled.
    const bot = bots.get('bot_directoryblaster')!
    const spec = {
      skill_id: 'directory_submission', goal: 'Get ORANO listed on 40 AI and productivity directories before launch',
      deliverables: [{ id: 'D1', description: 'At least 40 live directory listings for ORANO', quantity: 40, acceptance: [{ check: 'listing_url_live', params: { status: 200 } }, { check: 'listing_mentions_product', params: { must_include: ['ORANO'] } }], rubric: '' }],
      deadline: ts(5 * DAY), budget_cap: money('80.00'), out_of_scope: ['paid directories'], context: 'ORANO: https://oranoai.com', context_artifact_ids: [],
    }
    // A second demo job, mid-negotiation: 15 of 20 verified, proposals open for both sides (created first so the 31/40 job stays the newest).
    const spec2 = { ...spec, goal: 'Get ORANO listed on 20 more directories', deliverables: [{ ...spec.deliverables[0], quantity: 20 }] }
    const j2 = newJob('agt_oranogrowth001', bot, spec2, 'ORANO directory launch, wave 2 (20 listings)', true, 'job_demomediation1')
    addMessage(j2, who(j2, 'buyer'), 'job_spec', spec2.goal, spec2)
    mockSellerReply(j2)
    const hash2 = j2.job.contract_hash
    for (const r of ['buyer', 'seller'] as const) j2.job.accepted_by.push({ role: r, agent_id: r === 'buyer' ? 'agt_oranogrowth001' : 'agt_dirblaster0001', contract_hash: hash2, ts: ts(-2 * DAY) })
    setEscrowAuthorized(j2, 'within mandate')
    const units2 = Array.from({ length: 20 }, (_, n) => ({ ref: `directory-${n + 1}`, url: `https://dir${n + 1}.sandbox.example/orano`, artifact_ids: [], meta: n >= 15 ? { fail: true } : {} }))
    const del2 = { deliverables: [{ deliverable_id: 'D1', units: units2, note: '' }], note: 'All 20 submitted.' }
    addMessage(j2, who(j2, 'seller'), 'delivery', 'Delivery submitted.', del2)
    runChecks(j2, del2)
    addMessage(j2, who(j2, 'buyer'), 'dispute', '5 of 20 listings never went live.', { claims: ['5 listings return 404'] })
    j2.job.mediation = mediationFixture(j2, 15, 20, 'negotiating')
    j2.job.state = 'DISPUTED'
    addMessage(j2, { kind: 'mediator', id: 'mediator', role: 'mediator' }, 'proposal', 'Round 1 of 3. Options: a split, or a redo.', { round: 1, proposals: j2.job.mediation.proposals.map((p: A) => ({ id: p.id, kind: p.kind, terms: p.terms })) })

    const js = newJob('agt_oranogrowth001', bot, spec, 'ORANO directory launch (40 listings)', true, 'job_demo31of40')
    addMessage(js, who(js, 'buyer'), 'job_spec', spec.goal, spec)
    mockSellerReply(js)
    const hash = js.job.contract_hash
    for (const r of ['buyer', 'seller'] as const) js.job.accepted_by.push({ role: r, agent_id: r === 'buyer' ? 'agt_oranogrowth001' : 'agt_dirblaster0001', contract_hash: hash, ts: ts(-3 * DAY) })
    addMessage(js, who(js, 'buyer'), 'accept', 'Accepted.', { contract_hash: hash })
    addMessage(js, who(js, 'seller'), 'accept', 'Accepted.', { contract_hash: hash })
    setEscrowAuthorized(js, 'within mandate')
    const units = Array.from({ length: 40 }, (_, n) => ({ ref: `directory-${n + 1}`, url: `https://dir${n + 1}.sandbox.example/orano`, artifact_ids: [], meta: n >= 31 ? { fail: true } : {} }))
    addMessage(js, who(js, 'seller'), 'progress', '40 submitted', { percent: 100 })
    const del = { deliverables: [{ deliverable_id: 'D1', units, note: '' }], note: 'All 40 submitted.' }
    addMessage(js, who(js, 'seller'), 'delivery', 'Delivery submitted.', del)
    runChecks(js, del)
    js.job.state = 'DELIVERED'
    addMessage(js, who(js, 'buyer'), 'dispute', '9 of 40 listings never went live.', { claims: ['9 listings return 404'] })
    js.job.mediation = mediationFixture(js, 31, 40, 'no_agreement')
    js.job.ruling = rulingFixture(js, 31, 40)
    js.job.state = 'RULED'
    js.job.deadlines.appeal_until = js.job.ruling.appealable_until
    addMessage(js, { kind: 'mediator', id: 'mediator', role: 'mediator' }, 'ruling', js.job.ruling.reasoning)

  }
  if (opts.seed !== false) seed()
  return core
}
