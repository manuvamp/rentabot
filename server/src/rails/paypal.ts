// Real PayPal REST rail (sandbox or live). Shapes checked 2026-10-19 against the published OpenAPI schemas
// (Orders v2.36, Payments v2, Payouts v1, Vault v3). Amounts cross the seam as integer cents (USD).
import { createHash } from 'node:crypto'
import type { PaymentRailKind } from '@rentabot/shared'
import {
  PaymentError,
  fromValue,
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

export interface PayPalRailOptions {
  clientId: string
  clientSecret: string
  webhookId: string
  env: 'sandbox' | 'live'
  /** Override the PayPal API origin (e.g. a Cloudflare Worker egress proxy for hosts without IPv4). Defaults to the official URL for `env`. */
  apiBase?: string
  /** Sent as `x-egress-key` on every request when set, so the egress proxy can reject strangers. */
  egressSecret?: string
  fetch?: typeof fetch
  now?: () => number
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const TIMEOUT_MS = 30_000
/** Vault v3 caps PayPal-Request-Id at 108 chars (Orders/Payments allow more); use the strictest everywhere. */
const REQUEST_ID_MAX = 108

/** Fit an id into `max` chars of [A-Za-z0-9_.:-]. If anything had to change, a hash of the original is appended
 *  so two different inputs can never collapse into the same idempotency key. */
export function fitId(id: string, max: number): string {
  const clean = id.replace(/[^A-Za-z0-9_.:-]/g, '_')
  if (clean === id && id.length <= max && id.length > 0) return id
  const h = createHash('sha256').update(id).digest('hex').slice(0, 16)
  return `${clean.slice(0, Math.max(0, max - h.length - 1))}-${h}`
}

const trim = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)
const usd = (cents: number) => ({ currency_code: 'USD', value: toValue(cents) })

const linkHref = (links: unknown, ...rels: string[]): string | null => {
  for (const rel of rels)
    for (const l of arr(links)) {
      const o = obj(l)
      if (o.rel === rel && typeof o.href === 'string') return o.href
    }
  return null
}

const toAuthorization = (a: Obj): AuthorizationInfo => ({
  authorization_id: String(a.id ?? ''),
  status: String(a.status ?? ''),
  amount_cents: fromValue(obj(a.amount).value as string | undefined),
  expires_at: str(a.expiration_time),
})

function toOrder(o: Obj): OrderInfo {
  const status = String(o.status ?? '')
  const pu = obj(arr(o.purchase_units)[0])
  const auths = arr(obj(pu.payments).authorizations)
  // An approval link only matters while the buyer still has to act.
  const needsBuyer = status === 'CREATED' || status === 'PAYER_ACTION_REQUIRED'
  return {
    order_id: String(o.id ?? ''),
    status,
    approval_url: needsBuyer ? linkHref(o.links, 'payer-action', 'approve') : null,
    authorization: auths.length ? toAuthorization(obj(auths[auths.length - 1])) : null,
  }
}

// Hints an agent can act on, keyed by PayPal issue (details[0].issue) or error name.
const HINTS: Record<string, string> = {
  INSTRUMENT_DECLINED: 'The buyer must choose another payment method: fund again to get a new approval link.',
  PAYER_ACTION_REQUIRED: 'The buyer must approve in PayPal: fund again to get an approval link.',
  PAYER_CANNOT_PAY: 'The buyer cannot pay with this PayPal account: fund again with a different payment method.',
  PAYER_ACCOUNT_RESTRICTED: 'The buyer PayPal account is restricted: the buyer must resolve it with PayPal or use another account.',
  PAYEE_ACCOUNT_RESTRICTED: 'The platform PayPal account is restricted: an operator must check the merchant account.',
  ORDER_NOT_APPROVED: 'The buyer has not approved the order yet: send them the approval link, then authorize again.',
  ORDER_ALREADY_AUTHORIZED: 'The order is already authorized: read the order to get the existing authorization.',
  ORDER_ALREADY_CAPTURED: 'The order was already captured: read the order instead of authorizing again.',
  ORDER_EXPIRED: 'The order expired: fund the job again to create a new order.',
  AUTHORIZATION_EXPIRED: 'The authorization expired: reauthorize while inside the 29-day window, otherwise fund again (or refund captured funds).',
  AUTHORIZATION_VOIDED: 'The authorization was voided: nothing is held anymore; fund again if the job continues.',
  PREVIOUSLY_VOIDED: 'The authorization was already voided: nothing is held anymore.',
  AUTHORIZATION_ALREADY_CAPTURED: 'The authorization is fully captured: nothing is left to capture or void; use refund to return money.',
  PREVIOUSLY_CAPTURED: 'The authorization is fully captured: nothing is left to capture or void; use refund to return money.',
  CANNOT_BE_VOIDED: 'This authorization can no longer be voided: refund the captured amount instead.',
  MAX_CAPTURE_AMOUNT_EXCEEDED: 'The capture is larger than what is still authorized: capture a smaller amount.',
  MAX_CAPTURE_COUNT_EXCEEDED: 'No more partial captures are allowed on this authorization: do a final capture or reauthorize.',
  // Sandbox 2026-10-19: 422 REAUTHORIZATION_TOO_SOON, "only allowed once from Day 4 to Day 29 since the date of the original authorization".
  REAUTHORIZATION_TOO_SOON: 'Reauthorization is only allowed once, from day 4 to day 29 after the original authorization: try again after the 3-day honor period.',
  REAUTHORIZE_TOO_EARLY: 'Reauthorization is only allowed after the 3-day honor period: try again later.',
  PAYOUT_NOT_AVAILABLE: 'PayPal does not let the platform account send Payouts (it is in a country that cannot, for example India): an operator must run the platform on a payouts-capable (US) business account.',
  MAX_NUMBER_OF_REAUTHORIZATIONS_EXCEEDED: 'This authorization cannot be reauthorized again: fund the job again with a new order.',
  CAPTURE_FULLY_REFUNDED: 'The capture is already fully refunded: nothing left to refund.',
  REFUND_AMOUNT_EXCEEDED: 'The refund is larger than what remains on the capture: refund a smaller amount.',
  REFUND_TIME_LIMIT_EXCEEDED: 'The capture is too old to refund through the API.',
  INSUFFICIENT_FUNDS: 'The platform PayPal balance is too low for this payout: an operator must add funds, then retry.',
  RECEIVER_UNREGISTERED: 'The seller email has no PayPal account yet: the seller must sign up or update their payout email.',
  RECEIVER_UNCONFIRMED: 'The seller PayPal account is unconfirmed: the seller must confirm it with PayPal.',
  DUPLICATE_REQUEST_ID: 'This request id was already used with different data: use the next attempt number for a genuinely new attempt.',
  DUPLICATE_INVOICE_ID: 'PayPal already has a transaction with this invoice id: read the existing one instead.',
  UNPROCESSABLE_ENTITY: 'PayPal rejected the request as invalid for the current state: read the order/authorization, then decide.',
  INVALID_REQUEST: 'PayPal rejected the request shape: this is a platform bug, report it.',
  RESOURCE_NOT_FOUND: 'PayPal does not know this id: check the order/authorization/capture id.',
  PERMISSION_DENIED: 'The platform PayPal app lacks a permission for this call (e.g. Payouts or Vault not enabled).',
  NOT_AUTHORIZED: 'The platform PayPal app lacks a permission for this call (e.g. Payouts or Vault not enabled).',
  AUTHENTICATION_FAILURE: 'PayPal rejected the platform credentials: an operator must check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.',
  invalid_client: 'PayPal rejected the platform credentials: an operator must check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.',
  RATE_LIMIT_REACHED: 'PayPal is rate limiting: retry later with the same request id.',
}

function errorFromResponse(op: string, status: number, body: Obj): PaymentError {
  const details = arr(body.details).map(obj)
  const d0 = details[0] ?? {}
  // Orders/Payments: {name, message, debug_id, details[{issue, description, field}]}; OAuth: {error, error_description}.
  const name = str(body.name) ?? str(body.error) ?? `HTTP_${status}`
  const issue = str(d0.issue) ?? name
  const description = str(d0.description) ?? str(body.message) ?? str(body.error_description) ?? 'no description'
  const debugId = str(body.debug_id)
  const field = str(d0.field)
  const msg = `PayPal ${name}: ${issue} (${description})${field ? ` [${field}]` : ''} during ${op}${debugId ? `, debug_id ${debugId}` : ''}`
  // 429/408 are client codes but the outcome is "not processed yet": retry with the same request id.
  const definitive = status >= 400 && status < 500 && status !== 429 && status !== 408
  const hint =
    HINTS[issue] ??
    HINTS[name] ??
    (definitive
      ? 'PayPal refused this request; a retry needs a new request id (next attempt number) and usually a change of input.'
      : 'Outcome unknown (PayPal server error): retry with the SAME request id so the call cannot run twice.')
  return new PaymentError(msg, hint, { httpStatus: status, issue, debugId, definitive })
}

const networkError = (op: string, err: unknown) =>
  new PaymentError(
    `PayPal network error during ${op}: ${err instanceof Error ? err.name + ': ' + err.message : String(err)}`,
    'Outcome unknown (no response from PayPal): retry with the SAME request id so the call cannot run twice.',
    { definitive: false },
  )

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | null => {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' && s ? s : null
  }
  return null
}

/** Actual fees PayPal reports on a capture: seller_receivable_breakdown.paypal_fee and net_amount. */
export function captureFees(body: Record<string, unknown>): { paypal_fee_cents: number | null; net_cents: number | null } {
  const b = (body.seller_receivable_breakdown ?? {}) as Record<string, { value?: string } | undefined>
  return {
    paypal_fee_cents: b.paypal_fee?.value !== undefined ? fromValue(b.paypal_fee.value) : null,
    net_cents: b.net_amount?.value !== undefined ? fromValue(b.net_amount.value) : null,
  }
}

export function createPayPalRail(opts: PayPalRailOptions): PaymentRail {
  const f = opts.fetch ?? globalThis.fetch
  const now = opts.now ?? Date.now
  const base = (opts.apiBase?.trim() || (opts.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/+$/, '')
  const egressSecret = opts.egressSecret?.trim() || ''
  const kind: PaymentRailKind = opts.env === 'live' ? 'paypal_live' : 'paypal_sandbox'

  let token: { value: string; expiresAt: number } | null = null
  let pending: Promise<string> | null = null

  const send = async (op: string, url: string, init: RequestInit): Promise<Response> => {
    try {
      const headers = egressSecret ? { ...(init.headers as Record<string, string> | undefined), 'x-egress-key': egressSecret } : init.headers
      return await f(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw networkError(op, err)
    }
  }

  const readJson = async (res: Response): Promise<Obj> => {
    const text = await res.text().catch(() => '')
    if (!text) return {}
    try {
      return obj(JSON.parse(text))
    } catch {
      return { message: text.slice(0, 200) }
    }
  }

  const fetchToken = async (): Promise<string> => {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')
    const res = await send('oauth token', `${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
    })
    const body = await readJson(res)
    if (!res.ok) throw errorFromResponse('oauth token', res.status, body)
    const value = str(body.access_token)
    if (!value) throw new PaymentError('PayPal oauth token: response had no access_token', HINTS.AUTHENTICATION_FAILURE!, { httpStatus: res.status })
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 300
    token = { value, expiresAt: now() + Math.max(0, ttl - 60) * 1000 }
    return value
  }

  const getToken = async (): Promise<string> => {
    if (token && now() < token.expiresAt) return token.value
    // One shared fetch for concurrent callers.
    pending ??= fetchToken().finally(() => {
      pending = null
    })
    return pending
  }

  /** One API call. `requestId` → PayPal-Request-Id (mutating POSTs). A 401 drops the cached token and retries once. */
  const call = async (
    op: string,
    method: 'GET' | 'POST',
    path: string,
    o: { body?: unknown; rawBody?: string; requestId?: string; representation?: boolean } = {},
  ): Promise<{ status: number; body: Obj }> => {
    const payload = o.rawBody ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined)
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' }
      if (payload !== undefined) headers['Content-Type'] = 'application/json'
      if (o.requestId) headers['PayPal-Request-Id'] = fitId(o.requestId, REQUEST_ID_MAX)
      if (o.representation) headers.Prefer = 'return=representation'
      const res = await send(op, `${base}${path}`, { method, headers, body: payload })
      if (res.status === 401 && attempt === 0) {
        await res.text().catch(() => '')
        token = null
        continue
      }
      const body = await readJson(res)
      if (!res.ok) throw errorFromResponse(op, res.status, body)
      return { status: res.status, body }
    }
  }

  const id = (s: string) => encodeURIComponent(s)

  return {
    kind,

    async createOrder(p: CreateOrderParams): Promise<OrderInfo> {
      const experience_context = {
        brand_name: trim(p.brand_name, 127),
        shipping_preference: 'NO_SHIPPING',
        // The amount is final when the buyer approves, so PAY_NOW; we still authorize (not capture) server-side.
        user_action: 'PAY_NOW',
        return_url: p.return_url,
        cancel_url: p.cancel_url,
      }
      const paypal: Obj = p.vault_id
        ? {
            vault_id: p.vault_id,
            // Merchant-initiated charge on a saved PayPal token; usage_pattern matches the setup token's.
            // Verified in the sandbox 2026-10-19: this order authorizes immediately (status COMPLETED, authorization CREATED)
            // with no buyer click, and PayPal echoes the stored_credential back on the order.
            stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', usage_pattern: 'IMMEDIATE' },
            // Only used if PayPal still asks the payer to act (PAYER_ACTION_REQUIRED).
            experience_context,
          }
        : { experience_context }
      const { body } = await call(
        'create order',
        'POST',
        '/v2/checkout/orders',
        {
          requestId: p.request_id,
          representation: true,
          body: {
            intent: 'AUTHORIZE',
            purchase_units: [
              {
                reference_id: trim(p.job_id, 256),
                custom_id: trim(p.contract_hash, 255),
                description: trim(p.description, 127),
                amount: { currency_code: p.currency, value: toValue(p.amount_cents) },
              },
            ],
            payment_source: { paypal },
          },
        },
      )
      return toOrder(body)
    },

    async getOrder(order_id: string): Promise<OrderInfo> {
      const { body } = await call('get order', 'GET', `/v2/checkout/orders/${id(order_id)}`)
      return toOrder(body)
    },

    async authorizeOrder(p): Promise<OrderInfo> {
      const { body } = await call('authorize order', 'POST', `/v2/checkout/orders/${id(p.order_id)}/authorize`, {
        requestId: p.request_id,
        representation: true,
        body: {},
      })
      return toOrder(body)
    },

    async captureAuthorization(p): Promise<CaptureInfo> {
      const req: Obj = { amount: usd(p.amount_cents), final_capture: p.final_capture }
      if (p.note) req.note_to_payer = trim(p.note, 255)
      const { body } = await call('capture authorization', 'POST', `/v2/payments/authorizations/${id(p.authorization_id)}/capture`, {
        requestId: p.request_id,
        representation: true,
        body: req,
      })
      return {
        capture_id: String(body.id ?? ''),
        status: String(body.status ?? ''),
        amount_cents: body.amount ? fromValue(obj(body.amount).value as string) : p.amount_cents,
        final_capture: typeof body.final_capture === 'boolean' ? body.final_capture : p.final_capture,
        ...captureFees(body),
      }
    },

    async getCapture(capture_id: string): Promise<CaptureInfo> {
      const { body } = await call('get capture', 'GET', `/v2/payments/captures/${id(capture_id)}`)
      return {
        capture_id: String(body.id ?? capture_id),
        status: String(body.status ?? ''),
        amount_cents: body.amount ? fromValue(obj(body.amount).value as string) : 0,
        final_capture: typeof body.final_capture === 'boolean' ? body.final_capture : false,
        ...captureFees(body),
      }
    },

    async getPayoutItem(p): Promise<PayoutItemInfo> {
      const { body } = await call('get payout batch', 'GET', `/v1/payments/payouts/${id(p.batch_id)}`)
      const items = arr(body.items).map(obj)
      const it = items.find((x) => str(obj(x.payout_item).sender_item_id) === fitId(p.sender_item_id, 63)) ?? items[0]
      if (!it) throw new PaymentError('PayPal payout batch has no items yet.', 'PayPal has not listed the payout item yet: the reconciler asks again later.', { definitive: false })
      const fee = obj(it.payout_item_fee)
      return {
        batch_id: p.batch_id,
        item_id: str(it.payout_item_id),
        status: String(it.transaction_status ?? ''),
        fee_cents: fee.value !== undefined ? fromValue(fee.value as string) : null,
      }
    },

    async voidAuthorization(p): Promise<{ status: string }> {
      // 204 No Content by default; 200 with the authorization when representation is honoured.
      const { body } = await call('void authorization', 'POST', `/v2/payments/authorizations/${id(p.authorization_id)}/void`, {
        requestId: p.request_id,
        representation: true,
      })
      return { status: str(body.status) ?? 'VOIDED' }
    },

    async reauthorize(p): Promise<AuthorizationInfo> {
      const { body } = await call('reauthorize', 'POST', `/v2/payments/authorizations/${id(p.authorization_id)}/reauthorize`, {
        requestId: p.request_id,
        representation: true,
        body: { amount: usd(p.amount_cents) },
      })
      const a = toAuthorization(body)
      if (!a.amount_cents) a.amount_cents = p.amount_cents
      return a
    },

    async refundCapture(p): Promise<RefundInfo> {
      const req: Obj = { amount: usd(p.amount_cents) }
      if (p.note) req.note_to_payer = trim(p.note, 255)
      const { body } = await call('refund capture', 'POST', `/v2/payments/captures/${id(p.capture_id)}/refund`, {
        requestId: p.request_id,
        representation: true,
        body: req,
      })
      return {
        refund_id: String(body.id ?? ''),
        status: String(body.status ?? ''),
        amount_cents: body.amount ? fromValue(obj(body.amount).value as string) : p.amount_cents,
      }
    },

    async payout(p): Promise<PayoutInfo> {
      // sender_batch_id is PayPal's own duplicate guard for payouts (a reused id is rejected), on top of PayPal-Request-Id.
      const { body } = await call('payout', 'POST', '/v1/payments/payouts', {
        requestId: p.request_id,
        body: {
          sender_batch_header: {
            sender_batch_id: fitId(p.request_id, REQUEST_ID_MAX),
            email_subject: 'You have a payout from Rent-A-Bot',
            email_message: trim(p.note, 1000),
          },
          items: [
            {
              recipient_type: 'EMAIL',
              receiver: p.receiver_email,
              amount: { value: toValue(p.amount_cents), currency: 'USD' },
              note: trim(p.note, 4000),
              sender_item_id: fitId(p.sender_item_id, 63),
            },
          ],
        },
      })
      const h = obj(body.batch_header)
      return { batch_id: String(h.payout_batch_id ?? ''), status: String(h.batch_status ?? ''), item_id: null }
    },

    async createVaultSetupToken(p): Promise<VaultSetupInfo> {
      const { body } = await call('create vault setup token', 'POST', '/v3/vault/setup-tokens', {
        requestId: p.request_id,
        body: {
          payment_source: {
            paypal: {
              description: trim(p.description, 128),
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
              // On-demand, variable amount and frequency: matches agents hiring bots inside a spending mandate.
              usage_pattern: 'IMMEDIATE',
              permit_multiple_payment_tokens: false,
              experience_context: {
                brand_name: trim(p.brand_name, 127),
                shipping_preference: 'NO_SHIPPING',
                // We call /v3/vault/payment-tokens ourselves after approval. PayPal (sandbox, verified 2026-10-19) rejects
                // user_action together with vault_instruction (MUTUALLY_EXCLUSIVE_FIELDS_PROVIDED), so only user_action is sent.
                user_action: 'CONTINUE',
                return_url: p.return_url,
                cancel_url: p.cancel_url,
              },
            },
          },
        },
      })
      return {
        setup_token_id: String(body.id ?? ''),
        status: String(body.status ?? ''),
        approval_url: linkHref(body.links, 'approve', 'payer-action'),
      }
    },

    async createPaymentToken(p): Promise<PaymentTokenInfo> {
      const { body } = await call('create payment token', 'POST', '/v3/vault/payment-tokens', {
        requestId: p.request_id,
        body: { payment_source: { token: { id: p.setup_token_id, type: 'SETUP_TOKEN' } } },
      })
      return { payment_token_id: String(body.id ?? ''), customer_id: str(obj(body.customer).id) }
    },

    async verifyWebhook(headers, rawBody): Promise<boolean> {
      const h = {
        auth_algo: header(headers, 'paypal-auth-algo'),
        cert_url: header(headers, 'paypal-cert-url'),
        transmission_id: header(headers, 'paypal-transmission-id'),
        transmission_sig: header(headers, 'paypal-transmission-sig'),
        transmission_time: header(headers, 'paypal-transmission-time'),
      }
      if (!opts.webhookId || Object.values(h).some((v) => !v)) return false
      try {
        if (!rawBody || typeof JSON.parse(rawBody) !== 'object') return false
      } catch {
        return false
      }
      // Splice the raw body in verbatim: re-serializing can change bytes and make PayPal's check fail.
      const prefix = JSON.stringify({ ...h, webhook_id: opts.webhookId })
      const payload = `${prefix.slice(0, -1)},"webhook_event":${rawBody}}`
      try {
        const { body } = await call('verify webhook', 'POST', '/v1/notifications/verify-webhook-signature', { rawBody: payload })
        return body.verification_status === 'SUCCESS'
      } catch (err) {
        // A 4xx means PayPal would not vouch for it → not verified. 5xx/network: outcome unknown, let the
        // caller answer 5xx so PayPal redelivers.
        if (err instanceof PaymentError && err.definitive) return false
        throw err
      }
    },
  }
}
