// The payment rail seam. Only the escrow service (server/src/core/escrow.ts) calls a rail.
// Amounts cross this seam as integer cents (USD); rails format them as PayPal decimal strings.
// Every mutating call carries a request_id that becomes the PayPal-Request-Id header, so a retry
// with the same id can never move money twice.
import type { PaymentRailKind } from '@rentabot/shared'
import { OpError } from '../core/types.ts'

export interface AuthorizationInfo {
  authorization_id: string
  /** PayPal authorization status: CREATED, PENDING, CAPTURED, PARTIALLY_CAPTURED, VOIDED, DENIED, EXPIRED. */
  status: string
  amount_cents: number
  /** End of the 29-day validity (PayPal `expiration_time`). */
  expires_at: string | null
}

export interface OrderInfo {
  order_id: string
  /** PayPal order status: CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED. */
  status: string
  /** Where a human approves the order (rel "payer-action" or "approve"); null when no approval is needed. */
  approval_url: string | null
  /** Present once the order has been authorized (vaulted payment sources authorize on create). */
  authorization: AuthorizationInfo | null
}

export interface CreateOrderParams {
  job_id: string
  request_id: string
  amount_cents: number
  currency: 'USD'
  /** Goes to purchase_units[0].custom_id: the Cart Mandate points at the signed contract. */
  contract_hash: string
  description: string
  /** Vault v3 payment token id from an active mandate; null → approval link for a human. */
  vault_id: string | null
  return_url: string
  cancel_url: string
  brand_name: string
}

export interface CaptureInfo {
  capture_id: string
  /** COMPLETED, PENDING, DECLINED, FAILED, … */
  status: string
  amount_cents: number
  final_capture: boolean
  /** seller_receivable_breakdown.paypal_fee / net_amount when PayPal reports them. */
  paypal_fee_cents?: number | null
  net_cents?: number | null
}

export interface RefundInfo {
  refund_id: string
  status: string // COMPLETED, PENDING, CANCELLED, FAILED
  amount_cents: number
}

export interface PayoutInfo {
  batch_id: string
  /** Batch status: PENDING, PROCESSING, SUCCESS, DENIED… */
  status: string
  item_id: string | null
}

/** One payout item as PayPal reports it when asked (the reconciler's webhook fallback). */
export interface PayoutItemInfo {
  batch_id: string
  item_id: string | null
  /** PayPal transaction_status: SUCCESS, PENDING, ONHOLD, UNCLAIMED, FAILED, RETURNED, BLOCKED, DENIED, REFUNDED, REVERSED. */
  status: string
  /** payout_item_fee in cents, when PayPal reports it. */
  fee_cents: number | null
}

export interface VaultSetupInfo {
  setup_token_id: string
  status: string // PAYER_ACTION_REQUIRED, APPROVED, …
  approval_url: string | null
}

export interface PaymentTokenInfo {
  payment_token_id: string
  customer_id: string | null
}

export interface PaymentRail {
  readonly kind: PaymentRailKind
  createOrder(p: CreateOrderParams): Promise<OrderInfo>
  getOrder(order_id: string): Promise<OrderInfo>
  /** POST /v2/checkout/orders/{id}/authorize after the buyer approved. */
  authorizeOrder(p: { order_id: string; request_id: string }): Promise<OrderInfo>
  captureAuthorization(p: { authorization_id: string; request_id: string; amount_cents: number; final_capture: boolean; note?: string }): Promise<CaptureInfo>
  voidAuthorization(p: { authorization_id: string; request_id: string }): Promise<{ status: string }>
  reauthorize(p: { authorization_id: string; request_id: string; amount_cents: number }): Promise<AuthorizationInfo>
  refundCapture(p: { capture_id: string; request_id: string; amount_cents: number; note?: string }): Promise<RefundInfo>
  /** GET /v2/payments/captures/{id}: where the reconciler looks when a capture webhook never arrived. */
  getCapture(capture_id: string): Promise<CaptureInfo>
  /** GET /v1/payments/payouts/{batch_id}: the item's status when a payout webhook never arrived. */
  getPayoutItem(p: { batch_id: string; sender_item_id: string }): Promise<PayoutItemInfo>
  /** One-item Payouts batch to a PayPal email. request_id becomes sender_batch_id. */
  payout(p: { request_id: string; sender_item_id: string; receiver_email: string; amount_cents: number; note: string }): Promise<PayoutInfo>
  createVaultSetupToken(p: { mandate_id: string; request_id: string; return_url: string; cancel_url: string; brand_name: string; description: string }): Promise<VaultSetupInfo>
  createPaymentToken(p: { setup_token_id: string; request_id: string }): Promise<PaymentTokenInfo>
  /** true when the webhook really came from PayPal (verify-webhook-signature). */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean>
  /** Simulated rail only: deliver webhook bodies to the core (same path as real webhooks, minus the signature check). */
  setWebhookSink?(sink: (rawBody: string) => Promise<void>): void
  /** Simulated rail only: the stand-in approval page decided. */
  simulateApproval?(kind: 'order' | 'vault', id: string, approve: boolean): Promise<void>
  close?(): Promise<void>
}

/** A rail call failed. `definitive` = PayPal answered with an error (a retry with a new request id is a new attempt);
 *  false = network/5xx, outcome unknown (retry with the SAME request id). */
export class PaymentError extends OpError {
  readonly httpStatus: number | null
  readonly issue: string | null
  readonly debugId: string | null
  readonly definitive: boolean
  constructor(message: string, hint: string, info: { httpStatus?: number | null; issue?: string | null; debugId?: string | null; definitive?: boolean } = {}) {
    super('payment_failed', message, hint)
    this.httpStatus = info.httpStatus ?? null
    this.issue = info.issue ?? null
    this.debugId = info.debugId ?? null
    this.definitive = info.definitive ?? false
  }
}

/** Integer cents → PayPal decimal string. */
export const toValue = (cents: number) => {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`invalid cents amount: ${cents}`)
  return (cents / 100).toFixed(2)
}
/** PayPal decimal string → integer cents (exact for 2-decimal strings). */
export const fromValue = (value: string | number | undefined | null) => {
  if (value === undefined || value === null || value === '') return 0
  const s = String(value)
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!m) return Math.round(Number(s) * 100)
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'))
}
