// Escrow service: the ONLY code that calls the payment rail.
//
// Commit rule: a money state is committed when PayPal reports a final status for the resource,
// either in the synchronous API response or in the webhook, whichever arrives first. PayPal's
// synchronous answer is itself authoritative; webhooks are recorded as confirmations on the same
// escrow event (`webhook_event`). Anything PayPal reports as PENDING (an authorization under review,
// a pending capture) is NOT committed: the job waits for the webhook, and payouts only ever follow
// COMPLETED captures. Payouts count as paid only on PAYMENT.PAYOUTS-ITEM.SUCCEEDED.
//
// Money math is integer cents. Platform fee = round-half-up(cumulative seller gross × bps / 10 000),
// recomputed on the cumulative release so partial releases never drift; payout = gross − fee −
// seller-side mediation fee, minus what was already sent.
import type { CapabilityClass, EscrowEventKind, Mandate } from '@rentabot/shared'
import { scaleMs } from '../config.ts'
import { json } from '../db/index.ts'
import { PaymentError, type AuthorizationInfo } from '../rails/types.ts'
import type { RailEvent } from '../rails/webhook.ts'
import type { Domain } from './domain.ts'
import { pendingCents, type JobRecord } from './model.ts'
import { OpError } from './types.ts'
import { refundKeptFee, sellerNet, type FeePolicy } from './fees.ts'
import { newId, toAmount, toCents, usd } from './util.ts'

const DAY = 86_400_000
/** What the buyer is told when the escrow switches to capture-and-hold (room message and fund_job notes). */
export const captureAndHoldNotice = (p: FeePolicy) =>
  `This job can outlive PayPal's 29-day authorization, so the escrow runs in capture-and-hold mode: the full amount is captured now and settled later by payout and refund. ` +
  `PayPal does not return its processing fee on refunded money, so any refund keeps ${p.paypal_capture_bps / 100}% of the refunded amount` +
  ` (plus PayPal's $${toAmount(p.paypal_capture_fixed_cents)} fixed fee and the $${toAmount(p.extra_settlement_cents)} extra-settlement fee if the seller earns nothing). A shorter deadline keeps the money only authorized and avoids this.`
/** Settlements so far: captures on an authorization hold, paid seller tranches in capture-and-hold mode (at least 1). */
export const settlementCount = (e: JobRecord['escrow']) => Math.max(1, e.mode === 'hold' ? e.capture_ids.length : (e.tranches ?? 0))
/** Marker on an escrow event whose final status was read from PayPal by the reconciler instead of a webhook. */
const RECONCILER = 'reconciler'
const HONOR_MS = 3 * DAY
const VALIDITY_MS = 29 * DAY

interface MandateRow {
  id: string
  agent_id: string
  data: string
  setup_token_id: string | null
  payment_token_id: string | null
  created_at: string
}

export class EscrowService {
  private d: Domain
  private fetchImpl: typeof fetch
  /** Feed hook (set by the stats module). */
  onMoney?: (rec: JobRecord, kind: EscrowEventKind, cents: number | null) => void

  constructor(d: Domain, fetchImpl: typeof fetch) {
    this.d = d
    this.fetchImpl = fetchImpl
  }

  // ---------- bookkeeping ----------
  private ref(paypal_id: string | null, kind: string, job_id: string | null, mandate_id: string | null = null) {
    if (!paypal_id) return
    this.d.db.run('INSERT OR IGNORE INTO paypal_refs (paypal_id, kind, job_id, mandate_id) VALUES (?, ?, ?, ?)', paypal_id, kind, job_id, mandate_id)
  }
  private event(rec: JobRecord, kind: EscrowEventKind, cents: number | null, paypal_id: string | null, note: string, webhook_event: string | null = null) {
    rec.escrow.events.push({ kind, amount: cents === null ? null : usd(cents), paypal_id, webhook_event, note: note.slice(0, 500), ts: this.d.nowIso() })
    this.d.bus.publish('escrow', rec.id, this.d.audience(rec), `${kind}${cents !== null ? ` $${toAmount(cents)}` : ''}`, { kind, amount: cents === null ? null : toAmount(cents), paypal_id, webhook_event })
    this.onMoney?.(rec, kind, cents)
  }
  /** Attach a webhook confirmation to the matching event, or record it when the webhook came first. */
  private confirm(rec: JobRecord, kind: EscrowEventKind, paypal_id: string | null, event_type: string, cents: number | null, note: string) {
    const ev = [...rec.escrow.events].reverse().find((e) => e.kind === kind && e.paypal_id === paypal_id && (!e.webhook_event || e.webhook_event === RECONCILER))
    if (ev) ev.webhook_event = event_type
    else this.event(rec, kind, cents, paypal_id, note, event_type)
  }
  /**
   * The `payout_sent` event is keyed by the payout batch, while the confirmation (webhook or reconciler) arrives keyed by the item,
   * so `confirm()` never found it and the ledger kept "awaiting webhook" on it for ever. Stamp it with whatever confirmed the payout.
   */
  private confirmPayoutSent(rec: JobRecord, item: { batch_id: string | null; sender_item_id: string }, event_type: string) {
    const ev = [...rec.escrow.events].reverse().find((x) => x.kind === 'payout_sent' && (!x.webhook_event || x.webhook_event === RECONCILER) && x.paypal_id !== null && (x.paypal_id === item.batch_id || x.paypal_id === item.sender_item_id))
    if (ev) ev.webhook_event = event_type
  }
  private refreshStatus(rec: JobRecord) {
    const e = rec.escrow
    if (e.status === 'none' || e.status === 'pending_approval') return
    if (e.finalized) e.status = e.mode === 'capture_and_hold' ? (e.refunded >= e.captured && e.captured > 0 ? 'refunded' : 'settled') : e.captured + pendingCents(e) > 0 ? 'settled' : 'voided'
    else e.status = e.mode === 'hold' && e.captured + pendingCents(e) > 0 ? 'partially_captured' : 'authorized'
  }
  /** Run a rail call with request-id bookkeeping: bump the counter after any definitive answer. */
  private async call<T>(rec: JobRecord, transition: string, fn: (request_id: string) => Promise<T>): Promise<T> {
    const id = this.d.requestId(rec, transition)
    try {
      const out = await fn(id)
      this.d.bumpRequest(rec, transition)
      return out
    } catch (e) {
      if (e instanceof PaymentError && e.definitive) this.d.bumpRequest(rec, transition)
      this.d.save(rec)
      throw e
    }
  }

  // ---------- mandates ----------
  private mandateRow(id: string) {
    return this.d.db.get<MandateRow>('SELECT * FROM mandates WHERE id = ?', id)
  }
  private saveMandate(m: Omit<Mandate, 'spent_this_month'>, setup: string | null, token: string | null) {
    this.d.db.run(
      `INSERT INTO mandates (id, agent_id, data, setup_token_id, payment_token_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, setup_token_id = excluded.setup_token_id, payment_token_id = excluded.payment_token_id`,
      m.id,
      m.agent_id,
      JSON.stringify(m),
      setup,
      token,
      m.created_at,
    )
  }
  mandateFor(agent_id: string): Mandate | null {
    const row = this.d.db.get<MandateRow>("SELECT * FROM mandates WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", agent_id)
    return row ? this.renderMandate(row) : null
  }
  private renderMandate(row: MandateRow): Mandate {
    const m = json<Omit<Mandate, 'spent_this_month'>>(row.data)
    if (m.status === 'active' && Date.parse(m.expires_at) < this.d.nowMs()) {
      m.status = 'expired'
      this.saveMandate(m, row.setup_token_id, row.payment_token_id)
    }
    return { ...m, spent_this_month: usd(this.spentThisMonth(m.id, m.agent_id)) }
  }
  /** Held or captured this calendar month (UTC) on jobs funded through the mandate; voids and refunds give it back. */
  spentThisMonth(mandate_id: string, agent_id: string): number {
    const now = this.d.clock()
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    let total = 0
    for (const r of this.d.db.all<{ data: string }>('SELECT data FROM jobs WHERE buyer_agent_id = ?', agent_id)) {
      const e = json<JobRecord>(r.data).escrow
      if (e.mandate_id !== mandate_id || !e.funded_at || Date.parse(e.funded_at) < monthStart) continue
      total += Math.max(0, e.authorized - e.voided - e.refunded)
    }
    return total
  }

  async requestMandate(agent_id: string, owner_id: string | null, p: { monthly_cap: string; per_job_cap: string; categories: CapabilityClass[]; expires_in_days: number }): Promise<Mandate> {
    const monthly = toCents(p.monthly_cap)
    const perJob = toCents(p.per_job_cap)
    if (perJob <= 0 || monthly <= 0) throw new OpError('invalid_input', 'Caps must be above zero.', 'Ask for the smallest caps that still cover the job.')
    if (perJob > monthly) throw new OpError('invalid_input', 'per_job_cap is above monthly_cap.', 'Set per_job_cap ≤ monthly_cap.')
    const id = newId('mdt')
    const setup = await this.d.rail.createVaultSetupToken({
      mandate_id: id,
      request_id: `${id}:vault-setup:1`,
      return_url: `${this.d.cfg.publicUrl}/api/paypal/vault/return?mandate_id=${id}`,
      cancel_url: `${this.d.cfg.publicUrl}/api/paypal/vault/return?mandate_id=${id}&cancel=1`,
      brand_name: 'Rent-A-Bot',
      description: `Rent-A-Bot spending mandate: up to $${toAmount(monthly)}/month, $${toAmount(perJob)}/job`,
    })
    this.ref(setup.setup_token_id, 'setup_token', null, id)
    const now = this.d.nowIso()
    const m: Omit<Mandate, 'spent_this_month'> = {
      id,
      agent_id,
      owner_id,
      status: 'pending_approval',
      monthly_cap: usd(monthly),
      per_job_cap: usd(perJob),
      categories: [...new Set(p.categories)],
      expires_at: new Date(this.d.nowMs() + p.expires_in_days * DAY).toISOString(),
      approval_url: setup.approval_url,
      rail: this.d.rail.kind,
      created_at: now,
    }
    this.saveMandate(m, setup.setup_token_id, null)
    this.d.bus.publish('mandate', null, { agents: [agent_id] }, 'Spending mandate waiting for approval', { mandate_id: id, status: m.status })
    return this.renderMandate(this.mandateRow(id)!)
  }

  /** The owner approved (or cancelled) the Vault setup: turn it into a payment token and activate. */
  async mandateApproved(mandate_id: string, approve: boolean): Promise<Mandate | null> {
    return this.d.withLock(`mandate:${mandate_id}`, async () => {
      const row = this.mandateRow(mandate_id)
      if (!row) return null
      const m = json<Omit<Mandate, 'spent_this_month'>>(row.data)
      if (m.status !== 'pending_approval') return this.renderMandate(row)
      if (!approve) {
        m.status = 'revoked'
        m.approval_url = null
        this.saveMandate(m, row.setup_token_id, null)
      } else {
        const tok = await this.d.rail.createPaymentToken({ setup_token_id: row.setup_token_id!, request_id: `${mandate_id}:vault-token:1` })
        this.ref(tok.payment_token_id, 'payment_token', null, mandate_id)
        // A new active mandate replaces the previous one.
        for (const old of this.d.db.all<MandateRow>("SELECT * FROM mandates WHERE agent_id = ? AND id != ?", m.agent_id, m.id)) {
          const om = json<Omit<Mandate, 'spent_this_month'>>(old.data)
          if (om.status === 'active' || om.status === 'pending_approval') this.saveMandate({ ...om, status: 'revoked', approval_url: null }, old.setup_token_id, old.payment_token_id)
        }
        m.status = 'active'
        m.approval_url = null
        this.saveMandate(m, row.setup_token_id, tok.payment_token_id)
      }
      this.d.bus.publish('mandate', null, { agents: [m.agent_id] }, `Spending mandate ${m.status}`, { mandate_id, status: m.status })
      return this.renderMandate(this.mandateRow(mandate_id)!)
    })
  }
  mandateBySetupToken(setup_token_id: string): string | null {
    return this.d.db.get<{ id: string }>('SELECT id FROM mandates WHERE setup_token_id = ?', setup_token_id)?.id ?? null
  }
  /** Seed/demo: an active mandate whose payment token already exists. */
  seedActiveMandate(m: Omit<Mandate, 'spent_this_month'>, payment_token_id: string) {
    this.saveMandate(m, null, payment_token_id)
  }

  /** Can the buyer's mandate pay for this job without a human? (A restricted job never gets here: see policyHold.) */
  private usableMandate(agent_id: string, amount: number, cls: CapabilityClass): { id: string; vault_id: string } | { reason: string } {
    const m = this.mandateFor(agent_id)
    if (!m) return { reason: 'no spending mandate' }
    if (m.status !== 'active') return { reason: `mandate is ${m.status}` }
    if (amount > toCents(m.per_job_cap.value)) return { reason: `$${toAmount(amount)} is above the per-job cap of $${m.per_job_cap.value}` }
    const spent = toCents(m.spent_this_month.value)
    if (spent + amount > toCents(m.monthly_cap.value)) return { reason: `$${toAmount(amount)} would exceed the monthly cap ($${m.spent_this_month.value} of $${m.monthly_cap.value} used)` }
    if (!m.categories.includes(cls)) return { reason: `the mandate does not cover ${cls} jobs` }
    const token = this.mandateRow(m.id)?.payment_token_id
    if (!token) return { reason: 'mandate has no payment token' }
    return { id: m.id, vault_id: token }
  }

  // ---------- funding ----------
  async verifyScopeProof(rec: JobRecord) {
    const url = rec.inputs.scope_proof_url
    // The token gate's scope URL carries the ownership token: errors name the scope file, not its URL.
    const where = this.needsOwnershipToken(rec) ? 'the platform scope file for your ownership token' : String(url)
    const hint = this.needsOwnershipToken(rec)
      ? `Bind this job to your ownership token: POST /sandbox/redteam/scope {ownership_token, job_id: "${rec.id}"}, then call fund_job again.`
      : `Publish a text file containing the job id (${rec.id}) at https://<your-domain>/.well-known/rentabot-scope.txt, send its URL as inputs.scope_proof_url with provide_inputs, and accept the contract again.`
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new OpError('invalid_state', 'Security jobs need scope proof before funding: inputs.scope_proof_url is missing.', hint)
    let text = ''
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = (await res.text()).slice(0, 100_000)
    } catch (e) {
      throw new OpError('invalid_state', `Could not read the scope proof (${where}): ${e instanceof Error ? e.message : String(e)}.`, hint)
    }
    if (!text.includes(rec.id)) throw new OpError('invalid_state', `The scope proof at ${where} does not contain the job id.`, hint)
    this.verifyOwnershipToken(rec, url)
    this.d.system(rec, `Scope proof verified at ${where}.`, this.needsOwnershipToken(rec) ? {} : { scope_proof_url: url })
  }

  /**
   * A seller that declares `ownership_token` a required input (the Agent Red Team, whose only target is the Sandbox practice agent
   * Rent-A-Bot hosts) gets a stricter gate: the token must be in the job, the scope proof must be the platform's own scope file for
   * exactly that token, and the target must be on the platform's own origin. So nothing external can ever be put in scope.
   */
  private needsOwnershipToken(rec: JobRecord): boolean {
    const required = (rec.requirements?.inputs_schema as { required?: unknown } | undefined)?.required
    return Array.isArray(required) && required.includes('ownership_token')
  }

  private verifyOwnershipToken(rec: JobRecord, url: string) {
    if (!this.needsOwnershipToken(rec)) return
    const hint = 'Claim an ownership token at POST /sandbox/redteam/claim, bind this job with POST /sandbox/redteam/scope, send ownership_token and the returned scope_proof_url with provide_inputs, and accept the contract again.'
    const tok = typeof rec.inputs.ownership_token === 'string' ? rec.inputs.ownership_token.trim() : ''
    if (!tok) throw new OpError('invalid_state', 'This security job needs an ownership token before funding: inputs.ownership_token is missing.', hint)
    const origin = new URL(this.d.cfg.publicUrl).origin
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new OpError('invalid_state', 'The scope proof URL is not a valid URL.', hint)
    }
    if (u.origin !== origin || u.pathname !== `/sandbox/redteam/scope/${encodeURIComponent(tok)}.txt`) throw new OpError('invalid_state', 'The scope proof is not the platform’s scope file for this ownership token.', hint)
    const target = typeof rec.inputs.target_endpoint === 'string' ? rec.inputs.target_endpoint.trim() : ''
    let t: URL | null = null
    try {
      t = target ? new URL(target) : null
    } catch {
      t = null
    }
    if (!t || t.origin !== origin || !t.pathname.startsWith('/sandbox/redteam/')) throw new OpError('invalid_state', 'Only the Sandbox practice agent Rent-A-Bot hosts can be tested: inputs.target_endpoint must be on this platform.', hint)
  }

  async fund(rec: JobRecord): Promise<{ approval_url: string | null }> {
    const d = this.d
    if (rec.state === 'AWAITING_APPROVAL') return { approval_url: rec.escrow.approval_url }
    const buyer = d.agent(rec.buyer_agent_id)
    if (!buyer?.claimed)
      throw new OpError('mandate_required', 'This agent has not been claimed by a human, so it cannot spend money yet.', 'Ask your owner to open the claim_url from register_agent, then call fund_job again.')
    if (rec.requires_scope_proof) await this.verifyScopeProof(rec)
    const contract = d.buildContract(rec)!
    const amount = toCents(contract.quote.total_max.value)
    if (amount <= 0) throw new OpError('invalid_state', 'The contract total is zero.', 'Ask the seller for a quote above zero.')
    // A job the policy gate marked restricted is never paid by a mandate: the buyer's human owner approves it on PayPal.
    const hold = policyHold(rec)
    const mandate = hold ? { reason: hold } : this.usableMandate(rec.buyer_agent_id, amount, rec.capability_class)
    const viaMandate = 'vault_id' in mandate
    const e = rec.escrow
    const order = await this.call(rec, 'fund', (request_id) =>
      d.rail.createOrder({
        job_id: rec.id,
        request_id,
        amount_cents: amount,
        currency: 'USD',
        contract_hash: rec.agreed_hash ?? rec.contract_hash!,
        description: `Rent-A-Bot escrow: ${rec.title}`.slice(0, 127),
        vault_id: viaMandate ? mandate.vault_id : null,
        return_url: `${d.cfg.publicUrl}/api/paypal/return?job_id=${rec.id}`,
        cancel_url: `${d.cfg.publicUrl}/api/paypal/return?job_id=${rec.id}&cancel=1`,
        brand_name: 'Rent-A-Bot',
      }),
    )
    e.order_id = order.order_id
    e.mandate_id = viaMandate ? mandate.id : null
    this.ref(order.order_id, 'order', rec.id)
    this.event(rec, 'order_created', amount, order.order_id, viaMandate ? `Order (intent AUTHORIZE) paid with the spending mandate ${mandate.id}.` : `Order (intent AUTHORIZE) needs a human approval: ${mandate.reason}.`)
    d.save(rec)
    if (order.authorization) await this.onAuthorized(rec, order.authorization)
    else if (viaMandate && order.status === 'APPROVED') {
      const o2 = await this.call(rec, 'authorize', (request_id) => d.rail.authorizeOrder({ order_id: order.order_id, request_id }))
      if (o2.authorization) await this.onAuthorized(rec, o2.authorization)
    } else {
      e.status = 'pending_approval'
      e.approval_url = order.approval_url
      this.event(rec, 'approval_required', amount, order.order_id, viaMandate ? 'PayPal asked the buyer to approve.' : `Approval needed: ${mandate.reason}.`)
      d.setState(rec, 'AWAITING_APPROVAL', hold ?? 'a human must approve the payment on PayPal', { approval_url: order.approval_url })
    }
    d.save(rec)
    return { approval_url: (rec.state as string) === 'AWAITING_APPROVAL' ? e.approval_url : null }
  }

  /** Buyer approved on PayPal (return URL, simulated page or CHECKOUT.ORDER.APPROVED webhook). Idempotent. */
  async approvalReturned(rec: JobRecord): Promise<void> {
    const e = rec.escrow
    if (rec.state !== 'AWAITING_APPROVAL' || !e.order_id || e.authorization_id) return
    const order = await this.d.rail.getOrder(e.order_id)
    if (order.authorization) return this.onAuthorized(rec, order.authorization)
    if (order.status !== 'APPROVED') return
    const o2 = await this.call(rec, 'authorize', (request_id) => this.d.rail.authorizeOrder({ order_id: e.order_id!, request_id }))
    if (o2.authorization) await this.onAuthorized(rec, o2.authorization)
    this.d.save(rec)
  }

  /** Buyer cancelled on PayPal: back to AGREED so they can fund again (nothing was held). */
  approvalCancelled(rec: JobRecord) {
    if (rec.state !== 'AWAITING_APPROVAL') return
    rec.escrow.status = 'none'
    rec.escrow.approval_url = null
    rec.escrow.order_id = null
    this.d.setState(rec, 'AGREED', 'the buyer cancelled the PayPal approval; nothing was charged')
    this.d.save(rec)
  }

  private async onAuthorized(rec: JobRecord, auth: AuthorizationInfo) {
    const d = this.d
    const e = rec.escrow
    if (e.authorization_id === auth.authorization_id && e.status !== 'pending_approval' && e.status !== 'none') return
    if (auth.status === 'PENDING') {
      // Under PayPal review: record the id and wait for PAYMENT.AUTHORIZATION.CREATED.
      e.authorization_id = auth.authorization_id
      this.ref(auth.authorization_id, 'authorization', rec.id)
      e.status = 'pending_approval'
      if (rec.state === 'AGREED') d.setState(rec, 'AWAITING_APPROVAL', 'PayPal is reviewing the authorization')
      d.save(rec)
      return
    }
    if (auth.status !== 'CREATED') {
      this.event(rec, 'authorized', null, auth.authorization_id, `Authorization ${auth.status}; nothing is held.`)
      d.save(rec)
      throw new PaymentError(`PayPal authorization ${auth.status}.`, 'The payment method was declined: fund_job again to get a new approval link, or ask the owner to update the mandate.', { definitive: true })
    }
    const expected = toCents(d.buildContract(rec)!.quote.total_max.value)
    this.ref(auth.authorization_id, 'authorization', rec.id)
    if (auth.amount_cents !== expected) {
      // Never run a job on a different amount than the contract: give it back.
      await this.call(rec, 'void', (request_id) => d.rail.voidAuthorization({ authorization_id: auth.authorization_id, request_id }))
      this.event(rec, 'voided', auth.amount_cents, auth.authorization_id, `Authorized $${toAmount(auth.amount_cents)} ≠ contract $${toAmount(expected)}; voided.`)
      d.save(rec)
      throw new PaymentError('Authorized amount does not match the contract.', 'Fund the job again.', { definitive: true })
    }
    const now = d.nowMs()
    e.authorization_id = auth.authorization_id
    e.authorized = auth.amount_cents
    e.status = 'authorized'
    e.approval_url = null
    e.funded_at = d.nowIso()
    e.honor_expires_at = new Date(now + d.railMs(HONOR_MS)).toISOString()
    e.authorization_expires_at = auth.expires_at ?? new Date(now + d.railMs(VALIDITY_MS)).toISOString()
    this.event(rec, 'authorized', auth.amount_cents, auth.authorization_id, e.mandate_id ? 'Held on the buyer’s PayPal account (mandate).' : 'Held on the buyer’s PayPal account.')
    // Deadline: the spec's absolute deadline (in demo mode, its distance from now is time-scaled).
    const deadline = Date.parse(rec.spec.deadline)
    const deliverBy = d.cfg.demoMode && d.cfg.demoTimeScale > 1 ? now + Math.max(0, deadline - now) / d.cfg.demoTimeScale : deadline
    rec.deadlines.deliver_by = new Date(Math.max(deliverBy, now)).toISOString()
    rec.deadlines.fund_by = null
    // Jobs that can outlive the authorization are captured now and settled by refund (capture-and-hold).
    const needed = Math.max(Date.parse(rec.deadlines.deliver_by), now) + d.dur(rec.timers.review_window) + d.dur(rec.timers.verify_window) + d.dur(rec.timers.cure_window)
    d.setState(rec, 'IN_PROGRESS', `escrow authorized: $${toAmount(e.authorized)} held${e.mandate_id ? ' under the spending mandate' : ''}`)
    if (needed > Date.parse(e.authorization_expires_at)) {
      e.mode = 'capture_and_hold'
      d.system(rec, captureAndHoldNotice(d.feePolicy(rec)), { escrow_mode: 'capture_and_hold' })
      await this.capture(rec, e.authorized, true, 0)
    }
    d.save(rec)
  }

  // ---------- captures, voids, refunds, payouts ----------
  private async capture(rec: JobRecord, cents: number, final: boolean, feePart: number) {
    const e = rec.escrow
    const cap = await this.call(rec, 'capture', (request_id) =>
      this.d.rail.captureAuthorization({ authorization_id: e.authorization_id!, request_id, amount_cents: cents, final_capture: final, note: `Rent-A-Bot ${rec.id}` }),
    )
    if (cap.status !== 'COMPLETED' && cap.status !== 'PENDING') {
      this.event(rec, 'captured', null, cap.capture_id, `Capture ${cap.status}; nothing was taken.`)
      this.d.save(rec)
      throw new PaymentError(`PayPal capture ${cap.status}.`, 'The capture was declined; the escrow is unchanged. An operator should review the authorization.', { definitive: true })
    }
    e.capture_ids.push(cap.capture_id)
    e.capture_fee_parts[cap.capture_id] = feePart
    this.ref(cap.capture_id, 'capture', rec.id)
    if (cap.status === 'COMPLETED') this.captureCompleted(rec, cap.capture_id, cap.amount_cents)
    else e.pending_captures.push({ capture_id: cap.capture_id, cents: cap.amount_cents, fee_part: feePart, at: this.d.nowIso() })
    this.recordFee(rec, 'capture', cap.capture_id, cap.paypal_fee_cents ?? null)
    this.event(rec, 'captured', cap.amount_cents, cap.capture_id, `${final ? 'Final' : 'Partial'} capture${cap.status === 'PENDING' ? ' (PENDING at PayPal; committed on the webhook)' : ''}${cap.paypal_fee_cents != null ? `; PayPal fee $${toAmount(cap.paypal_fee_cents)}` : ''}.`)
    if (final && e.mode === 'hold') {
      const rest = e.authorized - e.captured - pendingCents(e) - e.voided
      if (rest > 0) {
        e.voided += rest
        this.event(rec, 'voided', rest, e.authorization_id, 'Remainder released back to the buyer by final_capture.')
      }
      e.finalized = true
    }
    this.refreshStatus(rec)
    this.d.save(rec)
  }
  /** Record an actual PayPal fee once per capture / payout item (from the API response or the webhook). */
  private recordFee(rec: JobRecord, kind: 'capture' | 'payout', id: string | null, cents: number | null) {
    if (!id || cents === null || cents === undefined) return
    const f = rec.escrow.paypal_fees
    if (f.by_id[id] !== undefined) return
    f.by_id[id] = cents
    f[kind] += cents
  }
  private captureCompleted(rec: JobRecord, capture_id: string, cents: number) {
    const e = rec.escrow
    e.pending_captures = e.pending_captures.filter((p) => p.capture_id !== capture_id)
    e.captured += cents
    e.platform_extra += e.capture_fee_parts[capture_id] ?? 0
    this.refreshStatus(rec)
  }

  /**
   * Release money to the seller. `targetGross` is the seller's CUMULATIVE gross share of the escrow.
   * final=true settles: hold → final capture (or void if nothing more is due); capture_and_hold → refund the rest.
   * fees.buyer is a mediation fee captured from the buyer for the platform; fees.seller is withheld from the payout.
   */
  async release(rec: JobRecord, targetGross: number, final: boolean, reason: string, fees: { buyer: number; seller: number } = { buyer: 0, seller: 0 }) {
    const e = rec.escrow
    if (e.status === 'none' || e.status === 'pending_approval') throw new OpError('invalid_state', 'Nothing is held in escrow for this job.', 'Fund the job first.')
    if (e.finalized) {
      await this.payout(rec)
      return
    }
    if (!Number.isInteger(targetGross) || !Number.isInteger(fees.buyer) || !Number.isInteger(fees.seller)) throw new Error('release amounts must be integer cents')
    // Can't take back what was already released; can't release more than is held.
    let target = Math.min(Math.max(targetGross, e.seller_release), e.authorized)
    let buyerFee = final ? Math.max(0, Math.min(fees.buyer, e.authorized - target)) : 0
    const target0 = target
    const min = this.d.feePolicy(rec).min_settlement_cents
    // R4: posted once the money moved, so a retried PayPal call never repeats it.
    let belowMin: [string, Record<string, unknown>] | null = null
    if (e.mode === 'hold') {
      const already = e.captured + pendingCents(e)
      // Fee parts are only captured with the final capture, so `already` is all seller money here.
      let toCapture = Math.max(0, target + buyerFee - already)
      if (toCapture > 0 && toCapture < min) {
        // No capture below the minimum settlement: PayPal's fixed fees would eat it. An interim release just waits;
        // a final one voids the remainder (the seller keeps what was already captured, a buyer-side fee is not collected).
        if (!final) return
        const short = target - already
        belowMin = [
          short > 0
            ? already > 0
              ? `The remaining verified $${toAmount(short)} is below the $${toAmount(min)} minimum settlement; it was voided with the rest of the hold and not charged. The $${toAmount(already)} already captured stands.`
              : `Verified $${toAmount(short)} is below the $${toAmount(min)} minimum settlement; the hold was voided and nothing was charged.`
            : `The $${toAmount(buyerFee)} mediation fee is below the $${toAmount(min)} minimum settlement, so it is not collected.`,
          { below_minimum: toAmount(toCapture), min_settlement: toAmount(min) },
        ]
        target = already
        buyerFee = 0
        toCapture = 0
      }
      const room = e.authorized - already - e.voided
      if (toCapture > room) throw new OpError('internal', `Release of $${toAmount(toCapture)} exceeds what is held ($${toAmount(room)}).`, 'Platform bug: nothing was moved.')
      e.seller_release = target
      if (final) e.seller_fee_target = Math.max(0, fees.seller)
      this.d.save(rec)
      if (toCapture > 0) await this.capture(rec, toCapture, final, buyerFee)
      else if (final) {
        const rest = e.authorized - already - e.voided
        if (rest > 0) {
          await this.call(rec, 'void', (request_id) => this.d.rail.voidAuthorization({ authorization_id: e.authorization_id!, request_id }))
          e.voided += rest
          this.event(rec, 'voided', rest, e.authorization_id, already ? 'Uncaptured remainder voided back to the buyer.' : target0 > 0 ? `Verified $${toAmount(target0)} is below the $${toAmount(min)} minimum settlement; authorization voided, nothing was charged.` : 'Authorization voided; nothing was charged.')
        }
        e.finalized = true
      }
    } else {
      // Capture-and-hold: the money is captured already, but a seller tranche below the minimum settlement is still not paid
      // (its commission could not carry the payout fee); it goes back with the refund.
      if (target - e.seller_release > 0 && target - e.seller_release < min) {
        if (!final) return
        belowMin = [`Verified $${toAmount(target - e.seller_release)} is below the $${toAmount(min)} minimum settlement; it is refunded to the buyer instead of paid out.`, { below_minimum: toAmount(target - e.seller_release), min_settlement: toAmount(min) }]
        target = e.seller_release
        buyerFee = Math.max(0, Math.min(fees.buyer, e.authorized - target))
      }
      if (target > e.seller_release) e.tranches = (e.tranches ?? 0) + 1
      e.seller_release = target
      if (final) {
        e.seller_fee_target = Math.max(0, fees.seller)
        await this.settleRefund(rec, e.captured - target - buyerFee, target)
        e.platform_extra = buyerFee
        e.finalized = true
      }
    }
    this.refreshStatus(rec)
    if (belowMin) this.d.system(rec, belowMin[0], belowMin[1])
    this.d.system(rec, `Escrow release: ${reason}. Seller share so far $${toAmount(e.seller_release)}${final ? ' (final)' : ''}.`, { seller_release: toAmount(e.seller_release), final })
    this.d.save(rec)
    await this.payout(rec)
  }

  /**
   * Agreed refund while the rest stays held (mediation: redo / wait). On an authorization hold the refund part is voided with the
   * final capture; it cannot be released earlier. In capture-and-hold mode the money is already captured, so it goes back now.
   */
  async refundNow(rec: JobRecord, cents: number, note: string) {
    const e = rec.escrow
    if (e.mode !== 'capture_and_hold' || e.finalized) return
    // PayPal keeps its percentage on refunded money (the seller's agreed share pays commission, so only the percentage).
    const kept = refundKeptFee(cents, 1, this.d.feePolicy(rec))
    const owed = cents - e.refunded - (e.refund_fee ?? 0)
    const keep = Math.max(0, Math.min(owed, kept - (e.refund_fee ?? 0)))
    if (keep > 0) this.keepRefundFee(rec, keep)
    if (owed - keep > 0) await this.refund(rec, owed - keep, note)
  }

  /**
   * Capture-and-hold final refund of the unearned part `unearned` (captured − seller gross − buyer mediation fee). PayPal does
   * not return its fee on refunded money, so that fee is kept from the refund (fees.ts refundKeptFee) and recorded as its own
   * ledger line: captured − refunded = paid out + commission + mediation fees + kept processing fee.
   */
  private async settleRefund(rec: JobRecord, unearned: number, sellerGross: number) {
    const e = rec.escrow
    if (unearned <= 0) return
    const kept = refundKeptFee(unearned, sellerGross, this.d.feePolicy(rec))
    const back = unearned - e.refunded - (e.refund_fee ?? 0)
    const keep = Math.max(0, Math.min(back, kept - (e.refund_fee ?? 0)))
    if (keep > 0) this.keepRefundFee(rec, keep)
    if (back - keep > 0) await this.refund(rec, back - keep, `Unearned part of the escrow returned to the buyer, minus $${toAmount(e.refund_fee ?? 0)} PayPal processing fee PayPal does not return on refunds.`)
  }
  private keepRefundFee(rec: JobRecord, cents: number) {
    rec.escrow.refund_fee = (rec.escrow.refund_fee ?? 0) + cents
    this.event(rec, 'refunded', null, null, `$${toAmount(cents)} kept from the refund: PayPal does not return its processing fee on refunded money (capture-and-hold).`)
    this.d.save(rec)
  }

  /** Give everything still held back to the buyer (cancel, refund_full). */
  async returnAll(rec: JobRecord, reason: string) {
    const e = rec.escrow
    if (e.status === 'none' || e.status === 'pending_approval') {
      if (e.order_id) this.event(rec, 'voided', null, e.order_id, `Order abandoned before approval (${reason}); nothing was held.`)
      e.status = 'none'
      e.approval_url = null
      this.d.save(rec)
      return
    }
    await this.release(rec, e.seller_release, true, reason)
  }

  private async refund(rec: JobRecord, cents: number, note: string) {
    const e = rec.escrow
    const capture_id = e.capture_ids[0]
    const r = await this.call(rec, 'refund', (request_id) => this.d.rail.refundCapture({ capture_id, request_id, amount_cents: cents, note }))
    e.refunded += r.amount_cents
    e.refund_ids.push(r.refund_id)
    this.ref(r.refund_id, 'refund', rec.id)
    this.event(rec, 'refunded', r.amount_cents, r.refund_id, note)
    this.d.save(rec)
  }

  /** Seller's gross that PayPal has actually captured (payouts never run ahead of completed captures). */
  confirmedSellerGross(rec: JobRecord): number {
    const e = rec.escrow
    if (e.mode === 'hold') return Math.max(0, Math.min(e.seller_release, e.captured - e.platform_extra))
    return e.captured >= e.authorized ? e.seller_release : 0
  }

  /** Pay the seller whatever is due and not yet sent. Safe to call any time. */
  async payout(rec: JobRecord) {
    const d = this.d
    const e = rec.escrow
    const gross = this.confirmedSellerGross(rec)
    const { commission: fee, seller_fee: sellerFee, net } = sellerNet(gross, e.finalized ? e.seller_fee_target : 0, d.feePolicy(rec), settlementCount(e))
    const changed = fee !== e.platform_fee || sellerFee !== e.seller_fee
    e.platform_fee = fee
    e.seller_fee = sellerFee
    const due = net - e.payout_requested
    if (due <= 0) {
      if (changed) d.save(rec)
      return
    }
    const seller = d.agent(rec.seller_agent_id)
    if (!seller?.payout_email) {
      if (!e.events.some((x) => x.kind === 'payout_failed' && x.note.startsWith('No payout email')))
        this.event(rec, 'payout_failed', due, null, 'No payout email on the seller agent; the payout waits until one is set.')
      return d.save(rec)
    }
    const n = d.requestId(rec, 'payout').split(':').pop()
    const sender_item_id = `${rec.id}-p${n}`
    try {
      const res = await this.call(rec, 'payout', (request_id) =>
        d.rail.payout({ request_id, sender_item_id, receiver_email: seller.payout_email!, amount_cents: due, note: `Rent-A-Bot: ${rec.title}`.slice(0, 200) }),
      )
      e.payout_requested += due
      e.payouts.push({ sender_item_id, batch_id: res.batch_id, item_id: res.item_id, cents: due, status: 'sent', at: d.nowIso() })
      this.ref(sender_item_id, 'payout_item', rec.id)
      this.ref(res.batch_id, 'payout_batch', rec.id)
      this.event(rec, 'payout_sent', due, res.batch_id, `Payout to the seller: $${toAmount(gross)} gross − $${toAmount(e.platform_fee)} commission${sellerFee ? ` − $${toAmount(sellerFee)} mediation fee` : ''}.`)
    } catch (err) {
      // Money is already captured; a failed payout must not undo the release. The tick retries.
      const note = `Payout call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)
      // The scheduler retries a failed payout; the same failure must not pile up one ledger event per attempt.
      const same = (a: string, b: string) => a.replace(/, debug_id \w+/, '') === b.replace(/, debug_id \w+/, '')
      const last = rec.escrow.events[rec.escrow.events.length - 1]
      if (last?.kind === 'payout_failed' && last.paypal_id === null && same(last.note, note)) {
        last.note = note
        last.ts = d.nowIso()
      } else this.event(rec, 'payout_failed', due, null, note)
    }
    d.save(rec)
  }

  /** Inside the 29-day validity, renew an untouched authorization once the 3-day honor period ends. */
  async reauthorizeIfDue(rec: JobRecord) {
    const e = rec.escrow
    if (e.mode !== 'hold' || e.status !== 'authorized' || e.reauthorized || e.finalized || !e.honor_expires_at || !e.authorization_expires_at) return
    const now = this.d.nowMs()
    if (now < Date.parse(e.honor_expires_at) || now >= Date.parse(e.authorization_expires_at)) return
    try {
      const a = await this.call(rec, 'reauthorize', (request_id) => this.d.rail.reauthorize({ authorization_id: e.authorization_id!, request_id, amount_cents: e.authorized - e.captured }))
      e.authorization_id = a.authorization_id
      e.reauthorized = true
      e.honor_expires_at = new Date(now + this.d.railMs(HONOR_MS)).toISOString()
      if (a.expires_at) e.authorization_expires_at = a.expires_at
      this.ref(a.authorization_id, 'authorization', rec.id)
      this.event(rec, 'reauthorized', a.amount_cents, a.authorization_id, 'Honor period ended while the job is open: reauthorized.')
    } catch (err) {
      e.reauthorized = true // don't hammer PayPal; the authorization itself stays valid until expiry
      this.event(rec, 'reauthorized', null, e.authorization_id, `Reauthorization failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500))
    }
    this.d.save(rec)
  }

  // ---------- reconciler (webhook fallback) ----------
  /**
   * A capture or payout whose webhook has not arrived after RECONCILE_AFTER_SECONDS (scaled in demo mode) is looked up on PayPal
   * (GET capture, GET payout batch). The result is applied exactly like the webhook would have been; when the webhook shows up later
   * it finds the state already applied (fees and payouts are deduplicated by id, the escrow event only gains its webhook marker).
   * Returns true when something changed.
   */
  async reconcile(rec: JobRecord): Promise<boolean> {
    const d = this.d
    const e = rec.escrow
    const after = scaleMs(d.cfg, d.cfg.reconcileAfterSeconds * 1000)
    const due = (at?: string) => !at || d.nowMs() - Date.parse(at) >= after // records without a stamp are due
    const secs = Math.round(after / 1000)
    let changed = false
    for (const p of [...e.pending_captures]) {
      if (!due(p.at)) continue
      let c
      try {
        c = await d.rail.getCapture(p.capture_id)
      } catch (err) {
        console.error(`[reconciler] ${rec.id}: GET capture ${p.capture_id} failed:`, err instanceof Error ? err.message : err)
        continue
      }
      if (['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(c.status)) {
        this.captureCompleted(rec, p.capture_id, p.cents)
        this.recordFee(rec, 'capture', p.capture_id, c.paypal_fee_cents ?? null)
        const note = `Capture confirmed by the reconciler (GET capture): no webhook within ${secs}s.`
        const ev = [...e.events].reverse().find((x) => x.kind === 'captured' && x.paypal_id === p.capture_id && !x.webhook_event)
        if (ev) {
          ev.webhook_event = RECONCILER
          ev.note = `${ev.note} ${note}`.slice(0, 500)
        } else this.event(rec, 'captured', p.cents, p.capture_id, note, RECONCILER)
        changed = true
      } else if (['DECLINED', 'FAILED', 'DENIED'].includes(c.status)) {
        e.pending_captures = e.pending_captures.filter((x) => x !== p)
        this.event(rec, 'captured', null, p.capture_id, `Capture of $${toAmount(p.cents)} is ${c.status} at PayPal (found by the reconciler); an operator must review this job.`, RECONCILER)
        d.system(rec, `PayPal ${c.status} a capture of $${toAmount(p.cents)}. The seller will not be paid for it until an operator resolves it.`)
        changed = true
      }
    }
    for (const item of e.payouts) {
      if (item.status !== 'sent' || !item.batch_id || !due(item.at)) continue
      let r
      try {
        r = await d.rail.getPayoutItem({ batch_id: item.batch_id, sender_item_id: item.sender_item_id })
      } catch (err) {
        console.error(`[reconciler] ${rec.id}: GET payout ${item.batch_id} failed:`, err instanceof Error ? err.message : err)
        continue
      }
      item.item_id = r.item_id ?? item.item_id
      if (r.status === 'SUCCESS') {
        item.status = 'succeeded'
        e.paid_out += item.cents
        this.recordFee(rec, 'payout', item.item_id ?? item.sender_item_id, r.fee_cents)
        this.event(rec, 'payout_succeeded', item.cents, item.item_id, `Seller payout delivered (confirmed by the reconciler, GET payout batch: no webhook within ${secs}s).`, RECONCILER)
        this.confirmPayoutSent(rec, item, RECONCILER)
        changed = true
      } else if (/FAILED|BLOCKED|RETURNED|DENIED|REFUNDED|REVERSED/.test(r.status)) {
        item.status = 'failed'
        e.payout_requested -= item.cents
        this.event(rec, 'payout_failed', item.cents, item.item_id, `Payout ${r.status} (found by the reconciler); the amount is owed to the seller again.`, RECONCILER)
        changed = true
      }
    }
    if (changed) {
      this.refreshStatus(rec)
      d.save(rec)
      await this.payout(rec) // a capture that just completed may unlock the seller's payout; a failed one is retried
    }
    return changed
  }

  // ---------- webhooks ----------
  /** Which job or mandate a webhook belongs to. */
  locate(evt: RailEvent): { job_id: string | null; mandate_id: string | null } {
    for (const id of [evt.order_id, evt.authorization_id, evt.capture_id, evt.refund_id, evt.sender_item_id, evt.payout_batch_id, evt.setup_token_id, evt.payment_token_id]) {
      if (!id) continue
      const r = this.d.db.get<{ job_id: string | null; mandate_id: string | null }>('SELECT job_id, mandate_id FROM paypal_refs WHERE paypal_id = ?', id)
      if (r) return r
    }
    return { job_id: null, mandate_id: null }
  }

  async applyWebhook(rec: JobRecord, evt: RailEvent): Promise<string> {
    const e = rec.escrow
    const t = evt.event_type
    if (t === 'CHECKOUT.ORDER.APPROVED') {
      if (rec.state === 'AWAITING_APPROVAL' && evt.order_id === e.order_id) await this.approvalReturned(rec)
      return 'order approved'
    }
    if (t === 'PAYMENT.AUTHORIZATION.CREATED') {
      if (evt.authorization_id === e.authorization_id && e.status !== 'pending_approval') {
        this.confirm(rec, e.reauthorized ? 'reauthorized' : 'authorized', evt.authorization_id, t, evt.amount_cents, 'Authorization confirmed by webhook.')
      } else if (rec.state === 'AWAITING_APPROVAL' && (evt.order_id === e.order_id || evt.authorization_id === e.authorization_id)) {
        await this.onAuthorized(rec, { authorization_id: evt.authorization_id!, status: evt.status ?? 'CREATED', amount_cents: evt.amount_cents ?? 0, expires_at: null })
        this.confirm(rec, 'authorized', evt.authorization_id, t, evt.amount_cents, '')
      }
      return 'authorization'
    }
    if (t === 'PAYMENT.AUTHORIZATION.VOIDED') {
      this.confirm(rec, 'voided', evt.authorization_id, t, null, 'Void confirmed by webhook.')
      return 'void'
    }
    if (t === 'PAYMENT.CAPTURE.COMPLETED') {
      const pending = e.pending_captures.find((p) => p.capture_id === evt.capture_id)
      if (pending) this.captureCompleted(rec, pending.capture_id, pending.cents)
      this.recordFee(rec, 'capture', evt.capture_id, evt.fee_cents)
      this.confirm(rec, 'captured', evt.capture_id, t, evt.amount_cents, 'Capture confirmed by webhook.')
      this.d.save(rec)
      if (pending) await this.payout(rec)
      return 'capture completed'
    }
    if (t === 'PAYMENT.CAPTURE.DENIED' || t === 'PAYMENT.CAPTURE.DECLINED') {
      const pending = e.pending_captures.find((p) => p.capture_id === evt.capture_id)
      if (pending) {
        e.pending_captures = e.pending_captures.filter((p) => p !== pending)
        this.event(rec, 'captured', null, evt.capture_id, `Capture of $${toAmount(pending.cents)} was ${t.split('.').pop()}; an operator must review this job.`, t)
        this.d.system(rec, `PayPal ${t.split('.').pop()} a capture of $${toAmount(pending.cents)}. The seller will not be paid for it until an operator resolves it.`)
      }
      return 'capture denied'
    }
    if (t === 'PAYMENT.CAPTURE.REFUNDED') {
      this.confirm(rec, 'refunded', evt.refund_id, t, evt.amount_cents, 'Refund confirmed by webhook.')
      return 'refund'
    }
    if (t.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const item = e.payouts.find((p) => p.sender_item_id === evt.sender_item_id || (evt.payout_item_id && p.item_id === evt.payout_item_id))
      if (!item) return 'unknown payout item'
      item.item_id = evt.payout_item_id ?? item.item_id
      if (t === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' && item.status !== 'succeeded') {
        item.status = 'succeeded'
        e.paid_out += item.cents
        this.recordFee(rec, 'payout', item.item_id ?? item.sender_item_id, evt.fee_cents)
        this.event(rec, 'payout_succeeded', item.cents, item.item_id, 'Seller payout delivered.', t)
        this.confirmPayoutSent(rec, item, t)
      } else if (/FAILED|BLOCKED|RETURNED|DENIED|CANCELED|REFUNDED/.test(t) && item.status !== 'failed') {
        if (item.status === 'succeeded') e.paid_out -= item.cents
        item.status = 'failed'
        e.payout_requested -= item.cents
        this.event(rec, 'payout_failed', item.cents, item.item_id, `Payout ${t.split('.').pop()}; the amount is owed to the seller again.`, t)
      }
      return 'payout'
    }
    if (t === 'CUSTOMER.DISPUTE.CREATED') {
      this.event(rec, 'dispute_opened', evt.amount_cents, evt.dispute_id, 'The buyer opened a PayPal dispute; the job record is the evidence.', t)
      this.d.system(rec, 'A PayPal dispute was opened on this payment. The room log, contract and check evidence will be submitted to PayPal.')
      return 'dispute'
    }
    if (t === 'CUSTOMER.DISPUTE.RESOLVED') {
      this.event(rec, 'dispute_resolved', evt.amount_cents, evt.dispute_id, 'PayPal dispute resolved.', t)
      return 'dispute resolved'
    }
    return 'ignored'
  }
}

/**
 * Why a job must be approved by the buyer's human owner on PayPal even when a spending mandate would cover it, or null.
 * A job the policy gate marked `restricted` is never funded by a mandate. Security jobs are the exception: they are always
 * restricted and their extra requirement is the scope proof, which fund() verifies before any money is held.
 */
export function policyHold(rec: Pick<JobRecord, 'policy' | 'capability_class'>): string | null {
  if (rec.policy?.class !== 'restricted' || rec.capability_class === 'security') return null
  const why = rec.policy.reasons.filter(Boolean).join('; ') || 'no reason given'
  return `the policy review marked this job restricted: ${why}; your owner approves it on PayPal`.slice(0, 600)
}
