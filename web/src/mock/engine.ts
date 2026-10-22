// Mock engine core: room messages, state changes, escrow money moves, acceptance checks.
// No browser APIs besides an optional `location.origin`, so it also runs under Node for the story test.
import type { Artifact, CheckResult, Contract, Delivery, EscrowEvent, Fulfilment, Job, Message, Role } from '../api/types'
import { emit } from './bus'
import type { Db } from './db'
import { fail } from './logic'
import { DAY, amt, cents, fakeHash, iso, parseDuration, rid, usd } from './util'

// ---------------------------------------------------------------- timing
let scale = 1
/** Tests shrink every simulated delay: setTimeScale(0.01). */
export const setTimeScale = (n: number) => {
  scale = n
}
export const later = (ms: number, fn: () => void) =>
  setTimeout(() => {
    try {
      fn()
    } catch (e) {
      console.error('[mock engine]', e)
    }
  }, ms * scale)

export const origin = () => (typeof location !== 'undefined' ? location.origin : 'http://localhost:5173')

/** Hooks filled in by story.ts (avoids a circular import). */
export const hooks: { onFunded: (db: Db, job: Job) => void } = { onFunded: () => {} }

/** Platform commission on cumulative captured money: max($3.00, 15%), never more than what was captured. Taken from the seller's share. */
export const PLATFORM_BPS = 1500
export const MIN_FEE = 300
export const feeFor = (captured: number) => (captured <= 0 ? 0 : Math.min(captured, Math.max(MIN_FEE, Math.round((captured * PLATFORM_BPS) / 10000))))
/** Smallest gross capture whose seller share (after fee) is `net`. */
export const grossFromNet = (net: number) => {
  let g = Math.round(net / (1 - PLATFORM_BPS / 10000))
  if (feeFor(g) === MIN_FEE || g * (PLATFORM_BPS / 10000) < MIN_FEE) g = net + MIN_FEE
  return g
}

// ---------------------------------------------------------------- messages and state
export type PartyKey = 'buyer' | 'seller' | 'platform' | 'mediator' | 'arbiter'
export function party(job: Job, key: PartyKey, userId = 'usr_Arbiter0001'): Message['from'] {
  if (key === 'buyer') return { kind: 'agent', id: job.buyer_agent_id, role: 'buyer' }
  if (key === 'seller') return { kind: 'agent', id: job.seller_agent_id, role: 'seller' }
  if (key === 'mediator') return { kind: 'mediator', id: 'mediator', role: 'mediator' }
  if (key === 'arbiter') return { kind: 'user', id: userId, role: 'arbiter' }
  return { kind: 'platform', id: 'platform', role: 'platform' }
}

export function touch(job: Job) {
  job.updated_at = new Date().toISOString()
  job.message_count = 0
}

export function append(db: Db, job: Job, from: PartyKey | Message['from'], type: Message['type'], text = '', body: Record<string, unknown> = {}, artifacts: string[] = []): Message {
  const list = (db.messages[job.id] ??= [])
  const prev = list[list.length - 1]
  const seq = list.length
  const hash = fakeHash(`${prev?.hash ?? null}|${seq}|${type}|${text}|${JSON.stringify(body).slice(0, 4000)}`)
  const m: Message = {
    id: `msg_${job.id.slice(4, 14)}${String(seq).padStart(3, '0')}`,
    job_id: job.id,
    seq,
    from: typeof from === 'string' ? party(job, from) : from,
    type,
    text,
    body,
    artifact_ids: artifacts,
    prev_hash: prev?.hash ?? null,
    hash,
    ts: new Date().toISOString(),
  }
  list.push(m)
  job.message_count = list.length
  job.updated_at = m.ts
  emit('message', job.id, `${type}: ${text}`.slice(0, 200), { message_id: m.id, seq, type })
  return m
}

export function system(db: Db, job: Job, text: string, body: Record<string, unknown> = {}) {
  return append(db, job, 'platform', 'system', text, body)
}

export function setState(job: Job, state: Job['state'], why = '') {
  if (job.state === state) return
  job.state = state
  job.updated_at = new Date().toISOString()
  emit('state', job.id, `Job is now ${state}${why ? `: ${why}` : ''}`.slice(0, 250), { state })
}

export function rehash(job: Job) {
  if (!job.contract) return
  job.contract_hash = fakeHash(JSON.stringify(job.contract))
  job.accepted_by = []
}

export function makeArtifact(db: Db, jobId: string | null, name: string, mime: string, uploadedBy: string, bytes?: number): Artifact {
  const id = rid('art')
  const a: Artifact = {
    id,
    job_id: jobId,
    name,
    mime,
    bytes: bytes ?? 120_000 + Math.floor(Math.abs(Math.sin(db.scratch ? Object.keys(db.artifacts).length + 1 : 1)) * 90_000),
    sha256: fakeHash(`${id}${name}`),
    url: `/api/artifacts/${id}`,
    uploaded_by: uploadedBy,
    created_at: new Date().toISOString(),
  }
  db.artifacts[id] = a
  return a
}

// ---------------------------------------------------------------- escrow
const ppChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'
export function ppId(prefix = ''): string {
  const raw = (rid('x') + rid('y')).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  let s = ''
  for (const c of raw) s += ppChars[c.charCodeAt(0) % ppChars.length]
  return (prefix + s).slice(0, 17)
}

export function pushEvent(db: Db, job: Job, kind: EscrowEvent['kind'], c: number | null, paypalId: string | null, webhook: string | null, note = '') {
  job.escrow.events.push({ kind, amount: c === null ? null : usd(c), paypal_id: paypalId, webhook_event: webhook, note, ts: new Date().toISOString() })
  emit('escrow', job.id, `${kind}${c ? ` $${amt(c)}` : ''}${webhook ? ` (${webhook})` : ''}`, { kind, amount: c === null ? null : amt(c) })
  void db
}

export const total = (job: Job) => cents(job.contract?.quote.total_max.value ?? 0)
export const heldCents = (job: Job) => Math.max(cents(job.escrow.authorized.value) - cents(job.escrow.captured.value) - cents(job.escrow.voided.value) - cents(job.escrow.refunded.value), 0)

export function mandateCovers(db: Db, job: Job, agentId: string | null): { ok: boolean; why: string } {
  const m = agentId ? db.mandates[agentId] : undefined
  const bot = db.bots[job.seller_bot_id]
  const t = total(job)
  if (!m) return { ok: false, why: 'This agent has no spending mandate.' }
  if (m.status !== 'active') return { ok: false, why: `The mandate is ${m.status.replace('_', ' ')}.` }
  if (new Date(m.expires_at).getTime() < Date.now()) return { ok: false, why: 'The mandate has expired.' }
  if (t > cents(m.per_job_cap.value)) return { ok: false, why: `$${amt(t)} is over the per-job cap of $${m.per_job_cap.value}.` }
  if (cents(m.spent_this_month.value) + t > cents(m.monthly_cap.value)) return { ok: false, why: 'This would pass the monthly cap.' }
  if (bot && !m.categories.includes(bot.capability_class)) return { ok: false, why: `The mandate does not cover ${bot.capability_class.replace(/_/g, ' ')} jobs.` }
  return { ok: true, why: '' }
}

/** Creates the PayPal order and asks a human to approve it. */
export function requireApproval(db: Db, job: Job, why: string) {
  const e = job.escrow
  const order = e.paypal.order_id ?? ppId('5O')
  e.paypal.order_id = order
  e.status = 'pending_approval'
  e.approval_url = `${origin()}/sim/paypal/order/${order}`
  pushEvent(db, job, 'order_created', total(job), order, null, 'AUTHORIZE order created')
  pushEvent(db, job, 'approval_required', total(job), order, null, why)
  setState(job, 'AWAITING_APPROVAL', 'waiting for PayPal approval')
  system(db, job, `Funding needs a human approval on PayPal. ${why}`, { event: 'approval_required', amount: amt(total(job)), paypal_id: order })
}

/** Money is authorized, not taken. Moves the job to IN_PROGRESS and wakes the seller bot. */
export function authorize(db: Db, job: Job, viaMandate: boolean) {
  const e = job.escrow
  const t = total(job)
  const order = e.paypal.order_id ?? ppId('5O')
  const auth = ppId('9')
  const now = Date.now()
  if (!e.paypal.order_id) pushEvent(db, job, 'order_created', t, order, 'CHECKOUT.ORDER.APPROVED', 'AUTHORIZE order created')
  else pushEvent(db, job, 'order_created', t, order, 'CHECKOUT.ORDER.APPROVED', 'Buyer approved the order')
  e.paypal.order_id = order
  e.paypal.authorization_id = auth
  e.status = 'authorized'
  e.authorized = usd(t)
  e.approval_url = null
  e.honor_expires_at = iso(now + 3 * DAY)
  e.authorization_expires_at = iso(now + 29 * DAY)
  pushEvent(db, job, 'authorized', t, auth, 'PAYMENT.AUTHORIZATION.CREATED', "Held on the buyer's PayPal account, not taken")
  const mandate = db.mandates[job.buyer_agent_id]
  if (viaMandate && mandate) {
    mandate.spent_this_month = usd(cents(mandate.spent_this_month.value) + t)
    db.scratch[`viaMandate:${job.id}`] = true
    emit('mandate', null, `Mandate spend now $${mandate.spent_this_month.value} of $${mandate.monthly_cap.value}`, { mandate_id: mandate.id })
  }
  job.deadlines.fund_by = null
  const turnaround = parseDuration(job.contract?.quote.turnaround ?? 'P7D')
  const spec = job.contract ? new Date(job.contract.spec.deadline).getTime() : 0
  job.deadlines.deliver_by = iso(Math.max(spec, now + turnaround))
  setState(job, 'IN_PROGRESS', 'escrow authorized')
  system(db, job, `Escrow AUTHORIZED $${amt(t)} on PayPal. Held, not taken.${viaMandate ? ` Within mandate ${mandate?.id}.` : ''}`, { event: 'authorized', amount: amt(t), paypal_id: auth, webhook: 'PAYMENT.AUTHORIZATION.CREATED' })
  const secrets = Object.keys((db.scratch[`secrets:${job.id}`] as Record<string, unknown> | undefined) ?? {})
  if (secrets.length) system(db, job, `${secrets.length} sealed secret${secrets.length > 1 ? 's' : ''} unsealed for the seller.`, { event: 'secrets_unsealed' })
  hooks.onFunded(db, job)
}

/** Capture up to `targetGross` in total (partial capture), then pay the seller the share after the platform fee. */
export function captureUpTo(db: Db, job: Job, targetGross: number, label: string): number {
  const e = job.escrow
  const already = cents(e.captured.value)
  const capped = Math.min(targetGross, cents(e.authorized.value))
  const delta = capped - already
  if (delta <= 0) return 0
  const fee = feeFor(already + delta) - feeFor(already)
  const net = delta - fee
  const cap = ppId('4R')
  const payout = `PAYOUT-ITEM-${ppId().slice(0, 5)}`
  e.captured = usd(already + delta)
  e.fees = usd(cents(e.fees.value) + fee)
  e.paid_out = usd(cents(e.paid_out.value) + net)
  e.status = 'partially_captured'
  e.paypal.capture_ids.push(cap)
  e.paypal.payout_item_ids.push(payout)
  pushEvent(db, job, 'captured', delta, cap, 'PAYMENT.CAPTURE.COMPLETED', label)
  system(db, job, `${label} Captured $${amt(delta)}.`, { event: 'captured', amount: amt(delta), paypal_id: cap, webhook: 'PAYMENT.CAPTURE.COMPLETED' })
  pushEvent(db, job, 'payout_sent', net, payout, null, fee ? `Captured minus platform fee $${amt(fee)} (15%, min $3.00)` : 'Captured; minimum platform fee already taken')
  pushEvent(db, job, 'payout_succeeded', net, payout, 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED')
  system(db, job, `Payout sent to seller: $${amt(net)} (captured $${amt(delta)} minus platform fee $${amt(fee)}, 15% of captured, min $3.00).`, { event: 'payout_succeeded', amount: amt(net), paypal_id: payout, webhook: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' })
  return delta
}

/** Void whatever was never captured and close the ledger. */
export function settleEscrow(db: Db, job: Job, note = 'Uncaptured remainder released back to the buyer') {
  const e = job.escrow
  if (e.status === 'none' || e.status === 'pending_approval') {
    e.status = 'none'
    e.approval_url = null
    return
  }
  const auth = cents(e.authorized.value)
  const cap = cents(e.captured.value)
  const rest = Math.max(auth - cap - cents(e.voided.value), 0)
  if (rest > 0) {
    e.voided = usd(cents(e.voided.value) + rest)
    pushEvent(db, job, 'voided', rest, e.paypal.authorization_id, 'PAYMENT.AUTHORIZATION.VOIDED', note)
    system(db, job, `VOIDED $${amt(rest)}. It never left the buyer's PayPal account.`, { event: 'voided', amount: amt(rest), paypal_id: e.paypal.authorization_id, webhook: 'PAYMENT.AUTHORIZATION.VOIDED' })
    if (db.scratch[`viaMandate:${job.id}`]) {
      const m = db.mandates[job.buyer_agent_id]
      if (m) m.spent_this_month = usd(Math.max(cents(m.spent_this_month.value) - rest, 0))
    }
  }
  const refunded = cents(e.refunded.value)
  e.status = cap === 0 ? 'voided' : refunded > 0 && refunded >= cap ? 'refunded' : 'settled'
}

// ---------------------------------------------------------------- acceptance checks
const DETAIL: Record<string, [string, string]> = {
  listing_url_live: ['HTTP 200', 'HTTP 404 on listing URL'],
  listing_mentions_product: ['found the product name and domain', 'page does not mention the product'],
  screenshot_attached: ['screenshot present', 'no screenshot attached'],
  lead_verified: ['address found on company site; MX accepts mail', 'address not found on the company site'],
  lint_passed: ['lint clean', 'lint failed: too long or a spam trigger'],
  email_sent: ['Message-ID found in Sent folder', 'Message-ID not found'],
  report_sections_present: ['all required sections present', 'required sections missing'],
  finding_reproduces: ['finding reproduced on replay', 'finding did not reproduce'],
  deliverability_ok: ['SPF, DKIM and DMARC pass', 'DMARC record missing'],
  scope_proof_valid: ['scope proof found', 'no scope proof found'],
}

function spread(n: number, k: number): number[] {
  const out: number[] = []
  for (let j = 0; j < k; j++) out.push(Math.min(n - 1, Math.floor(((j + 0.5) * n) / k)))
  return [...new Set(out)].sort((a, b) => a - b)
}

export function runChecks(db: Db, job: Job, delivery: Delivery, attempt: number): CheckResult[] {
  const spec = job.contract!.spec
  const out: CheckResult[] = []
  const ts = new Date().toISOString()
  const mk = (d: string, ref: string | null, check: string, status: CheckResult['status'], detail: string): CheckResult => ({
    id: rid('chk'),
    job_id: job.id,
    deliverable_id: d,
    unit_ref: ref,
    check,
    status,
    detail,
    evidence_id: rid('ev'),
    attempt,
    ran_at: ts,
  })
  for (const d of spec.deliverables) {
    const units = (delivery.deliverables.find((x) => x.deliverable_id === d.id)?.units ?? []).slice(0, d.quantity)
    const defs = d.acceptance.map((a) => ({ id: a.check, per: db.checks.find((c) => c.id === a.check)?.per_unit ?? true }))
    const per = defs.filter((x) => x.per)
    const k1 = Math.round(units.length * 0.225)
    const k = attempt <= 1 ? k1 : Math.round(k1 * 0.4)
    const failIdx = spread(units.length, k1).slice(0, k)
    const firstGroup = Math.ceil(failIdx.length * 0.55)
    units.forEach((u, i) => {
      const p = failIdx.indexOf(i)
      const failAt = p < 0 ? -1 : p < firstGroup ? 0 : Math.min(1, per.length - 1)
      per.forEach((c, j) => {
        const [okText, badText] = DETAIL[c.id] ?? ['passed', 'failed']
        if (j === failAt) out.push(mk(d.id, u.ref, c.id, 'fail', badText))
        else if (failAt === 0 && j === 1) out.push(mk(d.id, u.ref, c.id, 'error', 'not run: the previous check failed'))
        else out.push(mk(d.id, u.ref, c.id, 'pass', okText))
      })
    })
    for (const c of defs.filter((x) => !x.per)) out.push(mk(d.id, null, c.id, units.length ? 'pass' : 'fail', (DETAIL[c.id] ?? ['passed', 'failed'])[units.length ? 0 : 1]))
  }
  return out
}

export function computeFulfilment(db: Db, job: Job, delivery: Delivery, checks: CheckResult[]): Fulfilment[] {
  const contract = job.contract as Contract
  return contract.spec.deliverables.map((d) => {
    const units = (delivery.deliverables.find((x) => x.deliverable_id === d.id)?.units ?? []).slice(0, d.quantity)
    const per = d.acceptance.filter((a) => db.checks.find((c) => c.id === a.check)?.per_unit ?? true).map((a) => a.check)
    const bad = new Set(checks.filter((c) => c.deliverable_id === d.id && c.unit_ref !== null && c.status !== 'pass').map((c) => c.unit_ref))
    const pend = new Set(checks.filter((c) => c.deliverable_id === d.id && c.status === 'pending').map((c) => c.unit_ref))
    const passed = per.length ? units.filter((u) => !bad.has(u.ref)).length : units.length
    const pending = units.filter((u) => pend.has(u.ref)).length
    const line = contract.quote.lines.find((l) => l.deliverable_id === d.id)
    let earned = 0
    if (line) {
      const price = cents(line.unit_price)
      earned = line.model === 'per_unit' ? passed * price : Math.round((price * passed) / Math.max(d.quantity, 1))
      earned = Math.min(earned, cents(line.max_total))
    }
    return { deliverable_id: d.id, expected_units: d.quantity, passed_units: passed, pending_units: pending, failed_units: Math.max(units.length - passed - pending, 0) + Math.max(d.quantity - units.length, 0), earned: usd(earned) }
  })
}

export const earnedTotal = (job: Job) => job.fulfilment.reduce((a, f) => a + cents(f.earned.value), 0)

/** Run the contract's checks on a delivery, store results, capture what passed, open the review window. */
export function processDelivery(db: Db, job: Job, delivery: Delivery): { checks: CheckResult[]; fulfilment: Fulfilment[] } {
  const contract = job.contract
  if (!contract) fail(409, 'invalid_state', 'There is no contract to check against.', 'A delivery needs an agreed contract.')
  const ids = new Set(contract!.spec.deliverables.map((d) => d.id))
  for (const d of delivery.deliverables) if (!ids.has(d.deliverable_id)) fail(400, 'invalid_input', `Unknown deliverable ${d.deliverable_id}.`, `Use one of: ${[...ids].join(', ')}.`)
  const attempt = ((db.scratch[`attempt:${job.id}`] as number | undefined) ?? 0) + 1
  db.scratch[`attempt:${job.id}`] = attempt
  db.scratch[`delivery:${job.id}`] = delivery
  const checks = runChecks(db, job, delivery, attempt)
  db.scratch[`checks:${job.id}`] = checks
  const fulfilment = computeFulfilment(db, job, delivery, checks)
  job.fulfilment = fulfilment
  append(db, job, 'seller', 'delivery', attempt > 1 ? 'Redelivery after the cure window.' : 'Delivery submitted.', { delivery, checks })
  emit('check', job.id, `${checks.filter((c) => c.status === 'pass').length} of ${checks.length} checks passed`, { attempt })
  const passed = fulfilment.reduce((a, f) => a + f.passed_units, 0)
  const expected = fulfilment.reduce((a, f) => a + f.expected_units, 0)
  const earned = earnedTotal(job)
  const first = contract!.quote.lines[0]
  const label = `Checks ran: ${passed} of ${expected} units verified${first?.model === 'per_unit' ? ` (${passed} x $${first.unit_price})` : ''}.`
  const delta = captureUpTo(db, job, earned, label)
  if (!delta) system(db, job, `${label} Nothing new to capture.`, { event: 'checks' })
  setState(job, 'DELIVERED', 'checks ran, review window open')
  const t = parseDuration
  job.deadlines.review_until = iso(Date.now() + t(contract!.timers.review_window))
  job.deadlines.cure_until = null
  job.deadlines.verify_until = t(contract!.timers.verify_window) > 0 ? iso(Date.now() + t(contract!.timers.verify_window)) : null
  return { checks, fulfilment }
}

export const roleLabel = (r: Role) => (r === 'buyer' ? 'Buyer' : r === 'seller' ? 'Seller' : r)
