// The money guard. Pure functions; every amount in a proposal goes through here, in integer cents.
//
// Invariant (docs/MEDIATION.md guardrails), with available = authorized − already_captured:
//   release_now + refund_now + held = available            exactly, in cents
//   held = redo.amount_on_success  (redo)
//        | the remainder kept until wait_until (wait)
//        | 0                                    (plain split / cancel)
// Fair range is in "seller total" terms (already captured + release_now); held money for redo/wait is
// earned by later checks, so it is outside the range test.
// Minimum settlement (ctx.min_settlement_cents): nothing below it is ever captured (core/escrow.ts voids it), so a seller total
// strictly between 0 and the minimum is not executable: it snaps up to the minimum when the fair range reaches it, else to 0.
import { amount, cents, type Contract } from '@rentabot/shared'
import { MAX_HOLD_DAYS, ProposalTerms, type Redo, type SettlementPreview } from './types.ts'

/**
 * Platform economics (docs/ESCROW_PAYPAL.md): commission = max(floor, 15% of captured), from the seller's share.
 * The core passes its own policy (settlementFeesFrom(config.fees)) so previews, proposals and rulings use exactly the
 * rule fees.ts applies when it pays out.
 */
export interface SettlementFees {
  commission_bps: number
  commission_floor_cents: number
  /**
   * What a capture below the floor pays. 'capture' (default, the original rule here): the whole capture, so the floor
   * can eat a tiny job. 'pct': only the percentage, which is what core/fees.ts does (a tiny job is never eaten by the floor).
   */
  below_floor?: 'capture' | 'pct'
  /** Added to the floor per settlement after the first (core/fees.ts). */
  extra_settlement_cents?: number
  /** Minimum settlement / job price: seller totals below it are snapped (snapToMinimum). */
  min_settlement_cents?: number
}
export const SETTLEMENT_FEES: SettlementFees = {
  commission_bps: 1500,
  commission_floor_cents: 300,
}
/** The core's FeePolicy (commission_bps, floor_cents) as the negotiator's fee policy, using fees.ts's rule below the floor. */
export const settlementFeesFrom = (p: { commission_bps: number; floor_cents: number; min_settlement_cents?: number; extra_settlement_cents?: number }): SettlementFees => ({
  commission_bps: p.commission_bps,
  commission_floor_cents: p.floor_cents,
  below_floor: 'pct',
  ...(p.extra_settlement_cents !== undefined ? { extra_settlement_cents: p.extra_settlement_cents } : {}),
  ...(p.min_settlement_cents !== undefined ? { min_settlement_cents: p.min_settlement_cents } : {}),
})

export interface TermsCtx {
  authorized_cents: number
  already_captured_cents: number
  /** Checks-verified seller total (incl. already captured). */
  verified_cents: number
  /** Fair seller total [lo, hi] in cents. */
  fair_range: [number, number]
  now: Date | string
  contract: Contract
  /** Value of units still pending verification (default hold for a wait option). */
  pending_cents?: number
  /** Default redo window when a deadline is missing or invalid (hours, default 48). */
  default_redo_hours?: number
  /** Minimum settlement in cents (0 / omitted: no minimum). */
  min_settlement_cents?: number
}

/** Loose terms: what a model drafts or a party sends. Amounts may be missing or malformed. */
export interface TermsInput {
  release_now?: string | number | null
  refund_now?: string | number | null
  redo?: Partial<Omit<Redo, 'amount_on_success'>> & { amount_on_success?: string | number | null } | null
  wait_until?: string | null
  cancel?: boolean
  note?: string
}

export interface Validation {
  ok: boolean
  errors: string[]
  /** Allowed but notable: outside_fair_range_high/low, cancel_above_verified. */
  flags: string[]
}

const HOUR = 3_600_000
const nowMs = (ctx: TermsCtx) => new Date(ctx.now).getTime()
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** "46.50", "$46.5", 46.5 → 4650; anything else → NaN. */
export function parseCents(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : NaN
  if (typeof v !== 'string') return NaN
  const s = v.trim().replace(/^\$/, '').replace(/,/g, '')
  return /^\d{1,7}(\.\d{1,2})?$/.test(s) ? cents(s) : NaN
}

export function available(ctx: TermsCtx): number {
  const auth = Math.max(0, Math.round(ctx.authorized_cents))
  return auth - clamp(Math.round(ctx.already_captured_cents), 0, auth)
}

/**
 * Fair range expressed as release_now (cents): [lo − captured, hi − captured], clamped to what is available, without the
 * unexecutable seller totals below the minimum settlement: a range entirely below it becomes [0, 0]; a low end below it
 * (but above 0) is raised to it.
 */
export function releaseRange(ctx: TermsCtx): [number, number] {
  const a = available(ctx)
  const cap = ctx.authorized_cents - a
  let lo = clamp(ctx.fair_range[0] - cap, 0, a)
  const hi = clamp(ctx.fair_range[1] - cap, lo, a)
  const min = ctx.min_settlement_cents ?? 0
  if (min > 0 && cap < min) {
    if (cap + hi < min) return [0, 0]
    if (cap + lo > 0 && cap + lo < min) lo = Math.min(hi, min - cap)
  }
  return [lo, hi]
}

/** R5: a seller total (captured + release) strictly between 0 and the minimum settlement snaps to the minimum if the fair range reaches it, else to 0. */
export function snapToMinimum(release: number, ctx: TermsCtx): number {
  const min = ctx.min_settlement_cents ?? 0
  const a = available(ctx)
  const cap = ctx.authorized_cents - a
  if (min <= 0 || release <= 0 || cap + release >= min) return release
  return cap + releaseRange(ctx)[1] >= min && min - cap <= a ? min - cap : 0
}

/** Check ids allowed in a redo of this deliverable. */
export function contractChecks(contract: Contract, deliverableId: string): Set<string> {
  const d = contract.spec.deliverables.find((x) => x.id === deliverableId)
  return new Set((d?.acceptance ?? []).map((a) => a.check))
}

/** Parse "P7D" / "PT48H" / "PT30M" to hours. */
export function durationHours(iso: string | undefined, fallback: number): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso ?? '')
  if (!m) return fallback
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 60
  return h > 0 ? h : fallback
}

function validDeadline(ts: string | null | undefined, ctx: TermsCtx): boolean {
  if (!ts) return false
  const t = new Date(ts).getTime()
  return Number.isFinite(t) && t > nowMs(ctx) && t <= nowMs(ctx) + MAX_HOLD_DAYS * 24 * HOUR
}

/**
 * Repair loose terms into exact, executable terms. Priority: release_now (clamped to what is available),
 * then the held amount, then refund_now absorbs the rest. Every change is listed in `repairs`.
 */
export function normalizeTerms(input: TermsInput, ctx: TermsCtx): { terms: ProposalTerms; repairs: string[] } {
  const repairs: string[] = []
  const A = available(ctx)
  const cancel = input.cancel === true
  let redoIn = input.redo ?? null
  let waitIn = input.wait_until ?? null
  if (cancel && (redoIn || waitIn)) {
    repairs.push('cancel drops redo/wait')
    redoIn = null
    waitIn = null
  }
  if (redoIn && waitIn) {
    repairs.push('redo and wait both set: kept redo')
    waitIn = null
  }

  const givenRelease = parseCents(input.release_now)
  const givenRefund = parseCents(input.refund_now)
  if (input.release_now != null && Number.isNaN(givenRelease)) repairs.push('release_now unreadable')
  if (input.refund_now != null && Number.isNaN(givenRefund)) repairs.push('refund_now unreadable')

  // release_now
  let release: number
  if (!Number.isNaN(givenRelease)) release = givenRelease
  else if (!redoIn && !waitIn && !Number.isNaN(givenRefund)) release = A - givenRefund
  else release = clamp(ctx.verified_cents - (ctx.authorized_cents - A), 0, A)
  if (release !== clamp(release, 0, A)) repairs.push(`release_now clamped to ${amount(clamp(release, 0, A))}`)
  release = clamp(release, 0, A)
  const snapped = snapToMinimum(release, ctx)
  if (snapped !== release) repairs.push(`release_now set to ${amount(snapped)}: the seller's total would be below the ${amount(ctx.min_settlement_cents ?? 0)} minimum settlement, which is never captured`)
  release = snapped

  // held
  let held = 0
  let redo: Redo | null = null
  if (redoIn) {
    const givenHeld = parseCents(redoIn.amount_on_success)
    if (!Number.isNaN(givenHeld)) held = givenHeld
    else held = !Number.isNaN(givenRefund) ? A - release - givenRefund : A - release
    const h = clamp(held, 0, A - release)
    if (h !== held || (redoIn.amount_on_success != null && Number.isNaN(givenHeld))) repairs.push(`redo.amount_on_success set to ${amount(h)}`)
    held = h
    const ids = new Set(ctx.contract.spec.deliverables.map((d) => d.id))
    let did = redoIn.deliverable_id ?? ''
    if (!ids.has(did)) {
      did = ctx.contract.spec.deliverables[0]?.id ?? 'D1'
      repairs.push(`redo.deliverable_id set to ${did}`)
    }
    const allowed = contractChecks(ctx.contract, did)
    const contractTests = ctx.contract.spec.deliverables.find((d) => d.id === did)?.acceptance ?? []
    let acceptance = (redoIn.acceptance ?? []).filter((a) => a && allowed.has(a.check)).map((a) => ({ check: a.check, params: a.params ?? {} }))
    if (acceptance.length !== (redoIn.acceptance ?? []).length || acceptance.length === 0) {
      if ((redoIn.acceptance ?? []).length) repairs.push('redo.acceptance: unknown check ids dropped')
      if (!acceptance.length) acceptance = contractTests.map((a) => ({ check: a.check, params: a.params }))
    }
    const units = [...new Set((redoIn.units ?? []).map((u) => String(u).replace(new RegExp(`^${did}:`), '').trim()).filter(Boolean))].slice(0, 500)
    let deadline = redoIn.deadline ?? ''
    if (!validDeadline(deadline, ctx)) {
      deadline = new Date(nowMs(ctx) + (ctx.default_redo_hours ?? 48) * HOUR).toISOString()
      repairs.push(`redo.deadline set to ${deadline}`)
    }
    if (units.length === 0) {
      repairs.push('redo without units dropped')
      held = 0
    } else redo = { deliverable_id: did, units, instruction: (redoIn.instruction ?? '').slice(0, 600), deadline, amount_on_success: amount(held), acceptance }
  } else if (waitIn) {
    if (!validDeadline(waitIn, ctx)) {
      waitIn = new Date(nowMs(ctx) + 48 * HOUR).toISOString()
      repairs.push(`wait_until set to ${waitIn}`)
    }
    held = !Number.isNaN(givenRefund) ? A - release - givenRefund : Math.min(A - release, ctx.pending_cents ?? A - release)
    held = clamp(held, 0, A - release)
    if (held === 0) {
      repairs.push('wait with nothing held dropped')
      waitIn = null
    }
  }

  const refund = A - release - held
  if (!Number.isNaN(givenRefund) && givenRefund !== refund) repairs.push(`refund_now set to ${amount(refund)} so the amounts add up`)
  const terms = ProposalTerms.parse({
    release_now: amount(release),
    refund_now: amount(refund),
    redo,
    wait_until: redo ? null : waitIn,
    cancel,
    note: (input.note ?? '').slice(0, 600),
  })
  return { terms, repairs }
}

/** Held amount implied by exact terms. */
export function heldCents(t: ProposalTerms, ctx: TermsCtx): number {
  if (t.redo) return cents(t.redo.amount_on_success)
  if (t.wait_until) return available(ctx) - cents(t.release_now) - cents(t.refund_now)
  return 0
}

/** Strict check of exact terms. Errors make terms unexecutable; flags are allowed but explained. */
export function validateTerms(raw: unknown, ctx: TermsCtx): Validation {
  const errors: string[] = []
  const flags: string[] = []
  const p = ProposalTerms.safeParse(raw)
  if (!p.success) return { ok: false, errors: p.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'terms'}: ${i.message}`), flags }
  const t = p.data
  const A = available(ctx)
  const rel = cents(t.release_now)
  const ref = cents(t.refund_now)
  if (t.redo && t.wait_until) errors.push('redo and wait_until cannot both be set')
  if (t.cancel && (t.redo || t.wait_until)) errors.push('cancel cannot hold money for redo or wait')
  const held = t.redo ? cents(t.redo.amount_on_success) : t.wait_until ? A - rel - ref : 0
  if (held < 0) errors.push('held amount would be negative')
  if (rel + ref + held !== A) errors.push(`release_now + refund_now + held must equal ${amount(A)} (authorized − already captured); got ${amount(rel + ref + held)}`)
  if (t.wait_until && held === 0) errors.push('wait_until with nothing held')
  if (t.wait_until && !validDeadline(t.wait_until, ctx)) errors.push(`wait_until must be in the future and within ${MAX_HOLD_DAYS} days`)
  if (t.redo) {
    const d = ctx.contract.spec.deliverables.find((x) => x.id === t.redo!.deliverable_id)
    if (!d) errors.push(`redo.deliverable_id ${t.redo.deliverable_id} is not in the contract`)
    if (!validDeadline(t.redo.deadline, ctx)) errors.push(`redo.deadline must be in the future and within ${MAX_HOLD_DAYS} days`)
    const allowed = contractChecks(ctx.contract, t.redo.deliverable_id)
    const bad = t.redo.acceptance.filter((a) => !allowed.has(a.check)).map((a) => a.check)
    if (bad.length) errors.push(`redo.acceptance uses checks not in the contract: ${bad.join(', ')}`)
  }
  const [lo, hi] = releaseRange(ctx)
  if (rel > hi) flags.push('outside_fair_range_high')
  if (rel < lo) flags.push('outside_fair_range_low')
  if (t.cancel && rel > clamp(ctx.verified_cents - (ctx.authorized_cents - A), 0, A)) flags.push('cancel_above_verified')
  return { ok: errors.length === 0, errors, flags }
}

/** Commission on a cumulative capture over `settlements` captures: max(floor + extra per settlement after the first, bps), never more than the capture. */
export function commissionCents(captured: number, fees: SettlementFees = SETTLEMENT_FEES, settlements = 1): number {
  if (captured <= 0) return 0
  const pct = Math.floor((captured * fees.commission_bps + 5000) / 10_000) // round half up
  if (fees.below_floor === 'pct' && captured < fees.commission_floor_cents) return pct
  const floor = fees.commission_floor_cents + Math.max(0, settlements - 1) * (fees.extra_settlement_cents ?? 0)
  return Math.min(captured, Math.max(floor, pct))
}

/**
 * What the core would do with these terms; commission comes out of the seller's share.
 * Plain split / cancel: capture release_now now (one final capture), void the rest. Below the minimum settlement nothing is
 * captured: the release is voided too. Redo / wait: nothing is captured now; release_now is secured and paid with the held
 * money's outcome in the job's single final capture (seller_payout_now is then the secured part's payout at that time).
 */
export function previewSettlement(t: ProposalTerms, ctx: TermsCtx, fees: SettlementFees = SETTLEMENT_FEES): SettlementPreview {
  const release = cents(t.release_now)
  const held = Math.max(0, heldCents(t, ctx))
  const min = fees.min_settlement_cents ?? ctx.min_settlement_cents ?? 0
  // Cumulative on the seller's gross (what core/fees.ts charges): earlier releases already paid their part of the commission;
  // a capture on top of an earlier one is a second settlement.
  const prior = Math.max(0, Math.round(ctx.already_captured_cents))
  const n = prior > 0 ? 2 : 1
  const voided = !held && release > 0 && release < min
  const paid = voided ? 0 : release
  const commission = Math.max(0, commissionCents(prior + paid, fees, paid ? n : 1) - commissionCents(prior, fees))
  const heldCommission = Math.max(0, commissionCents(prior + paid + held, fees, n) - commissionCents(prior + paid, fees, paid ? n : 1))
  return {
    capture_now: amount(held ? 0 : paid),
    void_now: amount(cents(t.refund_now) + (voided ? release : 0)),
    held: amount(held),
    platform_commission: amount(commission),
    seller_payout_now: amount(paid - commission),
    held_commission: amount(heldCommission),
    held_seller_payout: amount(held - heldCommission),
    ...(held ? { secured: amount(paid) } : {}),
  }
}
