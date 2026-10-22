// Independent re-implementation of the documented fee rules (docs/ESCROW_PAYPAL.md "Platform economics"), so the
// simulator does not use the code under test as its own oracle.
export const FLOOR = 300
export const BPS = 1500
export const MIN_SETTLEMENT = 500
export const EXTRA_SETTLEMENT = 100
export const MEDIATION_FLAT = 100

/** Cents from an Amount string or a Money object ({ value, currency }). */
export const c = (amount: string | { value: string } | null | undefined): number =>
  amount == null ? 0 : Math.round(Number(typeof amount === 'object' ? amount.value : amount) * 100)
export const usd = (cents: number) => (cents / 100).toFixed(2)

export const pctHalfUp = (cents: number, bps: number) => (cents <= 0 ? 0 : Math.floor((cents * bps + 5000) / 10000))

/**
 * commission = max($3 + $1 per settlement after the first, 15%) of the job's cumulative seller gross over n settlements;
 * a (legacy) gross below $3 pays only the 15%; never more than the gross.
 */
export function commission(gross: number, settlements = 1): number {
  if (gross <= 0) return 0
  const pct = pctHalfUp(gross, BPS)
  if (gross < FLOOR) return pct
  return Math.min(gross, Math.max(FLOOR + Math.max(0, settlements - 1) * EXTRA_SETTLEMENT, pct))
}

/** Estimated PayPal fee per capture: 3.49% + $0.49 (domestic). */
export const captureFee = (cents: number) => (cents <= 0 ? 0 : pctHalfUp(cents, 349) + 49)
export const PAYOUT_FEE = 25

/** Capture-and-hold: what a refund of `refund` keeps (PayPal's 3.49%; + $0.49 fixed + $1.00 extra when the seller earned nothing). */
export const refundKept = (refund: number, sellerGross: number) =>
  refund <= 0 ? 0 : Math.min(refund, pctHalfUp(refund, 349) + (sellerGross > 0 ? 0 : 49 + EXTRA_SETTLEMENT))

/** Mediation fee split by fault counts (ruling path): proportional; nobody at fault → half each, odd cent to the buyer. */
export function feeByFaults(flat: number, sellerFaults: number, buyerFaults: number) {
  const sf = Math.max(0, sellerFaults)
  const bf = Math.max(0, buyerFaults)
  const seller = sf + bf === 0 ? Math.floor(flat / 2) : Math.round((flat * sf) / (sf + bf))
  return { buyer: flat - seller, seller }
}
