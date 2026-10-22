// PayPal webhook bodies → one normalized shape the escrow service understands.
// Used for real PayPal webhooks and for the simulated rail's events (which are PayPal-shaped JSON),
// so both go through the same code path.
import { fromValue } from './types.ts'

export interface RailEvent {
  /** Webhook event id (WH-…), used to drop duplicate deliveries. */
  event_id: string
  event_type: string
  order_id: string | null
  authorization_id: string | null
  capture_id: string | null
  refund_id: string | null
  payout_batch_id: string | null
  payout_item_id: string | null
  sender_item_id: string | null
  setup_token_id: string | null
  payment_token_id: string | null
  dispute_id: string | null
  custom_id: string | null
  status: string | null
  amount_cents: number | null
  final_capture: boolean | null
  /** PayPal's fee on this capture (seller_receivable_breakdown.paypal_fee) or payout item (payout_item_fee). */
  fee_cents: number | null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The id behind a HATEOAS link with the given rel (".../captures/ABC" → "ABC"). */
const linkId = (links: unknown, rel: string): string | null => {
  if (!Array.isArray(links)) return null
  for (const l of links) {
    const o = obj(l)
    if (o.rel === rel && typeof o.href === 'string') return o.href.split('/').filter(Boolean).pop() ?? null
  }
  return null
}

export function parseWebhook(rawBody: string): RailEvent | null {
  let body: Obj
  try {
    body = obj(JSON.parse(rawBody))
  } catch {
    return null
  }
  const event_type = str(body.event_type)
  const event_id = str(body.id)
  if (!event_type || !event_id) return null
  const r = obj(body.resource)
  const related = obj(obj(r.supplementary_data).related_ids)
  const amount = obj(r.amount)
  const e: RailEvent = {
    event_id,
    event_type,
    order_id: null,
    authorization_id: null,
    capture_id: null,
    refund_id: null,
    payout_batch_id: null,
    payout_item_id: null,
    sender_item_id: null,
    setup_token_id: null,
    payment_token_id: null,
    dispute_id: null,
    custom_id: str(r.custom_id),
    status: str(r.status),
    amount_cents: amount.value !== undefined ? fromValue(amount.value as string) : null,
    final_capture: typeof r.final_capture === 'boolean' ? r.final_capture : null,
    fee_cents: null,
  }
  const srb = obj(obj(r.seller_receivable_breakdown).paypal_fee)
  if (srb.value !== undefined) e.fee_cents = fromValue(srb.value as string)
  const pif = obj(r.payout_item_fee)
  if (pif.value !== undefined) e.fee_cents = fromValue(pif.value as string)
  const resourceType = str(body.resource_type)
  if (event_type.startsWith('CHECKOUT.ORDER.')) {
    e.order_id = str(r.id)
    const pu = obj(Array.isArray(r.purchase_units) ? r.purchase_units[0] : null)
    e.custom_id = str(pu.custom_id) ?? e.custom_id
    const pa = obj(pu.amount)
    if (pa.value !== undefined) e.amount_cents = fromValue(pa.value as string)
  } else if (event_type.startsWith('PAYMENT.AUTHORIZATION.')) {
    e.authorization_id = str(r.id)
    e.order_id = str(related.order_id)
  } else if (event_type === 'PAYMENT.CAPTURE.REFUNDED' || event_type === 'PAYMENT.CAPTURE.REVERSED' || resourceType === 'refund') {
    e.refund_id = str(r.id)
    e.capture_id = linkId(r.links, 'up') ?? str(related.capture_id)
    e.order_id = str(related.order_id)
  } else if (event_type.startsWith('PAYMENT.CAPTURE.')) {
    e.capture_id = str(r.id)
    e.authorization_id = str(related.authorization_id)
    e.order_id = str(related.order_id)
  } else if (event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    e.payout_item_id = str(r.payout_item_id)
    e.payout_batch_id = str(r.payout_batch_id)
    e.status = str(r.transaction_status)
    const item = obj(r.payout_item)
    e.sender_item_id = str(item.sender_item_id) ?? str(r.sender_item_id)
    const ia = obj(item.amount)
    if (ia.value !== undefined) e.amount_cents = fromValue(ia.value as string)
  } else if (event_type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    e.payout_batch_id = str(obj(r.batch_header).payout_batch_id)
    e.status = str(obj(r.batch_header).batch_status)
  } else if (event_type.startsWith('VAULT.PAYMENT-TOKEN.')) {
    e.payment_token_id = str(r.id)
    // Vault v3 events carry the setup token the payment token was created from in metadata when available.
    e.setup_token_id = str(obj(r.metadata).setup_token_id) ?? str(r.setup_token_id)
  } else if (event_type.startsWith('CUSTOMER.DISPUTE.')) {
    e.dispute_id = str(r.dispute_id)
    const tx = obj(Array.isArray(r.disputed_transactions) ? r.disputed_transactions[0] : null)
    e.capture_id = str(tx.seller_transaction_id)
    e.custom_id = str(tx.custom) ?? e.custom_id
    e.status = str(r.status)
  }
  return e
}
