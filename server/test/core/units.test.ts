// Pure pieces: money math and rounding, fees, the state table, contract hashing, the room's hash
// chain, fulfilment, sealing and webhook parsing.
import { JobState, type CheckResult, type Contract, type Job, type Message } from '@rentabot/shared'
import { describe, expect, it } from 'vitest'
import { capturable, commission, DEFAULT_FEES, estimatedCaptureFee, mediationFeeByFaults, mediationFeeSplit, pctHalfUp, previewSettlement, refundKeptFee, sellerNet, settlementIncrement } from '../../src/core/fees.ts'
import { computeFulfilment } from '../../src/core/fulfilment.ts'
import { canTransition, check, nextActions, RULES, TRANSITIONS, type MachineView } from '../../src/core/machine.ts'
import { chainValid, messageHash } from '../../src/core/room.ts'
import { keyFrom, seal, unseal } from '../../src/core/secrets.ts'
import { canonicalJson, durationMs, hashCanonical, toAmount, toCents } from '../../src/core/util.ts'
import { parseWebhook } from '../../src/rails/webhook.ts'

describe('money', () => {
  it('converts amounts exactly, without float drift', () => {
    expect(toCents('0.10')).toBe(10)
    expect(toCents('46.5')).toBe(4650)
    expect(toCents('1234567.89')).toBe(123456789)
    expect(toAmount(4650)).toBe('46.50')
    expect(toAmount(5)).toBe('0.05')
    expect(() => toCents('1.234')).toThrow()
    expect(() => toAmount(1.5)).toThrow()
    // 0.1 + 0.2 never appears: 3 × 10¢ is 30¢
    expect(toAmount(3 * toCents('0.10'))).toBe('0.30')
  })

  it('rounds percentages half-up in integer math', () => {
    expect(pctHalfUp(4650, 1500)).toBe(698) // 697.5 → 698
    expect(pctHalfUp(4649, 1500)).toBe(697) // 697.35 → 697
    expect(pctHalfUp(1, 5000)).toBe(1) // 0.5 → 1
    expect(pctHalfUp(0, 1500)).toBe(0)
    expect(() => pctHalfUp(1.5, 1500)).toThrow()
  })

  it('matches the platform economics table in docs/ESCROW_PAYPAL.md', () => {
    const rows: [number, number, number, number, number][] = [
      // captured, commission, paypal capture, seller gets, platform net
      [900, 300, 80, 600, 195],
      [4650, 698, 211, 3952, 462],
      [10000, 1500, 398, 8500, 1077],
      [50000, 7500, 1794, 42500, 5681],
    ]
    for (const [cap, com, ppc, seller, net] of rows) {
      const p = previewSettlement(cap)
      expect(p).toMatchObject({ commission: com, est_paypal_capture_fee: ppc, seller_payout: seller, est_paypal_payout_fee: 25, est_platform_net: net })
    }
  })

  it('commission: floor, below-floor jobs pay the percentage, never above the gross, non-decreasing', () => {
    expect(commission(300)).toBe(300)
    expect(commission(299)).toBe(45) // below the $3 floor: 15%
    expect(commission(2000)).toBe(300) // 15% = $3.00
    expect(commission(2001)).toBe(300)
    expect(commission(2004)).toBe(301)
    expect(commission(0)).toBe(0)
    let prev = 0
    for (let c = 0; c <= 5000; c++) {
      const x = commission(c)
      expect(x).toBeGreaterThanOrEqual(prev)
      expect(x).toBeLessThanOrEqual(c)
      prev = x
    }
    expect(estimatedCaptureFee(0)).toBe(0)
    expect(estimatedCaptureFee(100, DEFAULT_FEES)).toBe(52) // PayPal's own sample: $1.00 capture → $0.52
  })

  it('commission(C, n): every settlement after the first adds $1.00 to the floor; never above the gross', () => {
    expect(commission(1200, DEFAULT_FEES, 1)).toBe(300)
    expect(commission(1200, DEFAULT_FEES, 2)).toBe(400)
    expect(commission(1200, DEFAULT_FEES, 3)).toBe(500)
    expect(commission(4000, DEFAULT_FEES, 2)).toBe(600) // 15% = $6.00 beats the $4.00 floor
    expect(commission(450, DEFAULT_FEES, 3)).toBe(450) // capped at the gross
    expect(commission(299, DEFAULT_FEES, 2)).toBe(45) // legacy below-floor job: percentage only
    expect(sellerNet(1500, 0, DEFAULT_FEES, 2)).toEqual({ commission: 400, seller_fee: 0, net: 1100 })
  })

  it('R3 tail bound: with every capture at or above the $5.00 minimum, a later settlement takes 0 ≤ commission ≤ the tail', () => {
    // Over prior, tail in [$5.00, $60.00] (steps of 7¢) and n = 2..4.
    const bad: string[] = []
    for (let prior = 500; prior <= 6000; prior += 7)
      for (let tail = 500; tail <= 6000; tail += 7)
        for (let n = 2; n <= 4; n++) {
          const inc = settlementIncrement(prior, tail, n)
          if (inc < 0 || inc > tail) bad.push(`${prior}+${tail} n=${n}: ${inc}`)
        }
    expect(bad).toEqual([])
    // platform net ≥ $1.00 for two $5.00 captures: commission $4.00 − 2 × ($0.17 + $0.49) − 2 × $0.25
    expect(commission(1000, DEFAULT_FEES, 2) - 2 * estimatedCaptureFee(500) - 2 * DEFAULT_FEES.paypal_payout_cents).toBeGreaterThanOrEqual(100)
  })

  it('no capture below the minimum settlement; a previewed sub-minimum settlement captures nothing', () => {
    expect(capturable(0)).toBe(true)
    expect(capturable(499)).toBe(false)
    expect(capturable(500)).toBe(true)
    expect(previewSettlement(450)).toMatchObject({ captured: 0, commission: 0, est_paypal_capture_fee: 0, est_paypal_payout_fee: 0, est_platform_net: 0 })
    // every settlement the platform does make nets at least $1.00 after estimated PayPal fees
    let worst = Infinity
    for (let c = 500; c <= 100_000; c++) worst = Math.min(worst, previewSettlement(c).est_platform_net)
    expect(worst).toBeGreaterThanOrEqual(100)
  })

  it('capture-and-hold refunds keep the PayPal fee PayPal does not return', () => {
    expect(refundKeptFee(5400, 600)).toBe(188) // 3.49% of the refunded $54.00 (the seller's commission carries the fixed fee)
    expect(refundKeptFee(6000, 0)).toBe(209 + 49 + 100) // nothing earned: also the $0.49 fixed fee and the $1.00 extra-settlement fee
    expect(refundKeptFee(100, 0)).toBe(100) // never more than the refund
    expect(refundKeptFee(0, 0)).toBe(0)
    // platform net with the kept fee: commission + kept − PayPal's capture fee on the whole capture − payout ≥ $1.00
    for (let C = 500; C <= 50_000; C += 37)
      for (const G of [0, 500, Math.floor(C / 3), C - 500])
        if (G === 0 || (G >= 500 && C - G >= 0)) {
          const net = commission(G) + refundKeptFee(C - G, G) - estimatedCaptureFee(C) - (G > 0 ? 25 : 0)
          expect(net).toBeGreaterThanOrEqual(99) // $1.00, give or take the one-cent rounding of splitting the percentage
        }
  })

  it('seller net never goes negative and mediation fees split by fault', () => {
    expect(sellerNet(2250, 100)).toEqual({ commission: 338, seller_fee: 100, net: 1812 })
    expect(sellerNet(300, 100)).toEqual({ commission: 300, seller_fee: 0, net: 0 })
    expect(mediationFeeSplit(100, true, false)).toEqual({ buyer: 100, seller: 0 })
    expect(mediationFeeSplit(100, false, true)).toEqual({ buyer: 0, seller: 100 })
    expect(mediationFeeSplit(101, true, true)).toEqual({ buyer: 51, seller: 50 })
  })

  it('splits the mediation fee by fault counts (what a recommended ruling uses)', () => {
    expect(mediationFeeByFaults(100, 0, 0)).toEqual({ buyer: 50, seller: 50 })
    expect(mediationFeeByFaults(101, 0, 0)).toEqual({ buyer: 51, seller: 50 }) // odd cent to the buyer
    expect(mediationFeeByFaults(100, 1, 0)).toEqual({ buyer: 0, seller: 100 })
    expect(mediationFeeByFaults(100, 0, 2)).toEqual({ buyer: 100, seller: 0 })
    expect(mediationFeeByFaults(100, 1, 3)).toEqual({ buyer: 75, seller: 25 })
    const f = mediationFeeByFaults(100, 2, 1)
    expect(f.buyer + f.seller).toBe(100) // always adds up
  })

  it('parses ISO durations', () => {
    expect(durationMs('PT48H')).toBe(48 * 3600_000)
    expect(durationMs('P14D')).toBe(14 * 86_400_000)
    expect(durationMs('P1DT2H30M')).toBe((26 * 60 + 30) * 60_000)
    expect(durationMs('PT0H')).toBe(0)
  })
})

describe('contract hash', () => {
  it('is stable under key order and drops undefined', () => {
    const a = { spec: { goal: 'x', deliverables: [{ id: 'D1', quantity: 2 }] }, fees: { platform_bps: 1500, mediation_flat: '1.00' }, extra: undefined }
    const b = { fees: { mediation_flat: '1.00', platform_bps: 1500 }, spec: { deliverables: [{ quantity: 2, id: 'D1' }], goal: 'x' } }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(hashCanonical(a)).toBe(hashCanonical(b))
    expect(hashCanonical(a)).toMatch(/^sha256:[a-f0-9]{64}$/)
    // a known vector, so a change in canonicalization never goes unnoticed
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}')
    expect(hashCanonical({ a: 1 })).toBe('sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
    expect(hashCanonical({ ...b, spec: { ...b.spec, goal: 'y' } })).not.toBe(hashCanonical(b))
  })
})

describe('room hash chain', () => {
  const msg = (seq: number, prev: string | null, text: string): Message => {
    const draft = { id: `msg_test${seq}aaaaaa`, job_id: 'job_testaaaaaa', seq, from: { kind: 'platform' as const, id: 'platform', role: 'platform' as const }, type: 'system' as const, text, body: {}, artifact_ids: [], prev_hash: prev, ts: '2026-11-02T10:00:00.000Z' }
    return { ...draft, hash: messageHash(draft) }
  }
  const chain = () => {
    const m0 = msg(0, null, 'a')
    const m1 = msg(1, m0.hash, 'b')
    const m2 = msg(2, m1.hash, 'c')
    return [m0, m1, m2]
  }
  it('validates an intact chain and detects edits, deletions and reordering', () => {
    expect(chainValid(chain())).toBe(true)
    expect(chainValid([])).toBe(true)
    const edited = chain()
    edited[1] = { ...edited[1], text: 'B' }
    expect(chainValid(edited)).toBe(false)
    const deleted = chain()
    deleted.splice(1, 1)
    expect(chainValid(deleted)).toBe(false)
    const rehashed = chain()
    rehashed[1] = { ...rehashed[1], text: 'B', hash: messageHash({ ...rehashed[1], text: 'B' }) } // re-hashing one message breaks the next link
    expect(chainValid(rehashed)).toBe(false)
  })

  it('accepts a message the platform marked redacted, but only in its place and only with its original hash', () => {
    const redacted = chain()
    redacted[1] = { ...redacted[1], text: '[removed for privacy]', redacted: { at: '2026-11-03T10:00:00.000Z', reason: 'Personal data removed.' } }
    expect(chainValid(redacted)).toBe(true)
    const rehashed = chain()
    const body = { ...rehashed[1], text: '[removed for privacy]', redacted: { at: '2026-11-03T10:00:00.000Z', reason: 'x' } }
    rehashed[1] = { ...body, hash: messageHash(body) } // a new hash still breaks the next link
    expect(chainValid(rehashed)).toBe(false)
    const moved = chain()
    moved[1] = { ...moved[1], prev_hash: moved[2].hash, redacted: { at: '2026-11-03T10:00:00.000Z', reason: 'x' } } // the marker never excuses a broken link
    expect(chainValid(moved)).toBe(false)
  })
})

describe('state table', () => {
  const view = (state: Job['state'], over: Partial<MachineView> = {}): MachineView =>
    ({
      job: { id: 'job_testaaaaaa', state, contract_hash: 'sha256:' + 'a'.repeat(64), contract: null, deadlines: { fund_by: null, deliver_by: null, review_until: null, cure_until: null, appeal_until: null, verify_until: null } } as unknown as Job,
      now: 0,
      has_quote: true,
      has_requirements: true,
      accepted_roles: [],
      open_questions: [],
      missing_inputs: [],
      missing_access: [],
      has_delivery: true,
      delivery_accepted: false,
      deliver_by_passed: false,
      ruling_accepted_by: [],
      mediator_questions: [],
      mediation: null,
      proposals: [],
      agreement_active: false,
      secret_ids: [],
      cursor: 0,
      ...over,
    }) as MachineView

  it('covers every state; terminal states have no exits', () => {
    for (const s of JobState.options) expect(TRANSITIONS[s]).toBeDefined()
    for (const s of ['SETTLED', 'CANCELLED', 'EXPIRED'] as const) expect(TRANSITIONS[s]).toEqual([])
    expect(canTransition('NEGOTIATING', 'IN_PROGRESS')).toBe(false)
    expect(canTransition('DELIVERED', 'SETTLED')).toBe(true)
    expect(canTransition('SETTLED', 'DELIVERED')).toBe(false)
    // an agreement in mediation settles, reopens work or waits; no agreement → a ruling or a human
    for (const to of ['SETTLED', 'CURE', 'DELIVERED', 'RULED', 'APPEALED'] as const) expect(canTransition('DISPUTED', to)).toBe(true)
    expect(canTransition('DISPUTED', 'IN_PROGRESS')).toBe(false)
  })

  it('every rule names a real op state and role', () => {
    for (const r of RULES) {
      if (Array.isArray(r.states)) for (const s of r.states) expect(JobState.options).toContain(s)
      expect(r.roles.length).toBeGreaterThan(0)
    }
  })

  const OPEN_PROPOSAL_ANSWERED_BY_BUYER = { id: 'prp_aaaaaaaaaaaa', round: 1, status: 'open', kind: 'split', by: 'mediator', answered: ['buyer' as const], summary: 'release $46.50 to the seller, refund $13.50 to the buyer' }
  const cases: [Parameters<typeof check>[0], Job['state'], 'buyer' | 'seller' | 'arbiter', string, Partial<MachineView>?][] = [
    ['fund_job', 'AGREED', 'buyer', 'ok'],
    ['fund_job', 'AGREED', 'seller', 'forbidden'],
    ['fund_job', 'NEGOTIATING', 'buyer', 'invalid_state'],
    ['submit_delivery', 'IN_PROGRESS', 'seller', 'ok'],
    ['submit_delivery', 'IN_PROGRESS', 'buyer', 'forbidden'],
    ['submit_delivery', 'DELIVERED', 'seller', 'invalid_state'],
    ['submit_delivery', 'CURE', 'seller', 'ok'],
    ['review_delivery', 'DELIVERED', 'buyer', 'ok'],
    ['review_delivery', 'DELIVERED', 'buyer', 'invalid_state', { delivery_accepted: true }],
    ['accept_contract', 'NEGOTIATING', 'buyer', 'invalid_state', { has_quote: false }],
    ['accept_contract', 'NEGOTIATING', 'seller', 'ok'],
    ['decline_job', 'IN_PROGRESS', 'buyer', 'invalid_state'],
    ['decline_job', 'IN_PROGRESS', 'buyer', 'ok', { deliver_by_passed: true }],
    ['decline_job', 'IN_PROGRESS', 'seller', 'ok'],
    ['decline_job', 'DELIVERED', 'buyer', 'invalid_state'],
    ['open_dispute', 'DELIVERED', 'seller', 'ok'],
    ['open_dispute', 'IN_PROGRESS', 'buyer', 'invalid_state'],
    ['open_dispute', 'BLOCKED', 'seller', 'ok'],
    ['open_dispute', 'DELIVERED', 'seller', 'invalid_state', { agreement_active: true }],
    ['respond_to_proposal', 'DISPUTED', 'buyer', 'invalid_state'], // no mediation yet
    ['respond_to_proposal', 'DISPUTED', 'buyer', 'invalid_state', { mediation: { status: 'proposing', round: 0, deadline: null } }],
    ['respond_to_proposal', 'DISPUTED', 'buyer', 'invalid_state', { mediation: { status: 'negotiating', round: 1, deadline: null }, proposals: [OPEN_PROPOSAL_ANSWERED_BY_BUYER] }],
    ['respond_to_proposal', 'DISPUTED', 'seller', 'ok', { mediation: { status: 'negotiating', round: 1, deadline: null }, proposals: [OPEN_PROPOSAL_ANSWERED_BY_BUYER] }],
    ['respond_to_proposal', 'DISPUTED', 'buyer', 'invalid_state', { mediation: { status: 'no_agreement', round: 3, deadline: null }, proposals: [] }],
    ['respond_to_proposal', 'DELIVERED', 'buyer', 'invalid_state'],
    ['respond_to_proposal', 'DISPUTED', 'arbiter', 'forbidden'],
    ['get_mediation', 'DISPUTED', 'arbiter', 'ok'],
    ['get_mediation', 'SETTLED', 'buyer', 'ok'],
    ['answer_mediator', 'DISPUTED', 'buyer', 'invalid_state'],
    ['answer_mediator', 'DISPUTED', 'buyer', 'ok', { mediator_questions: [{ id: 'R1q', to: 'buyer' }] }],
    ['accept_ruling', 'RULED', 'seller', 'invalid_state', { ruling_accepted_by: ['seller'] }],
    ['appeal_ruling', 'RULED', 'buyer', 'ok'],
    ['arbiter_decide', 'APPEALED', 'arbiter', 'ok'],
    ['arbiter_decide', 'APPEALED', 'buyer', 'forbidden'],
    ['get_job', 'SETTLED', 'arbiter', 'ok'],
    ['get_secret', 'AGREED', 'seller', 'invalid_state', { secret_ids: ['sec_x'] }],
    ['get_secret', 'IN_PROGRESS', 'seller', 'ok', { secret_ids: ['sec_x'] }],
    ['send_message', 'SETTLED', 'buyer', 'invalid_state'],
  ]
  it.each(cases)('%s in %s as %s → %s', (op, state, role, want, over) => {
    const v = check(op, view(state, over), role)
    expect(v.ok ? 'ok' : v.code).toBe(want)
  })

  it('next_actions only lists ops the table allows, with known args', () => {
    const v = view('AGREED', { job: { ...view('AGREED').job, contract: { version: 2, quote: { total_max: { value: '60.00' } } } as unknown as Contract } })
    const buyer = nextActions(v, 'buyer')
    expect(buyer.map((a) => a.op)).toEqual(['fund_job'])
    expect(buyer[0].args).toEqual({ job_id: 'job_testaaaaaa', idempotency_key: 'fund-job_testaaaaaa-v2' })
    for (const s of JobState.options)
      for (const role of ['buyer', 'seller', 'arbiter'] as const)
        for (const a of nextActions(view(s), role)) if (a.op !== 'wait_for_events') expect(check(a.op as never, view(s), role).ok).toBe(true)
    expect(nextActions(view('SETTLED'), 'buyer')).toEqual([])
    expect(nextActions(view('NEGOTIATING'), 'seller').map((a) => a.op)).toEqual(['accept_contract'])
  })

  it('next_actions lists one respond_to_proposal per proposal the caller has not answered, with its id', () => {
    const open = (id: string, answered: ('buyer' | 'seller')[]) => ({ ...OPEN_PROPOSAL_ANSWERED_BY_BUYER, id, answered })
    const v = view('DISPUTED', {
      mediation: { status: 'negotiating', round: 1, deadline: '2026-11-02T12:00:00.000Z' },
      proposals: [open('prp_aaaaaaaaaaaa', ['buyer']), open('prp_bbbbbbbbbbbb', []), { ...open('prp_cccccccccccc', []), status: 'superseded' }],
    })
    const seller = nextActions(v, 'seller').filter((a) => a.op === 'respond_to_proposal')
    expect(seller.map((a) => a.args.proposal_id)).toEqual(['prp_aaaaaaaaaaaa', 'prp_bbbbbbbbbbbb'])
    expect(nextActions(v, 'buyer').filter((a) => a.op === 'respond_to_proposal').map((a) => a.args.proposal_id)).toEqual(['prp_bbbbbbbbbbbb'])
    expect(seller[0].args.job_id).toBe('job_testaaaaaa')
    // nothing to answer: the caller waits
    const answered = view('DISPUTED', { mediation: { status: 'negotiating', round: 1, deadline: null }, proposals: [open('prp_aaaaaaaaaaaa', ['buyer', 'seller'])] })
    expect(nextActions(answered, 'buyer').map((a) => a.op)).toEqual(['wait_for_events'])
    // while the mediator is still assessing, the parties can add evidence
    expect(nextActions(view('DISPUTED', { mediation: { status: 'investigating', round: 0, deadline: null } }), 'buyer').map((a) => a.op)).toEqual(['add_statement'])
  })
})

describe('fulfilment', () => {
  const contract = (model: 'per_unit' | 'fixed', qty: number, price: string, max: string) =>
    ({
      spec: { deliverables: [{ id: 'D1', quantity: qty, acceptance: [{ check: 'u', params: {} }, { check: 'lvl', params: {} }] }] },
      quote: { lines: [{ deliverable_id: 'D1', model, unit_price: price, quantity: qty, max_total: max }], total_max: { value: max, currency: 'USD' } },
    }) as unknown as Contract
  const r = (unit: string | null, check: string, status: CheckResult['status'], attempt = 1): CheckResult => ({ id: 'chk_xxxxxx', job_id: 'job_xxxxxx', deliverable_id: 'D1', unit_ref: unit, check, status, detail: '', evidence_id: null, attempt, ran_at: '2026-11-02T10:00:00.000Z' })
  const delivery = (n: number) => ({ deliverables: [{ deliverable_id: 'D1', units: Array.from({ length: n }, (_, i) => ({ ref: `u${i}`, artifact_ids: [], meta: {} })), note: '' }], note: '' })
  const opts = { perUnitChecks: (id: string) => id === 'u' }

  it('per-unit: passed × price, capped; errors fail; pending is held; extra units ignored', () => {
    const res = [r(null, 'lvl', 'pass'), r('u0', 'u', 'pass'), r('u1', 'u', 'error'), r('u2', 'u', 'pending'), r('u3', 'u', 'fail'), r('u3', 'u', 'pass', 2), r('u4', 'u', 'pass')]
    const f = computeFulfilment(contract('per_unit', 4, '1.50', '6.00'), delivery(5), res, opts)
    expect(f.fulfilment[0]).toMatchObject({ passed_units: 2, failed_units: 1, pending_units: 1, earned: { value: '3.00' } })
    expect(f.held_for_pending_cents).toBe(150)
    const capped = computeFulfilment(contract('per_unit', 4, '1.50', '5.00'), delivery(4), [r(null, 'lvl', 'pass'), ...['u0', 'u1', 'u2', 'u3'].map((u) => r(u, 'u', 'pass'))], opts)
    expect(capped.earned_cents).toBe(500)
  })

  it('a failing deliverable-level check fails every unit; fixed lines are all-or-nothing', () => {
    const lvlFail = computeFulfilment(contract('per_unit', 2, '1.00', '2.00'), delivery(2), [r(null, 'lvl', 'fail'), r('u0', 'u', 'pass'), r('u1', 'u', 'pass')], opts)
    expect(lvlFail.earned_cents).toBe(0)
    const fixedAll = computeFulfilment(contract('fixed', 2, '9.00', '9.00'), delivery(2), [r(null, 'lvl', 'pass'), r('u0', 'u', 'pass'), r('u1', 'u', 'pass')], opts)
    expect(fixedAll.earned_cents).toBe(900)
    const fixedOne = computeFulfilment(contract('fixed', 2, '9.00', '9.00'), delivery(2), [r(null, 'lvl', 'pass'), r('u0', 'u', 'pass'), r('u1', 'u', 'fail')], opts)
    expect(fixedOne.earned_cents).toBe(0)
    const fixedPending = computeFulfilment(contract('fixed', 2, '9.00', '9.00'), delivery(2), [r(null, 'lvl', 'pass'), r('u0', 'u', 'pass'), r('u1', 'u', 'pending')], opts)
    expect(fixedPending).toMatchObject({ earned_cents: 0, held_for_pending_cents: 900 })
    const none = computeFulfilment(contract('fixed', 1, '9.00', '9.00'), null, [], opts)
    expect(none.earned_cents).toBe(0)
  })
})

describe('sealing', () => {
  it('round-trips, binds the job/secret id, rejects tampering', () => {
    const key = keyFrom('b'.repeat(64))
    const s = seal(key, 'job_a:sec_a', 'hunter2')
    expect(s).not.toContain('hunter2')
    expect(unseal(key, 'job_a:sec_a', s)).toBe('hunter2')
    expect(() => unseal(key, 'job_b:sec_a', s)).toThrow()
    expect(() => unseal(keyFrom('other passphrase'), 'job_a:sec_a', s)).toThrow()
    const parts = s.split('.')
    parts[3] = Buffer.from('tampered').toString('base64')
    expect(() => unseal(key, 'job_a:sec_a', parts.join('.'))).toThrow()
  })
})

describe('webhook parsing', () => {
  it('normalizes PayPal capture, authorization, payout and order events', () => {
    const cap = parseWebhook(
      JSON.stringify({
        id: 'WH-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource_type: 'capture',
        resource: { id: 'CAP', status: 'COMPLETED', amount: { value: '46.50' }, final_capture: true, seller_receivable_breakdown: { paypal_fee: { value: '2.11' } }, supplementary_data: { related_ids: { order_id: 'ORD', authorization_id: 'AUTH' } } },
      }),
    )
    expect(cap).toMatchObject({ capture_id: 'CAP', authorization_id: 'AUTH', order_id: 'ORD', amount_cents: 4650, final_capture: true, fee_cents: 211 })
    const pay = parseWebhook(JSON.stringify({ id: 'WH-2', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_item_id: 'IT', payout_batch_id: 'B', transaction_status: 'SUCCESS', payout_item_fee: { value: '0.25' }, payout_item: { sender_item_id: 'job_x-p1', amount: { value: '39.52' } } } }))
    expect(pay).toMatchObject({ payout_item_id: 'IT', sender_item_id: 'job_x-p1', amount_cents: 3952, fee_cents: 25, status: 'SUCCESS' })
    const ord = parseWebhook(JSON.stringify({ id: 'WH-3', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORD', purchase_units: [{ custom_id: 'sha256:x', amount: { value: '60.00' } }] } }))
    expect(ord).toMatchObject({ order_id: 'ORD', custom_id: 'sha256:x', amount_cents: 6000 })
    expect(parseWebhook('not json')).toBeNull()
    expect(parseWebhook('{"id":"x"}')).toBeNull()
  })
})
