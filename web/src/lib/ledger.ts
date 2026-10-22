// Pure ledger helpers shared by the Job Room escrow ledger and the account history (tested in server/test/web/ledger.test.ts).
import type { Escrow, EscrowEvent } from '../api/types'
import { cents } from './format'

const AWAITING_KINDS = ['order_created', 'approval_required', 'captured', 'authorized', 'voided', 'refunded']

/**
 * Payouts the platform has sent that PayPal has not confirmed yet. `escrow.paid_out` only counts confirmed payouts, so on its own it
 * reads $0.00 while a payout is on its way. A payout_succeeded / payout_failed settles the oldest unresolved payout_sent of the same
 * amount (a "Payout call failed" event has no payout_sent before it, so it settles nothing).
 */
export function payoutFlight(events: readonly EscrowEvent[]): { inFlightCents: number; unresolved: Set<EscrowEvent> } {
  const open: EscrowEvent[] = []
  for (const e of events) {
    if (e.kind === 'payout_sent') open.push(e)
    else if (e.kind === 'payout_succeeded' || e.kind === 'payout_failed') {
      const i = open.findIndex((s) => cents(s.amount?.value) === cents(e.amount?.value))
      if (i >= 0) open.splice(i, 1)
    }
  }
  return { inFlightCents: open.reduce((a, e) => a + cents(e.amount?.value), 0), unresolved: new Set(open) }
}

/** True while an event still waits for PayPal (webhook or reconciler) to confirm it. */
export function awaitingWebhook(e: EscrowEvent, events: readonly EscrowEvent[], flight = payoutFlight(events)): boolean {
  if (e.webhook_event) return false
  if (e.kind === 'payout_sent') return flight.unresolved.has(e)
  if (!AWAITING_KINDS.includes(e.kind)) return false
  // An order paid with a mandate never gets an approval webhook; once PayPal authorized the money, the order is proven.
  if ((e.kind === 'order_created' || e.kind === 'approval_required') && events.some((o) => o.kind === 'authorized' || o.kind === 'reauthorized')) return false
  return !events.some((o) => o !== e && o.paypal_id && o.paypal_id === e.paypal_id && o.webhook_event)
}

export type MoneyLine = { authorized: number; captured: number; voided: number; refunded: number; paidOut: number }

/** One job's money in cents, from the escrow's own fields (the same numbers the Job Room ledger prints). */
export function moneyLine(m: { authorized: { value: string }; captured: { value: string }; voided: { value: string }; refunded: { value: string }; paid_out: { value: string } }): MoneyLine {
  return { authorized: cents(m.authorized.value), captured: cents(m.captured.value), voided: cents(m.voided.value), refunded: cents(m.refunded.value), paidOut: cents(m.paid_out.value) }
}
