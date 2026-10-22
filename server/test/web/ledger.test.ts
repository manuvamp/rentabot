// Pure web helpers (web/src/lib/ledger.ts) tested here because the web workspace has no test runner.
import { describe, expect, it } from 'vitest'
import type { EscrowEvent } from '@rentabot/shared'
import { awaitingWebhook, moneyLine, payoutFlight } from '../../../web/src/lib/ledger.ts'

let n = 0
const ev = (kind: EscrowEvent['kind'], amount: string | null, o: Partial<EscrowEvent> = {}): EscrowEvent => ({
  kind,
  amount: amount === null ? null : { value: amount, currency: 'USD' },
  paypal_id: null,
  webhook_event: null,
  note: '',
  ts: new Date(Date.UTC(2026, 9, 20, 10, 0, n++)).toISOString(),
  ...o,
})

describe('payoutFlight', () => {
  it('counts a sent payout as in flight until it is confirmed or failed', () => {
    const sent = ev('payout_sent', '2.00', { paypal_id: 'BATCH1' })
    expect(payoutFlight([ev('captured', '5.00'), sent]).inFlightCents).toBe(200)
    expect(payoutFlight([sent, ev('payout_succeeded', '2.00', { paypal_id: 'ITEM1', webhook_event: 'reconciler' })]).inFlightCents).toBe(0)
    expect(payoutFlight([sent, ev('payout_failed', '2.00')]).inFlightCents).toBe(0)
  })

  it('a failed call (no payout_sent before it) settles nothing, and a retry is tracked on its own', () => {
    const failedCall = ev('payout_failed', '2.00', { note: 'Payout call failed: 403' })
    const retry = ev('payout_sent', '2.00', { paypal_id: 'BATCH2' })
    expect(payoutFlight([failedCall, retry]).inFlightCents).toBe(200)
    expect(payoutFlight([failedCall, retry, ev('payout_succeeded', '2.00')]).inFlightCents).toBe(0)
  })

  it('settles each payout once, so two payouts of the same amount stay separate', () => {
    const a = ev('payout_sent', '1.00')
    const b = ev('payout_sent', '1.00')
    const flight = payoutFlight([a, b, ev('payout_succeeded', '1.00')])
    expect(flight.inFlightCents).toBe(100)
    expect(flight.unresolved.has(b)).toBe(true)
    expect(flight.unresolved.has(a)).toBe(false)
  })
})

describe('awaitingWebhook', () => {
  it('clears on a payout_sent once the payout is confirmed, even for old events with no marker', () => {
    const sent = ev('payout_sent', '2.00', { paypal_id: 'BATCH1' })
    expect(awaitingWebhook(sent, [sent])).toBe(true)
    const events = [sent, ev('payout_succeeded', '2.00', { paypal_id: 'ITEM1', webhook_event: 'reconciler' })]
    expect(awaitingWebhook(sent, events)).toBe(false)
  })

  it('never waits once the server stamped the event', () => {
    const sent = ev('payout_sent', '2.00', { paypal_id: 'BATCH1', webhook_event: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' })
    expect(awaitingWebhook(sent, [sent])).toBe(false)
  })

  it('keeps the old rule for the other kinds: confirmed by another event with the same id', () => {
    const cap = ev('captured', '5.00', { paypal_id: 'CAP1' })
    expect(awaitingWebhook(cap, [cap])).toBe(true)
    expect(awaitingWebhook(cap, [cap, ev('captured', '5.00', { paypal_id: 'CAP1', webhook_event: 'PAYMENT.CAPTURE.COMPLETED' })])).toBe(false)
    // an order is proven by the authorization that followed it
    const order = ev('order_created', '5.00', { paypal_id: 'ORD1' })
    expect(awaitingWebhook(order, [order])).toBe(true)
    expect(awaitingWebhook(order, [order, ev('authorized', '5.00', { paypal_id: 'AUTH1' })])).toBe(false)
    const dispute = ev('dispute_opened', null)
    expect(awaitingWebhook(dispute, [dispute])).toBe(false)
  })
})

describe('moneyLine', () => {
  it('reads cents from the escrow amounts', () => {
    const m = (value: string) => ({ value, currency: 'USD' as const })
    expect(moneyLine({ authorized: m('30.00'), captured: m('24.00'), voided: m('6.00'), refunded: m('0.00'), paid_out: m('20.40') })).toEqual({ authorized: 3000, captured: 2400, voided: 600, refunded: 0, paidOut: 2040 })
  })
})
