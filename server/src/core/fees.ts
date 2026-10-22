// All fee math, pure and in integer cents (docs/ESCROW_PAYPAL.md "Platform economics").
//
//   minimum       = MIN_SETTLEMENT ($5): no quote, budget or capture below it (a capture that would be smaller is voided)
//   commission    = min(C, max(FLOOR + (n − 1) × EXTRA, PCT × C)), rounded half-up, on the job's cumulative seller gross C
//                   over n settlements (captures); one settlement per job is the rule, each extra one costs EXTRA ($1)
//   seller_payout = C − commission (− a seller-side mediation fee when a ruling says so)
//   buyer pays exactly the captured (verified) amount; unproven money is voided (free), never captured and refunded.
//   capture-and-hold refunds keep PayPal's non-returned fee on the refunded money (refundKeptFee).
//
// Commission is cumulative: each settlement takes commission(total, n) − commission already taken. It is non-decreasing
// in C and n, so the increment is never negative; and with every capture ≥ MIN_SETTLEMENT ≥ FLOOR + EXTRA the increment
// never exceeds the new capture (proof at settlementIncrement).

export interface FeePolicy {
  /** Commission rate in basis points (15% = 1500). */
  commission_bps: number
  floor_cents: number
  /** Minimum job price and minimum capture: a capture that would be smaller is voided instead. */
  min_settlement_cents: number
  /** Added to the commission floor for every settlement (capture) after the first. */
  extra_settlement_cents: number
  /** Estimated PayPal costs (previews, P&L before actuals arrive). */
  paypal_capture_bps: number
  paypal_capture_fixed_cents: number
  paypal_payout_cents: number
}

export const DEFAULT_FEES: FeePolicy = {
  commission_bps: 1500,
  floor_cents: 300,
  min_settlement_cents: 500,
  extra_settlement_cents: 100,
  paypal_capture_bps: 349,
  paypal_capture_fixed_cents: 49,
  paypal_payout_cents: 25,
}

/** x × bps / 10 000, rounded half-up to the cent (integer math: floor((x·bps + 5000) / 10000)). */
export function pctHalfUp(cents: number, bps: number): number {
  if (!Number.isInteger(cents) || !Number.isInteger(bps)) throw new Error('fee math needs integer cents and bps')
  if (cents <= 0) return 0
  return Math.floor((cents * bps + 5000) / 10000)
}

/**
 * Platform commission on a job's cumulative captured seller gross over `settlements` captures. Never more than the gross.
 * Below the floor (only reachable on legacy jobs: captures are ≥ MIN_SETTLEMENT now) it is the plain percentage.
 */
export function commission(capturedCents: number, p: FeePolicy = DEFAULT_FEES, settlements = 1): number {
  if (capturedCents <= 0) return 0
  const pct = pctHalfUp(capturedCents, p.commission_bps)
  if (capturedCents < p.floor_cents) return pct
  const floor = p.floor_cents + Math.max(0, Math.floor(settlements) - 1) * (p.extra_settlement_cents ?? 0)
  return Math.min(capturedCents, Math.max(floor, pct))
}

/**
 * Commission taken by settlement n (gross so far `prior`, this settlement adds `tail`):
 * commission(prior + tail, n) − commission(prior, n − 1).
 * Bound: with prior ≥ FLOOR and tail ≥ FLOOR + EXTRA (MIN_SETTLEMENT $5 ≥ $3 + $1), 0 ≤ increment ≤ tail:
 *   ≥ 0  both arguments grow, and commission is non-decreasing in gross and in n;
 *   ≤ tail  if the new value is the percentage: pct(prior + tail) − pct(prior) ≤ pct(tail) + 1¢ ≤ tail;
 *           if it is the floor: (FLOOR + (n−1)·EXTRA) − (FLOOR + (n−2)·EXTRA) = EXTRA ≤ tail (the old value is ≥ its floor).
 */
export function settlementIncrement(priorCents: number, tailCents: number, n: number, p: FeePolicy = DEFAULT_FEES): number {
  return commission(priorCents + tailCents, p, n) - commission(priorCents, p, Math.max(1, n - 1))
}

/** True when a capture of `cents` is allowed (zero means "nothing to capture", which is always fine). */
export const capturable = (cents: number, p: FeePolicy = DEFAULT_FEES) => cents <= 0 || cents >= p.min_settlement_cents

/**
 * Capture-and-hold: PayPal does not return its capture fee on refunded money. The refund keeps PayPal's percentage on the
 * refunded part; when the seller earned nothing there is no commission to carry the rest, so the refund also keeps PayPal's
 * fixed fee and the extra-settlement fee (a capture followed by a refund is a second money movement). Never more than the refund.
 */
export function refundKeptFee(refundCents: number, sellerGrossCents: number, p: FeePolicy = DEFAULT_FEES): number {
  if (refundCents <= 0) return 0
  const fee = pctHalfUp(refundCents, p.paypal_capture_bps) + (sellerGrossCents > 0 ? 0 : p.paypal_capture_fixed_cents + (p.extra_settlement_cents ?? 0))
  return Math.min(refundCents, fee)
}

/** PayPal's fee on one capture (estimate: 3.49% + $0.49 domestic). */
export const estimatedCaptureFee = (capturedCents: number, p: FeePolicy = DEFAULT_FEES) =>
  capturedCents <= 0 ? 0 : pctHalfUp(capturedCents, p.paypal_capture_bps) + p.paypal_capture_fixed_cents

export interface SettlementPreview {
  captured: number
  commission: number
  seller_payout: number
  est_paypal_capture_fee: number
  est_paypal_payout_fee: number
  est_platform_net: number
}

/** One settlement (one capture + one payout) of `capturedCents`, as the docs' table shows it. Below the minimum nothing is captured. */
export function previewSettlement(capturedCents: number, p: FeePolicy = DEFAULT_FEES): SettlementPreview {
  if (!capturable(capturedCents, p)) capturedCents = 0
  const c = commission(capturedCents, p)
  const cap = estimatedCaptureFee(capturedCents, p)
  const pay = capturedCents - c > 0 ? p.paypal_payout_cents : 0
  return { captured: capturedCents, commission: c, seller_payout: capturedCents - c, est_paypal_capture_fee: cap, est_paypal_payout_fee: pay, est_platform_net: c - cap - pay }
}

/**
 * What the seller is owed so far: cumulative gross − commission − seller-side mediation fee (capped so the
 * payout never goes negative). `alreadyPaid` is subtracted by the caller.
 */
export function sellerNet(grossCents: number, sellerMediationFeeCents: number, p: FeePolicy = DEFAULT_FEES, settlements = 1): { commission: number; seller_fee: number; net: number } {
  const c = commission(grossCents, p, settlements)
  const seller_fee = Math.max(0, Math.min(sellerMediationFeeCents, grossCents - c))
  return { commission: c, seller_fee, net: grossCents - c - seller_fee }
}

/**
 * Mediation fee split by fault counts (what the negotiator's recommended ruling uses): shares proportional to each side's
 * faults; nobody at fault → half each, odd cent to the buyer. The buyer's share comes out of the refund, the seller's out of the payout.
 */
export function mediationFeeByFaults(flatCents: number, sellerFaults: number, buyerFaults: number): { buyer: number; seller: number } {
  const sf = Math.max(0, sellerFaults)
  const bf = Math.max(0, buyerFaults)
  const seller = sf + bf === 0 ? Math.floor(flatCents / 2) : Math.round((flatCents * sf) / (sf + bf))
  return { buyer: flatCents - seller, seller }
}

/** Mediation fee to charge: the side at fault pays it all; both or neither at fault → split, odd cent to the buyer. */
export function mediationFeeSplit(flatCents: number, buyerAtFault: boolean, sellerAtFault: boolean): { buyer: number; seller: number } {
  if (buyerAtFault && !sellerAtFault) return { buyer: flatCents, seller: 0 }
  if (sellerAtFault && !buyerAtFault) return { buyer: 0, seller: flatCents }
  const buyer = Math.ceil(flatCents / 2)
  return { buyer, seller: flatCents - buyer }
}
