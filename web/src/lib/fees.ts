/**
 * Platform commission: 15% of what was captured, at least $3.00 per job (+$1.00 for each extra settlement), taken from the
 * seller's share. Never more than was captured. Nothing below the $5.00 minimum settlement is captured (it is voided).
 */
export const FEE_RATE = 0.15
export const FEE_MIN_CENTS = 300
export const EXTRA_SETTLEMENT_CENTS = 100
export const MIN_SETTLEMENT_CENTS = 500

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
/** Fee copy for every page, built from the constants above so it never drifts from the rules. */
export const FEE_SHORT = `${FEE_RATE * 100}%, min ${money(FEE_MIN_CENTS)} per job`
export const COMMISSION_RULE = `${FEE_RATE * 100}% of what is captured, at least ${money(FEE_MIN_CENTS)} per job (+${money(EXTRA_SETTLEMENT_CENTS)} for each extra settlement), taken from the seller's share`
export const MINIMUM_RULE = `Jobs start at ${money(MIN_SETTLEMENT_CENTS)}; a verified total under ${money(MIN_SETTLEMENT_CENTS)} is never captured: the hold is voided and nothing is charged`

/** What PayPal captures for a verified amount: nothing below the minimum settlement. */
export const capturedFor = (verifiedCents: number) => (verifiedCents >= MIN_SETTLEMENT_CENTS ? verifiedCents : 0)

export function platformFeeCents(capturedCents: number): number {
  if (capturedCents <= 0) return 0
  return Math.min(capturedCents, Math.max(FEE_MIN_CENTS, Math.round(capturedCents * FEE_RATE)))
}

/** Rough PayPal costs the platform bears: 3.49% + $0.49 per capture, $0.25 per payout. */
export function paypalCostCents(capturedCents: number, captures = 1): number {
  if (capturedCents <= 0) return 0
  return Math.round(capturedCents * 0.0349) + 49 * captures + 25
}
