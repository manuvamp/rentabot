// Remedy by formula. Models judge findings and faults; this pure function turns them into cents.
//
// For each deliverable d with contract line value V_d (quote line max_total) and check share
// c_d = passed_units / expected_units (from the fresh check run):
//   verified_d = min(f_d, c_d)            f_d = the mediator's fulfilment; it can lower what the checks
//                                         say (rubric misses) but never raise it above them
//   earned_d   = blocked_by_buyer ? max(f_d, c_d) : verified_d
//   credit_d   = earned_d − verified_d    (buyer-fault credit: work the buyer's own blocker kept unverified)
// late penalty = 2% of Σ verified_d·V_d per started day late, capped at 20%; waived when the buyer left a
//                blocker unanswered (the buyer caused the delay)
// seller_gross = Σ round(earned_d·V_d) − penalty
// available    = authorized − already_captured       (only uncaptured money can still move)
// seller_new   = clamp(seller_gross − already_captured, 0, available)
// platform fee = commission(captured + seller_new) − commission(captured)   when a floor is given: commission = max(floor,
//                bps of the seller's cumulative gross), exactly what core/fees.ts charges when the seller is paid, so a ruling
//                and a proposal preview agree with the payout. Without a floor: round(seller_new · bps / 10000).
// mediation    = flat fee split by fault count (seller faults incl. integrity flags vs buyer faults;
//                nobody at fault → half each, odd cent to the buyer side); each share is capped by
//                what that side receives, so a fee never makes a payout negative
// release_to_seller = seller_new + buyer_mediation_share   (the amount the core captures)
// refund_to_buyer   = available − release_to_seller        (the amount the core voids/refunds)
// seller payout     = release_to_seller − platform − mediation
// So release + refund == authorized − already_captured, always, in integer cents.
import type { FindingStatus } from '@rentabot/shared'
import { commissionCents, settlementFeesFrom } from '../negotiation/terms.ts'

export interface RemedyInput {
  lines: { deliverable_id: string; value_cents: number }[]
  findings: { deliverable_id: string; status: FindingStatus; fulfilment: number }[]
  /** passed/expected units per deliverable, 0..1. Missing = 0. */
  check_share: Record<string, number>
  late_by_minutes: number
  unanswered_blockers: number
  authorized_cents: number
  already_captured_cents: number
  platform_fee_bps: number
  /** Commission floor in cents (the contract's fees.floor). Omitted: plain percentage, no floor. */
  platform_fee_floor_cents?: number
  mediation_flat_cents: number
  seller_faults: number
  buyer_faults: number
}

export interface RemedyLine {
  deliverable_id: string
  value_cents: number
  check_share: number
  fulfilment: number
  verified_cents: number
  earned_cents: number
  credit_cents: number
}

export interface RemedyResult {
  type: 'release_full' | 'split' | 'refund_full'
  lines: RemedyLine[]
  verified_cents: number
  buyer_credit_cents: number
  late_days: number
  late_penalty_cents: number
  late_penalty_waived: boolean
  seller_gross_cents: number
  available_cents: number
  seller_new_cents: number
  release_cents: number
  refund_cents: number
  platform_fee_cents: number
  mediation: { total_cents: number; seller_cents: number; buyer_cents: number }
  seller_payout_cents: number
  /** Seller already got more than this ruling says it earned; nothing is clawed back. */
  overpaid_cents: number
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)
const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0)

export const LATE_RATE_PER_DAY = 0.02
export const LATE_CAP = 0.2

export function computeRemedy(input: RemedyInput): RemedyResult {
  const byId = new Map(input.findings.map((f) => [f.deliverable_id, f]))
  const lines: RemedyLine[] = input.lines.map((l) => {
    const value = nonNeg(l.value_cents)
    const c = clamp01(input.check_share[l.deliverable_id] ?? 0)
    const f = byId.get(l.deliverable_id)
    const fulfilment = clamp01(f?.fulfilment ?? c)
    const verified = Math.min(fulfilment, c)
    const earned = f?.status === 'blocked_by_buyer' ? Math.max(fulfilment, c) : verified
    const verified_cents = Math.round(verified * value)
    const earned_cents = Math.round(earned * value)
    return { deliverable_id: l.deliverable_id, value_cents: value, check_share: c, fulfilment, verified_cents, earned_cents, credit_cents: earned_cents - verified_cents }
  })
  const verified_cents = lines.reduce((s, l) => s + l.verified_cents, 0)
  const buyer_credit_cents = lines.reduce((s, l) => s + l.credit_cents, 0)

  const late_days = input.late_by_minutes > 0 ? Math.ceil(input.late_by_minutes / 1440) : 0
  const late_penalty_waived = late_days > 0 && input.unanswered_blockers > 0
  const rate = late_penalty_waived ? 0 : Math.min(LATE_CAP, LATE_RATE_PER_DAY * late_days)
  const late_penalty_cents = Math.round(verified_cents * rate)
  const seller_gross_cents = verified_cents + buyer_credit_cents - late_penalty_cents

  const authorized = nonNeg(input.authorized_cents)
  const captured = Math.min(nonNeg(input.already_captured_cents), authorized)
  const available_cents = authorized - captured
  const seller_new_cents = Math.min(available_cents, Math.max(0, seller_gross_cents - captured))
  const overpaid_cents = Math.max(0, captured - seller_gross_cents)
  const bps = Math.max(0, Math.round(input.platform_fee_bps))
  const platform_fee_cents =
    input.platform_fee_floor_cents === undefined
      ? Math.round((seller_new_cents * bps) / 10_000)
      : (() => {
          const fees = settlementFeesFrom({ commission_bps: bps, floor_cents: nonNeg(input.platform_fee_floor_cents) })
          return Math.max(0, commissionCents(captured + seller_new_cents, fees) - commissionCents(captured, fees))
        })()

  // Mediation fee split by fault.
  const total = nonNeg(input.mediation_flat_cents)
  const sw = Math.max(0, input.seller_faults)
  const bw = Math.max(0, input.buyer_faults)
  let sellerShare = sw + bw === 0 ? Math.floor(total / 2) : Math.round((total * sw) / (sw + bw))
  let buyerShare = total - sellerShare
  sellerShare = Math.min(sellerShare, seller_new_cents - platform_fee_cents)
  buyerShare = Math.min(buyerShare, available_cents - seller_new_cents)
  sellerShare = Math.max(0, sellerShare)
  buyerShare = Math.max(0, buyerShare)

  const release_cents = seller_new_cents + buyerShare
  const refund_cents = available_cents - release_cents
  const type = seller_new_cents === 0 ? 'refund_full' : refund_cents === 0 ? 'release_full' : 'split'
  return {
    type,
    lines,
    verified_cents,
    buyer_credit_cents,
    late_days,
    late_penalty_cents,
    late_penalty_waived,
    seller_gross_cents,
    available_cents,
    seller_new_cents,
    release_cents,
    refund_cents,
    platform_fee_cents,
    mediation: { total_cents: sellerShare + buyerShare, seller_cents: sellerShare, buyer_cents: buyerShare },
    seller_payout_cents: release_cents - platform_fee_cents - sellerShare - buyerShare,
    overpaid_cents,
  }
}

/** Share of the escrow a ruling hands the seller: (already captured + new seller money) / authorized. */
export function releaseFraction(r: RemedyResult, authorized_cents: number): number {
  if (authorized_cents <= 0) return 0
  const captured = authorized_cents - r.available_cents
  return clamp01((captured + r.seller_new_cents) / authorized_cents)
}
