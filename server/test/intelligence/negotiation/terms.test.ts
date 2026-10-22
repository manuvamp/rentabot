import { describe, expect, it } from 'vitest'
import { cents } from '@rentabot/shared'
import { commissionCents, heldCents, normalizeTerms, previewSettlement, releaseRange, snapToMinimum, validateTerms, type TermsCtx } from '../../../src/intelligence/negotiation/terms.ts'
import { demoContract } from '../fixture.ts'
import { NOW, int, rng } from './helpers.ts'

const ctx = (o: Partial<TermsCtx> = {}): TermsCtx => ({
  authorized_cents: 6000,
  already_captured_cents: 0,
  verified_cents: 4650,
  fair_range: [4650, 5250],
  now: NOW,
  contract: demoContract(),
  default_redo_hours: 48,
  ...o,
})
const acceptance = demoContract().spec.deliverables[0]!.acceptance

describe('terms: money guard', () => {
  it('commission = max($3.00, 15%), capped at the capture', () => {
    expect(commissionCents(4650)).toBe(698) // ESCROW_PAYPAL.md table: $46.50 -> $6.98
    expect(commissionCents(900)).toBe(300)
    expect(commissionCents(10000)).toBe(1500)
    expect(commissionCents(200)).toBe(200)
    expect(commissionCents(0)).toBe(0)
    const p = previewSettlement(normalizeTerms({ release_now: '46.50' }, ctx()).terms, ctx())
    expect(p).toMatchObject({ capture_now: '46.50', void_now: '13.50', held: '0.00', platform_commission: '6.98', seller_payout_now: '39.52' })
  })

  it('minimum settlement: seller totals strictly between 0 and $5.00 snap to $5.00 when the fair range reaches it, else to 0', () => {
    const reach = ctx({ authorized_cents: 1000, verified_cents: 300, fair_range: [300, 800], min_settlement_cents: 500 })
    expect(releaseRange(reach)).toEqual([500, 800]) // the fair low end is raised to the minimum
    const up = normalizeTerms({ release_now: '3.00' }, reach)
    expect(up.terms).toMatchObject({ release_now: '5.00', refund_now: '5.00' })
    expect(up.repairs.join(' ')).toMatch(/minimum settlement/)
    const below = ctx({ authorized_cents: 1000, verified_cents: 200, fair_range: [200, 450], min_settlement_cents: 500 })
    expect(releaseRange(below)).toEqual([0, 0]) // every fair total is unexecutable: nothing is paid
    expect(normalizeTerms({ release_now: '4.00' }, below).terms).toMatchObject({ release_now: '0.00', refund_now: '10.00' })
    expect(snapToMinimum(0, below)).toBe(0)
    // after an earlier capture of at least the minimum the rule does not bind
    expect(snapToMinimum(100, ctx({ authorized_cents: 2000, already_captured_cents: 600, fair_range: [600, 1500], min_settlement_cents: 500 }))).toBe(100)
    // previews: a plain release below the minimum captures nothing; a redo only secures its release
    expect(previewSettlement(normalizeTerms({ release_now: '4.00' }, ctx({ authorized_cents: 1000 })).terms, ctx({ authorized_cents: 1000 }), { commission_bps: 1500, commission_floor_cents: 300, min_settlement_cents: 500 })).toMatchObject({ capture_now: '0.00', void_now: '10.00', platform_commission: '0.00' })
    const redo = normalizeTerms({ release_now: '46.50', redo: { deliverable_id: 'D1', units: ['dir-32'], amount_on_success: '13.50', acceptance } }, ctx()).terms
    expect(previewSettlement(redo, ctx())).toMatchObject({ capture_now: '0.00', secured: '46.50', platform_commission: '6.98', seller_payout_now: '39.52', held_commission: '2.02' })
  })

  it('repairs sums, deadlines, acceptance and flags fair range', () => {
    const { terms, repairs } = normalizeTerms(
      { release_now: '46.50', refund_now: '1.00', redo: { deliverable_id: 'D9', units: ['D1:dir-32', 'dir-32'], deadline: '2027-06-01T00:00:00Z', acceptance: [{ check: 'made_up', params: {} }] } },
      ctx(),
    )
    expect(terms.redo).toMatchObject({ deliverable_id: 'D1', units: ['dir-32'], amount_on_success: '12.50' })
    expect(terms.redo!.acceptance.map((a) => a.check)).toEqual(['url_live', 'page_mentions'])
    expect(new Date(terms.redo!.deadline).getTime()).toBe(NOW.getTime() + 48 * 3600_000)
    expect(repairs.length).toBeGreaterThan(2)
    expect(validateTerms(terms, ctx()).ok).toBe(true)
    expect(validateTerms(normalizeTerms({ release_now: '60.00' }, ctx()).terms, ctx()).flags).toContain('outside_fair_range_high')
    expect(validateTerms(normalizeTerms({ release_now: '10.00' }, ctx()).terms, ctx()).flags).toContain('outside_fair_range_low')
    expect(validateTerms(normalizeTerms({ release_now: '50.00', cancel: true }, ctx()).terms, ctx()).flags).toContain('cancel_above_verified')
  })

  it('strict validation rejects broken terms', () => {
    const base = { release_now: '46.50', refund_now: '13.50', redo: null, wait_until: null, cancel: false, note: '' }
    expect(validateTerms(base, ctx()).ok).toBe(true)
    expect(validateTerms({ ...base, refund_now: '20.00' }, ctx()).ok).toBe(false)
    expect(validateTerms({ ...base, release_now: '-1.00' }, ctx()).ok).toBe(false)
    const redo = { deliverable_id: 'D1', units: ['dir-32'], instruction: '', deadline: '2026-10-27T00:00:00Z', amount_on_success: '13.50', acceptance }
    expect(validateTerms({ ...base, refund_now: '0.00', redo }, ctx()).errors.join()).toMatch(/deadline/)
    expect(validateTerms({ ...base, refund_now: '0.00', redo: { ...redo, deadline: '2026-10-30T00:00:00Z', acceptance: [{ check: 'other', params: {} }] } }, ctx()).errors.join()).toMatch(/not in the contract/)
  })

  it('property: release + refund + held == authorized - captured for any loose input', () => {
    const r = rng(7)
    for (let i = 0; i < 2000; i++) {
      const auth = int(r, 0, 500_000)
      const cap = int(r, 0, auth)
      const ver = int(r, 0, auth)
      const hi = int(r, ver, auth)
      const c = ctx({ authorized_cents: auth, already_captured_cents: cap, verified_cents: ver, fair_range: [ver, hi], pending_cents: int(r, 0, auth) })
      const maybe = () => (r() < 0.3 ? undefined : r() < 0.1 ? 'junk' : (int(r, 0, auth * 1.2) / 100).toFixed(2))
      const kind = int(r, 0, 3)
      const { terms } = normalizeTerms(
        {
          release_now: maybe(),
          refund_now: maybe(),
          redo: kind === 1 ? { units: ['a', 'b'], amount_on_success: maybe(), deadline: r() < 0.5 ? '2026-10-29T00:00:00Z' : 'nope' } : null,
          wait_until: kind === 2 ? '2026-10-30T00:00:00Z' : null,
          cancel: kind === 3,
        },
        c,
      )
      const sum = cents(terms.release_now) + cents(terms.refund_now) + heldCents(terms, c)
      expect(sum).toBe(auth - cap)
      expect(validateTerms(terms, c).ok).toBe(true)
      const pv = previewSettlement(terms, c)
      expect(cents(pv.seller_payout_now) + cents(pv.platform_commission)).toBe(cents(pv.secured ?? pv.capture_now))
      expect(cents(pv.seller_payout_now)).toBeGreaterThanOrEqual(0)
    }
  })
})
