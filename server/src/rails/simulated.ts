// Simulated payment rail: no network, PayPal-like ids and rules, state persisted in SQLite.
// It enforces the rules real PayPal would (capture ≤ remaining authorization, nothing after a
// final capture or void, request-id idempotency), so bugs in the escrow service fail here too.
// Webhooks are PayPal-shaped JSON bodies delivered to the core a moment later through the same
// parser as real webhooks (no signature). Its kind is always "simulated"; it never claims to be PayPal.
import { randomBytes } from 'node:crypto'
import { DEFAULT_FEES, estimatedCaptureFee, type FeePolicy } from '../core/fees.ts'
import { json, type Db } from '../db/index.ts'
import {
  PaymentError,
  toValue,
  type AuthorizationInfo,
  type CaptureInfo,
  type CreateOrderParams,
  type OrderInfo,
  type PaymentRail,
  type PaymentTokenInfo,
  type PayoutInfo,
  type PayoutItemInfo,
  type RefundInfo,
  type VaultSetupInfo,
} from './types.ts'

const ID_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'
const ppId = (len = 17) => [...randomBytes(len)].map((b) => ID_CHARS[b % ID_CHARS.length]).join('')

interface SimOrder {
  id: string
  status: string
  amount_cents: number
  custom_id: string
  job_id: string
  vault_id: string | null
  authorization_id: string | null
}
interface SimAuth {
  id: string
  order_id: string
  status: string
  amount_cents: number
  captured_cents: number
  custom_id: string
  expires_at: string
  reauthorized: boolean
}
interface SimCapture {
  id: string
  authorization_id: string
  order_id: string
  amount_cents: number
  refunded_cents: number
  status: string
  custom_id: string
}
interface SimSetup {
  id: string
  status: string
  mandate_id: string
}

export interface SimulatedRailOptions {
  db: Db
  publicUrl: string
  now?: () => Date
  /** Delay before a simulated webhook is delivered (ms). */
  webhookDelayMs?: number
  /** Status a capture reports synchronously; 'PENDING' exercises the webhook-commit path. */
  captureStatus?: 'COMPLETED' | 'PENDING'
  /** Authorization validity: PayPal is 29 days; demo mode may scale it. */
  authorizationValidityMs?: number
  /** PayPal fee formula for realistic fees on captures and payouts. */
  fees?: FeePolicy
  /** Start with webhooks swallowed (the reconciler is then the only way money movements get confirmed). */
  dropWebhooks?: boolean
}

export class SimulatedRail implements PaymentRail {
  readonly kind = 'simulated' as const
  private db: Db
  private publicUrl: string
  private now: () => Date
  private delay: number
  private sink: ((raw: string) => Promise<void>) | null = null
  private inflight = new Set<Promise<void>>()
  captureStatus: 'COMPLETED' | 'PENDING'
  private validityMs: number
  private fees: FeePolicy
  /** Test hook: swallow every webhook (PayPal never delivered it), so only the reconciler can confirm money movements. */
  dropWebhooks = false
  /** Test hook: make the next call to a method fail like PayPal would. */
  failNext: { method: string; issue: string; status?: number } | null = null

  constructor(o: SimulatedRailOptions) {
    this.db = o.db
    this.publicUrl = o.publicUrl
    this.now = o.now ?? (() => new Date())
    this.delay = o.webhookDelayMs ?? 300
    this.captureStatus = o.captureStatus ?? 'COMPLETED'
    this.validityMs = o.authorizationValidityMs ?? 29 * 86_400_000
    this.fees = o.fees ?? DEFAULT_FEES
    this.dropWebhooks = o.dropWebhooks ?? false
  }

  // ---------- persistence ----------
  private load<T>(kind: string, id: string): T | null {
    const r = this.db.get<{ data: string }>('SELECT data FROM sim_objects WHERE id = ? AND kind = ?', `${kind}:${id}`, kind)
    return r ? json<T>(r.data) : null
  }
  private save(kind: string, id: string, data: unknown) {
    this.db.run('INSERT INTO sim_objects (id, kind, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', `${kind}:${id}`, kind, JSON.stringify(data))
  }
  /** PayPal-Request-Id semantics: the same id returns the first response and does nothing else. */
  private async once<T>(method: string, requestId: string, fn: () => T | Promise<T>): Promise<T> {
    const prior = this.load<T>('req', `${method}:${requestId}`)
    if (prior) return prior
    if (this.failNext && this.failNext.method === method) {
      const f = this.failNext
      this.failNext = null
      throw new PaymentError(`Simulated PayPal ${f.issue}`, 'Simulated failure injected by a test.', { httpStatus: f.status ?? 422, issue: f.issue, definitive: (f.status ?? 422) < 500 })
    }
    const out = await fn()
    this.save('req', `${method}:${requestId}`, out)
    return out
  }
  private fail(issue: string, message: string, hint: string): never {
    throw new PaymentError(`Simulated PayPal UNPROCESSABLE_ENTITY: ${issue} (${message})`, hint, { httpStatus: 422, issue, definitive: true })
  }

  // ---------- webhooks ----------
  setWebhookSink(sink: (raw: string) => Promise<void>) {
    this.sink = sink
  }
  private emit(event_type: string, resource_type: string, resource: Record<string, unknown>) {
    if (this.dropWebhooks) return
    const body = JSON.stringify({
      id: `WH-SIM-${ppId(20)}`,
      event_version: '1.0',
      create_time: this.now().toISOString(),
      resource_type,
      event_type,
      summary: `Simulated ${event_type}`,
      resource,
    })
    const p = new Promise<void>((resolve) => setTimeout(resolve, this.delay))
      .then(() => this.sink?.(body))
      .catch(() => {})
      .finally(() => this.inflight.delete(p))
    this.inflight.add(p)
  }
  get pending() {
    return this.inflight.size
  }
  /** Wait until every scheduled webhook has been delivered (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight])
  }

  private money = (c: number) => ({ currency_code: 'USD', value: toValue(c) })
  private authInfo = (a: SimAuth): AuthorizationInfo => ({ authorization_id: a.id, status: a.status, amount_cents: a.amount_cents, expires_at: a.expires_at })
  private orderInfo(o: SimOrder): OrderInfo {
    const a = o.authorization_id ? this.load<SimAuth>('auth', o.authorization_id) : null
    return {
      order_id: o.id,
      status: o.status,
      approval_url: o.status === 'PAYER_ACTION_REQUIRED' ? `${this.publicUrl}/sim/paypal/order/${o.id}` : null,
      authorization: a ? this.authInfo(a) : null,
    }
  }
  private authResource = (a: SimAuth) => ({
    id: a.id,
    status: a.status,
    amount: this.money(a.amount_cents),
    custom_id: a.custom_id,
    expiration_time: a.expires_at,
    supplementary_data: { related_ids: { order_id: a.order_id } },
  })

  private createAuthorization(o: SimOrder): SimAuth {
    const a: SimAuth = {
      id: ppId(17),
      order_id: o.id,
      status: 'CREATED',
      amount_cents: o.amount_cents,
      captured_cents: 0,
      custom_id: o.custom_id,
      expires_at: new Date(this.now().getTime() + this.validityMs).toISOString(),
      reauthorized: false,
    }
    this.save('auth', a.id, a)
    o.authorization_id = a.id
    o.status = 'COMPLETED'
    this.save('order', o.id, o)
    this.emit('PAYMENT.AUTHORIZATION.CREATED', 'authorization', this.authResource(a))
    return a
  }

  // ---------- orders ----------
  createOrder(p: CreateOrderParams): Promise<OrderInfo> {
    return this.once('createOrder', p.request_id, () => {
      if (p.amount_cents <= 0) this.fail('INVALID_PARAMETER_VALUE', 'amount must be positive', 'Fund a non-zero amount.')
      const o: SimOrder = { id: ppId(17), status: p.vault_id ? 'APPROVED' : 'PAYER_ACTION_REQUIRED', amount_cents: p.amount_cents, custom_id: p.contract_hash, job_id: p.job_id, vault_id: p.vault_id, authorization_id: null }
      this.save('order', o.id, o)
      if (p.vault_id) {
        if (!this.load('ptoken', p.vault_id)) this.fail('INVALID_RESOURCE_ID', 'vault_id not found', 'The mandate payment token is unknown; ask the owner to approve a new mandate.')
        // Vaulted PayPal: the order is authorized on create, like PayPal returns COMPLETED with the authorization.
        this.createAuthorization(o)
      }
      return this.orderInfo(o)
    })
  }
  async getOrder(order_id: string): Promise<OrderInfo> {
    const o = this.load<SimOrder>('order', order_id)
    if (!o) this.fail('RESOURCE_NOT_FOUND', 'order not found', 'Check the order id.')
    return this.orderInfo(o)
  }
  authorizeOrder(p: { order_id: string; request_id: string }): Promise<OrderInfo> {
    return this.once('authorizeOrder', p.request_id, () => {
      const o = this.load<SimOrder>('order', p.order_id)
      if (!o) this.fail('RESOURCE_NOT_FOUND', 'order not found', 'Check the order id.')
      if (o.status === 'COMPLETED' && o.authorization_id) this.fail('ORDER_ALREADY_AUTHORIZED', 'order already authorized', 'Use the existing authorization.')
      if (o.status !== 'APPROVED') this.fail('ORDER_NOT_APPROVED', 'payer has not approved the order', 'A human must approve the order first.')
      this.createAuthorization(o)
      return this.orderInfo(o)
    })
  }

  // ---------- authorizations ----------
  captureAuthorization(p: { authorization_id: string; request_id: string; amount_cents: number; final_capture: boolean }): Promise<CaptureInfo> {
    return this.once('captureAuthorization', p.request_id, () => {
      const a = this.load<SimAuth>('auth', p.authorization_id)
      if (!a) this.fail('RESOURCE_NOT_FOUND', 'authorization not found', 'Check the authorization id.')
      if (!['CREATED', 'PARTIALLY_CAPTURED'].includes(a.status)) this.fail('AUTHORIZATION_ALREADY_COMPLETED', `authorization is ${a.status}`, 'Nothing is left to capture on this authorization.')
      if (this.now().toISOString() > a.expires_at) this.fail('AUTHORIZATION_EXPIRED', 'authorization expired', 'Reauthorize or create a new order.')
      if (p.amount_cents <= 0) this.fail('INVALID_PARAMETER_VALUE', 'amount must be positive', 'Capture a positive amount.')
      if (a.captured_cents + p.amount_cents > a.amount_cents) this.fail('MAX_CAPTURE_AMOUNT_EXCEEDED', 'capture exceeds the authorized amount', 'Capture at most the remaining authorized amount.')
      a.captured_cents += p.amount_cents
      a.status = p.final_capture || a.captured_cents === a.amount_cents ? 'CAPTURED' : 'PARTIALLY_CAPTURED'
      this.save('auth', a.id, a)
      const c: SimCapture = { id: ppId(17), authorization_id: a.id, order_id: a.order_id, amount_cents: p.amount_cents, refunded_cents: 0, status: this.captureStatus, custom_id: a.custom_id }
      // The capture is COMPLETED at PayPal from here on; the sync answer may still say PENDING.
      // The webhook (or, when it never comes, GET capture) confirms completion.
      const done = { ...c, status: 'COMPLETED' }
      this.save('capture', c.id, done)
      // A fee can never exceed the capture (a tiny capture, e.g. only a mediation fee, used to throw here AFTER the authorization was marked captured).
      const fee = Math.min(c.amount_cents, estimatedCaptureFee(c.amount_cents, this.fees))
      const breakdown = { gross_amount: this.money(c.amount_cents), paypal_fee: this.money(fee), net_amount: this.money(c.amount_cents - fee) }
      this.emit('PAYMENT.CAPTURE.COMPLETED', 'capture', {
        id: c.id,
        status: 'COMPLETED',
        amount: this.money(c.amount_cents),
        seller_receivable_breakdown: breakdown,
        final_capture: p.final_capture,
        custom_id: c.custom_id,
        supplementary_data: { related_ids: { order_id: c.order_id, authorization_id: a.id } },
      })
      const sync = c.status === 'COMPLETED' ? { paypal_fee_cents: fee, net_cents: c.amount_cents - fee } : { paypal_fee_cents: null, net_cents: null }
      return { capture_id: c.id, status: c.status, amount_cents: c.amount_cents, final_capture: p.final_capture, ...sync }
    })
  }
  voidAuthorization(p: { authorization_id: string; request_id: string }): Promise<{ status: string }> {
    return this.once('voidAuthorization', p.request_id, () => {
      const a = this.load<SimAuth>('auth', p.authorization_id)
      if (!a) this.fail('RESOURCE_NOT_FOUND', 'authorization not found', 'Check the authorization id.')
      if (a.status !== 'CREATED' && a.status !== 'PARTIALLY_CAPTURED') this.fail('CANNOT_BE_VOIDED', `authorization is ${a.status}`, 'A captured or voided authorization cannot be voided.')
      a.status = 'VOIDED'
      this.save('auth', a.id, a)
      this.emit('PAYMENT.AUTHORIZATION.VOIDED', 'authorization', this.authResource(a))
      return { status: 'VOIDED' }
    })
  }
  reauthorize(p: { authorization_id: string; request_id: string; amount_cents: number }): Promise<AuthorizationInfo> {
    return this.once('reauthorize', p.request_id, () => {
      const a = this.load<SimAuth>('auth', p.authorization_id)
      if (!a) this.fail('RESOURCE_NOT_FOUND', 'authorization not found', 'Check the authorization id.')
      if (a.status !== 'CREATED') this.fail('REAUTHORIZATION_NOT_SUPPORTED', `authorization is ${a.status}`, 'Only an uncaptured authorization can be reauthorized.')
      if (a.reauthorized) this.fail('MAX_NUMBER_OF_REAUTHORIZATIONS_EXCEEDED', 'already reauthorized once', 'Capture or void instead.')
      if (p.amount_cents > a.amount_cents) this.fail('REAUTHORIZE_AMOUNT_EXCEEDED', 'amount above the original', 'Reauthorize at most the original amount.')
      a.reauthorized = true
      a.status = 'VOIDED' // the old authorization is replaced
      this.save('auth', a.id, a)
      const n: SimAuth = { ...a, id: ppId(17), status: 'CREATED', amount_cents: p.amount_cents, captured_cents: 0, reauthorized: true, expires_at: new Date(this.now().getTime() + this.validityMs).toISOString() }
      this.save('auth', n.id, n)
      const o = this.load<SimOrder>('order', a.order_id)
      if (o) this.save('order', o.id, { ...o, authorization_id: n.id })
      this.emit('PAYMENT.AUTHORIZATION.CREATED', 'authorization', this.authResource(n))
      return this.authInfo(n)
    })
  }

  // ---------- captures, payouts ----------
  refundCapture(p: { capture_id: string; request_id: string; amount_cents: number }): Promise<RefundInfo> {
    return this.once('refundCapture', p.request_id, () => {
      const c = this.load<SimCapture>('capture', p.capture_id)
      if (!c) this.fail('RESOURCE_NOT_FOUND', 'capture not found', 'Check the capture id.')
      if (p.amount_cents <= 0 || c.refunded_cents + p.amount_cents > c.amount_cents) this.fail('REFUND_AMOUNT_EXCEEDED', 'refund exceeds the captured amount', 'Refund at most what is left of the capture.')
      c.refunded_cents += p.amount_cents
      c.status = c.refunded_cents === c.amount_cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
      this.save('capture', c.id, c)
      const id = ppId(17)
      this.emit('PAYMENT.CAPTURE.REFUNDED', 'refund', {
        id,
        status: 'COMPLETED',
        amount: this.money(p.amount_cents),
        custom_id: c.custom_id,
        links: [{ rel: 'up', href: `${this.publicUrl}/sim/v2/payments/captures/${c.id}`, method: 'GET' }],
      })
      return { refund_id: id, status: 'COMPLETED', amount_cents: p.amount_cents }
    })
  }
  async getCapture(capture_id: string): Promise<CaptureInfo> {
    const c = this.load<SimCapture>('capture', capture_id)
    if (!c) this.fail('RESOURCE_NOT_FOUND', 'capture not found', 'Check the capture id.')
    const fee = Math.min(c.amount_cents, estimatedCaptureFee(c.amount_cents, this.fees))
    return { capture_id: c.id, status: c.status, amount_cents: c.amount_cents, final_capture: false, paypal_fee_cents: fee, net_cents: c.amount_cents - fee }
  }
  async getPayoutItem(p: { batch_id: string; sender_item_id: string }): Promise<PayoutItemInfo> {
    const r = this.load<{ batch: string; item: string; ok: boolean }>('payout', p.sender_item_id)
    if (!r) this.fail('RESOURCE_NOT_FOUND', 'payout item not found', 'Check the payout batch id.')
    return { batch_id: r.batch, item_id: r.item, status: r.ok ? 'SUCCESS' : 'FAILED', fee_cents: r.ok ? this.fees.paypal_payout_cents : 0 }
  }
  payout(p: { request_id: string; sender_item_id: string; receiver_email: string; amount_cents: number; note: string }): Promise<PayoutInfo> {
    return this.once('payout', p.request_id, () => {
      if (p.amount_cents <= 0) this.fail('VALIDATION_ERROR', 'payout amount must be positive', 'Pay out a positive amount.')
      const batch = `SIMBATCH${ppId(13)}`
      const item = `SIMITEM${ppId(13)}`
      // Sandbox convention: an address containing "fail" bounces, so the failure path can be shown.
      const ok = !/fail/i.test(p.receiver_email)
      this.save('payout', p.sender_item_id, { batch, item, ok })
      this.emit(ok ? 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' : 'PAYMENT.PAYOUTS-ITEM.FAILED', 'payouts_item', {
        payout_item_id: item,
        payout_batch_id: batch,
        transaction_status: ok ? 'SUCCESS' : 'FAILED',
        payout_item_fee: { currency: 'USD', value: toValue(ok ? this.fees.paypal_payout_cents : 0) },
        payout_item: { recipient_type: 'EMAIL', amount: { value: toValue(p.amount_cents), currency: 'USD' }, receiver: p.receiver_email, sender_item_id: p.sender_item_id, note: p.note },
      })
      return { batch_id: batch, status: 'PENDING', item_id: item }
    })
  }

  // ---------- vault ----------
  createVaultSetupToken(p: { mandate_id: string; request_id: string }): Promise<VaultSetupInfo> {
    return this.once('createVaultSetupToken', p.request_id, () => {
      const s: SimSetup = { id: `SIMSETUP${ppId(12)}`, status: 'PAYER_ACTION_REQUIRED', mandate_id: p.mandate_id }
      this.save('setup', s.id, s)
      return { setup_token_id: s.id, status: s.status, approval_url: `${this.publicUrl}/sim/paypal/vault/${s.id}` }
    })
  }
  createPaymentToken(p: { setup_token_id: string; request_id: string }): Promise<PaymentTokenInfo> {
    return this.once('createPaymentToken', p.request_id, () => {
      const s = this.load<SimSetup>('setup', p.setup_token_id)
      if (!s) this.fail('RESOURCE_NOT_FOUND', 'setup token not found', 'Request a new mandate.')
      if (s.status !== 'APPROVED') this.fail('SETUP_TOKEN_NOT_APPROVED', 'payer has not approved the setup token', 'The owner must approve the mandate first.')
      const id = `SIMTOKEN${ppId(12)}`
      this.save('ptoken', id, { id, setup_token_id: s.id })
      s.status = 'VAULTED'
      this.save('setup', s.id, s)
      this.emit('VAULT.PAYMENT-TOKEN.CREATED', 'payment_token', { id, metadata: { setup_token_id: s.id }, customer: { id: `SIMCUST${ppId(10)}` } })
      return { payment_token_id: id, customer_id: null }
    })
  }

  async verifyWebhook(): Promise<boolean> {
    // Real webhooks never reach the simulated rail; anything posted to the webhook URL is rejected.
    return false
  }

  /** The stand-in approval page decided. Order approval also emits CHECKOUT.ORDER.APPROVED. */
  async simulateApproval(kind: 'order' | 'vault', id: string, approve: boolean): Promise<void> {
    if (kind === 'order') {
      const o = this.load<SimOrder>('order', id)
      if (!o) this.fail('RESOURCE_NOT_FOUND', 'order not found', 'Check the order id.')
      if (o.status !== 'PAYER_ACTION_REQUIRED') return
      o.status = approve ? 'APPROVED' : 'VOIDED'
      this.save('order', o.id, o)
      if (approve)
        this.emit('CHECKOUT.ORDER.APPROVED', 'checkout-order', {
          id: o.id,
          status: 'APPROVED',
          intent: 'AUTHORIZE',
          purchase_units: [{ reference_id: o.job_id, custom_id: o.custom_id, amount: this.money(o.amount_cents) }],
        })
    } else {
      const s = this.load<SimSetup>('setup', id)
      if (!s) this.fail('RESOURCE_NOT_FOUND', 'setup token not found', 'Request a new mandate.')
      if (s.status !== 'PAYER_ACTION_REQUIRED') return
      s.status = approve ? 'APPROVED' : 'CANCELLED'
      this.save('setup', s.id, s)
    }
  }

  /** Seed helper: an already-approved payment token (the demo owner approved a mandate earlier). */
  seedPaymentToken(): string {
    const id = `SIMTOKEN${ppId(12)}`
    this.save('ptoken', id, { id, setup_token_id: null })
    return id
  }

  async close() {
    await this.flush()
    this.sink = null
  }
}
