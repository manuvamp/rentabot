// The AG Studio dashboard's data: get_platform_analytics. Live jobs must agree with the ledger to the cent, the simulated
// history must obey the fee rules it is built from, and only the right people may read it.
import { afterEach, describe, expect, it } from 'vitest'
import { canViewPlatformAnalytics } from '../../src/core/analytics.ts'
import { commission, DEFAULT_FEES } from '../../src/core/fees.ts'
import { deliver, fundedJob, harness, units, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})

type Row = Record<string, string | number | boolean | null>
const cents = (x: unknown) => Math.round(Number(x) * 100)

describe('get_platform_analytics', () => {
  it('a live job agrees with the platform ledger to the cent and carries the estimates', async () => {
    h = await harness()
    const job_id = await fundedJob(h, { quantity: 40 })
    await deliver(h, job_id, units(40, (i) => (i >= 31 ? { page_mentions: 'fail' } : {})))
    await h.call('review_delivery', h.buyer, { job_id, decision: 'accept' })
    await h.settle()
    const arb = await h.core.auth.demoSignIn('arbiter')
    const a = await h.call('get_platform_analytics', arb.principal, { include_simulated: true })
    const ledger = await h.call('get_platform_ledger', arb.principal, { limit: 10 })
    expect(a.simulated_jobs).toBe(0) // not demo mode: no simulated history
    expect(a.live_jobs).toBe(1)
    const row = a.tables.jobs[0] as Row
    const line = ledger.jobs[0]!
    expect(row.job_id).toBe(job_id)
    expect(row.captured).toBe(Number(line.captured))
    expect(row.commission).toBe(Number(line.commission))
    expect(row.paypal_capture_fee).toBe(Number(line.paypal_capture_fees))
    expect(row.paypal_payout_fee).toBe(Number(line.paypal_payout_fees))
    expect(row.platform_net).toBe(Number(line.net))
    expect(row.simulated).toBe(false)
    expect(row.units_expected).toBe(40)
    expect(row.units_passed).toBe(31)
    // simulated rail: actual fees equal the estimate (3.49% + $0.49 on $46.50, $0.25 payout)
    expect(row.fee_variance).toBe(0)
    expect(a.tables.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['authorized', 'captured', 'voided', 'paid out']))
    expect((a.tables.checks as Row[]).some((c) => c.status === 'fail' && c.check === 'page_mentions')).toBe(true)
    const bot = (a.tables.bots as Row[]).find((b) => b.name === 'Directory Blaster')!
    expect(bot.jobs).toBe(1)
    expect(bot.units_passed).toBe(31)
  })

  it('demo mode adds labelled simulated history that obeys the fee rules, deterministically', async () => {
    h = await harness({ config: { demoMode: true } })
    const arb = await h.core.auth.demoSignIn('arbiter')
    const a = await h.call('get_platform_analytics', arb.principal, { include_simulated: true })
    const b = await h.call('get_platform_analytics', arb.principal, { include_simulated: true })
    expect(a.simulated_jobs).toBeGreaterThan(60)
    expect({ ...a, generated_at: '' }).toEqual({ ...b, generated_at: '' })
    const jobs = a.tables.jobs as Row[]
    expect(jobs.every((j) => j.simulated === true)).toBe(true)
    for (const j of jobs) {
      // money: nothing captured under the minimum, net is exactly commission + mediation + kept fees − PayPal fees
      if (cents(j.captured) > 0) expect(cents(j.captured)).toBeGreaterThanOrEqual(DEFAULT_FEES.min_settlement_cents)
      expect(cents(j.platform_net)).toBe(cents(j.commission) + cents(j.mediation_fees) + cents(j.refund_fees_kept) - cents(j.paypal_fees))
      expect(cents(j.fee_variance)).toBe(cents(j.paypal_fees) - cents(j.paypal_fees_est))
      expect(cents(j.seller_payout)).toBeLessThanOrEqual(cents(j.captured))
      // every authorized dollar is captured, voided, refunded or still held (a capture-and-hold refund is part of the capture)
      expect(cents(j.captured) + cents(j.voided) + cents(j.held_now)).toBeGreaterThanOrEqual(cents(j.authorized) - 0)
      expect(cents(j.commission)).toBeLessThanOrEqual(commission(cents(j.captured), DEFAULT_FEES, 1) + 0)
      if (j.below_minimum_void) {
        expect(cents(j.captured)).toBe(0)
        expect(cents(j.earned_not_captured)).toBeGreaterThan(0)
        expect(cents(j.earned_not_captured)).toBeLessThan(DEFAULT_FEES.min_settlement_cents)
      }
    }
    // the bad week is real: last full calendar week nets less than the average of the five before it
    const day = 86_400_000
    const today = Math.floor(Date.parse(a.generated_at) / day) * day
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * day
    const weekNet = (from: number) => jobs.filter((j) => Date.parse(String(j.date)) >= from && Date.parse(String(j.date)) < from + 7 * day).reduce((s, j) => s + cents(j.platform_net), 0)
    const last = weekNet(monday - 7 * day)
    const before = [2, 3, 4, 5, 6].map((w) => weekNet(monday - w * day * 7))
    expect(last).toBeLessThan(before.reduce((s, x) => s + x, 0) / before.length)
    // disputes, proposals and the funnel are consistent with each other
    const disputes = a.tables.disputes as Row[]
    expect(disputes.length).toBeGreaterThan(5)
    expect((a.tables.funnel as Row[]).filter((f) => f.stage_no === 1)).toHaveLength(disputes.length)
    expect((a.tables.proposals as Row[]).every((p) => disputes.some((d) => d.job_id === p.job_id))).toBe(true)
    // opting out removes it
    const live = await h.call('get_platform_analytics', arb.principal, { include_simulated: false })
    expect(live.simulated_jobs).toBe(0)
    expect(live.tables.jobs).toHaveLength(0)
  })

  it('is for the arbiter (and the demo owner), not for agents or a production owner', async () => {
    h = await harness()
    const owner = await h.core.auth.demoSignIn('owner')
    expect((await h.fails('get_platform_analytics', owner.principal, {})).code).toBe('forbidden') // not demo mode
    expect((await h.fails('get_platform_analytics', h.buyer, {})).code).toBe('forbidden')
    expect(canViewPlatformAnalytics(['owner'], 'owner', true)).toBe(true)
    expect(canViewPlatformAnalytics(['owner'], 'seller', true)).toBe(false) // the seller persona also holds the owner role; the persona is the gate
    expect(canViewPlatformAnalytics(['owner'], 'owner', false)).toBe(false)
    expect(canViewPlatformAnalytics(['arbiter'], 'arbiter', false)).toBe(true)
  })
})
