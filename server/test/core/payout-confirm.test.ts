// The payout_sent ledger event must stop waiting for a webhook once the payout is confirmed, by the webhook or by the reconciler.
// (It is keyed by the payout batch; the confirmation arrives keyed by the item, so it used to keep "awaiting webhook" for ever.)
import { afterEach, describe, expect, it } from 'vitest'
import { deliver, fundedJob, harness, units, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})

const escrowOf = async (job_id: string) => (await h.call('get_escrow', h.buyer, { job_id })).escrow

describe('payout_sent confirmation marker', () => {
  it('is stamped by the payout webhook', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 4 })
    await deliver(h, job_id, units(4))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    const e = await escrowOf(job_id)
    expect(e.paid_out.value).toBe('3.00')
    const sent = e.events.filter((x) => x.kind === 'payout_sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].webhook_event).toBe('PAYMENT.PAYOUTS-ITEM.SUCCEEDED')
    expect(e.events.find((x) => x.kind === 'payout_succeeded')!.webhook_event).toBe('PAYMENT.PAYOUTS-ITEM.SUCCEEDED')
  })

  it('is stamped by the reconciler, and stays unconfirmed until then', async () => {
    h = await harness({ dropWebhooks: true })
    const job_id = await fundedJob(h, { quantity: 4 })
    await deliver(h, job_id, units(4))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    let e = await escrowOf(job_id)
    expect(e.events.find((x) => x.kind === 'payout_sent')).toBeTruthy()
    expect(e.paid_out.value).toBe('0.00') // in flight
    expect(e.events.find((x) => x.kind === 'payout_sent')!.webhook_event).toBeNull()
    h.clock.advance(61_000)
    await h.tick()
    e = await escrowOf(job_id)
    expect(e.paid_out.value).toBe('3.00')
    expect(e.events.find((x) => x.kind === 'payout_succeeded')!.webhook_event).toBe('reconciler')
    expect(e.events.find((x) => x.kind === 'payout_sent')!.webhook_event).toBe('reconciler')
  })
})

describe('list_jobs money', () => {
  it('carries the escrow numbers, with a payout still in flight shown as pending rather than paid', async () => {
    h = await harness({ dropWebhooks: true })
    const job_id = await fundedJob(h, { quantity: 4 })
    const listed = async () => (await h.call('list_jobs', h.buyer, {})).jobs.find((j) => j.id === job_id)!
    expect((await listed()).money).toMatchObject({ authorized: { value: '6.00' }, captured: { value: '0.00' }, paid_out: { value: '0.00' }, payout_pending: { value: '0.00' } })
    await deliver(h, job_id, units(4))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    expect((await listed()).money).toMatchObject({ authorized: { value: '6.00' }, captured: { value: '6.00' }, voided: { value: '0.00' }, paid_out: { value: '0.00' }, payout_pending: { value: '3.00' } })
    h.clock.advance(61_000)
    await h.tick()
    const money = (await listed()).money!
    expect(money).toMatchObject({ captured: { value: '6.00' }, paid_out: { value: '3.00' }, payout_pending: { value: '0.00' } })
    const e = (await h.call('get_escrow', h.buyer, { job_id })).escrow
    expect([money.authorized, money.captured, money.voided, money.refunded, money.paid_out]).toEqual([e.authorized, e.captured, e.voided, e.refunded, e.paid_out])
    // the seller sees the same numbers
    expect((await h.call('list_jobs', h.seller, {})).jobs.find((j) => j.id === job_id)!.money).toEqual(money)
  })
})
