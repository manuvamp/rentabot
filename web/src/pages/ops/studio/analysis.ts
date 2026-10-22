// The analyst's evidence: why did platform net move between a period and the weeks before it? Pure functions over the jobs
// table (the same rows Studio shows), so the tool's answer always agrees with the dashboard. Impacts are in USD of platform
// net versus the average of the four preceding periods of the same length; "volume and mix" is whatever the named drivers
// do not explain (and any overlap between them), so the drivers always add up to the change.
import type { Row } from './data'

export interface Period {
  label: string
  from: string
  to: string
  days: number
}

const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

export const PERIOD_FORMS = "last_week, this_week, last_7_days, last_30_days, or 'YYYY-MM-DD..YYYY-MM-DD' (both ends inclusive)"

/** "last_week" etc. (spaces and dashes are fine too) or an explicit range; null when it is none of those. */
export function resolvePeriod(spec: string, now: Date = new Date()): Period | null {
  const s = spec.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const today = startOfDay(now)
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY
  const make = (label: string, from: number, to: number): Period => ({ label, from: iso(from), to: iso(to), days: Math.round((to - from) / DAY) + 1 })
  if (s === 'last_week' || s === 'previous_week') return make('last week', monday - 7 * DAY, monday - DAY)
  if (s === 'this_week') return make('this week', monday, today)
  if (s === 'last_7_days' || s === 'past_week' || s === 'last_seven_days') return make('the last 7 days', today - 6 * DAY, today)
  if (s === 'last_30_days' || s === 'last_month' || s === 'past_month') return make('the last 30 days', today - 29 * DAY, today)
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.\.|_to_|_)(\d{4}-\d{2}-\d{2})$/.exec(s)
  if (m) {
    const a = Date.parse(m[1]!)
    const b = Date.parse(m[2]!)
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a < 400 * DAY) return make(`${m[1]} to ${m[2]}`, a, b)
  }
  return null
}

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
const cents = (x: number) => Math.round(x * 100) / 100

/**
 * What a capture under the $5 minimum would have earned the platform had it been allowed: commission (15%, floor $3.00) minus
 * PayPal's capture fee (3.49% + $0.49) and the $0.25 payout fee. The platform's published defaults (docs/ESCROW_PAYPAL.md).
 */
export function foregoneNet(earned: number): number {
  if (earned <= 0) return 0
  const commission = Math.min(earned, Math.max(3, earned * 0.15))
  return commission - (earned * 0.0349 + 0.49) - (earned - commission > 0 ? 0.25 : 0)
}

export type DriverId = 'below_minimum_voids' | 'fee_variance' | 'arbiter_rulings' | 'refund_fees_kept' | 'volume_and_mix'

export interface Evidence {
  job_id: string
  title: string
  bot: string
  date: string
  platform_net: number
  detail: string
}
export interface Driver {
  driver: DriverId
  label: string
  impact_usd: number
  /** What this driver measured in the period and, on average, in the baseline. */
  period_value: number
  baseline_value: number
  jobs: number
  explanation: string
  evidence: Evidence[]
}
export interface NetExplanation {
  period: Period
  baseline: { periods: number; days_each: number; from: string; to: string }
  jobs_in_period: number
  net_period: number
  net_baseline_avg: number
  delta: number
  verdict: 'dip' | 'rise' | 'flat' | 'no_baseline'
  drivers: Driver[]
  /** Dates the waterfall should be filtered to in order to show this period. */
  waterfall_filter: { field: 'jobs.date'; from: string; to: string }
}

type Window = { from: number; to: number }
const inWindow = (r: Row, w: Window) => {
  const t = Date.parse(String(r.date))
  return t >= w.from && t <= w.to
}

const evidenceOf = (r: Row, detail: string): Evidence => ({ job_id: String(r.job_id), title: String(r.title), bot: String(r.bot), date: String(r.date), platform_net: cents(n(r.platform_net)), detail })

export function explainNetChange(jobs: Row[], period: Period, opts: { baselinePeriods?: number; maxEvidence?: number } = {}): NetExplanation {
  const k = opts.baselinePeriods ?? 4
  const maxEvidence = opts.maxEvidence ?? 3
  const from = Date.parse(period.from)
  const to = Date.parse(period.to)
  const span = period.days * DAY
  const cur: Window = { from, to }
  const windows: Window[] = Array.from({ length: k }, (_, i) => ({ from: from - (i + 1) * span, to: to - (i + 1) * span }))
  const inCur = jobs.filter((r) => inWindow(r, cur))
  const baseWindows = windows.map((w) => jobs.filter((r) => inWindow(r, w))).filter((rows) => rows.length > 0)
  const avg = (f: (rows: Row[]) => number) => (baseWindows.length ? baseWindows.reduce((s, rows) => s + f(rows), 0) / baseWindows.length : 0)
  const sum = (rows: Row[], f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0)

  const net = (rows: Row[]) => sum(rows, (r) => n(r.platform_net))
  const isArbiter = (r: Row) => r.settled_by === 'arbiter'
  const isBelowMin = (r: Row) => r.below_minimum_void === true
  const metrics: Record<Exclude<DriverId, 'volume_and_mix'>, (rows: Row[]) => number> = {
    below_minimum_voids: (rows) => sum(rows.filter(isBelowMin), (r) => foregoneNet(n(r.earned_not_captured))),
    fee_variance: (rows) => sum(rows, (r) => n(r.fee_variance)),
    arbiter_rulings: (rows) => net(rows.filter(isArbiter)),
    refund_fees_kept: (rows) => sum(rows, (r) => n(r.refund_fees_kept)),
  }
  const netPeriod = net(inCur)
  const netBase = avg(net)
  const delta = baseWindows.length ? netPeriod - netBase : 0

  const impact = {
    below_minimum_voids: -(metrics.below_minimum_voids(inCur) - avg(metrics.below_minimum_voids)),
    fee_variance: -(metrics.fee_variance(inCur) - avg(metrics.fee_variance)),
    arbiter_rulings: metrics.arbiter_rulings(inCur) - avg(metrics.arbiter_rulings),
    refund_fees_kept: metrics.refund_fees_kept(inCur) - avg(metrics.refund_fees_kept),
  }
  const explained = Object.values(impact).reduce((s, v) => s + v, 0)

  const top = (rows: Row[], by: (r: Row) => number, detail: (r: Row) => string) =>
    [...rows].sort((a, b) => by(b) - by(a)).slice(0, maxEvidence).map((r) => evidenceOf(r, detail(r)))
  const usd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`
  const rate = (v: number, b: number) => `${usd(v)} this period against ${usd(b)} on average before`

  const below = inCur.filter(isBelowMin)
  const arb = inCur.filter(isArbiter)
  const drivers: Driver[] = ([
    {
      driver: 'below_minimum_voids',
      label: 'Captures voided below the $5 minimum',
      impact_usd: impact.below_minimum_voids,
      period_value: metrics.below_minimum_voids(inCur),
      baseline_value: avg(metrics.below_minimum_voids),
      jobs: below.length,
      explanation: `${below.length} job(s) earned under $5.00, so nothing was captured and no commission was taken; they would have netted about ${rate(metrics.below_minimum_voids(inCur), avg(metrics.below_minimum_voids))}.`,
      evidence: top(below, (r) => n(r.earned_not_captured), (r) => `earned ${usd(n(r.earned_not_captured))}, under the minimum, voided`),
    },
    {
      driver: 'fee_variance',
      label: 'PayPal fees above the estimate',
      impact_usd: impact.fee_variance,
      period_value: metrics.fee_variance(inCur),
      baseline_value: avg(metrics.fee_variance),
      jobs: inCur.filter((r) => n(r.fee_variance) > 0.004).length,
      explanation: `PayPal charged ${rate(metrics.fee_variance(inCur), avg(metrics.fee_variance))} over its estimate.`,
      evidence: top(inCur.filter((r) => n(r.fee_variance) > 0.004), (r) => n(r.fee_variance), (r) => `PayPal fee ${usd(n(r.paypal_fees))} against ${usd(n(r.paypal_fees_est))} estimated`),
    },
    {
      driver: 'arbiter_rulings',
      label: 'Disputes that went to the arbiter',
      impact_usd: impact.arbiter_rulings,
      period_value: metrics.arbiter_rulings(inCur),
      baseline_value: avg(metrics.arbiter_rulings),
      jobs: arb.length,
      explanation: `${arb.length} dispute(s) were decided by the arbiter instead of settling by agreement; their net was ${rate(metrics.arbiter_rulings(inCur), avg(metrics.arbiter_rulings))}.`,
      evidence: top(arb, (r) => -n(r.platform_net), (r) => `arbiter ruling; captured ${usd(n(r.captured))}, refunded ${usd(n(r.refunded))}`),
    },
    {
      driver: 'refund_fees_kept',
      label: 'Refunds that kept PayPal fees',
      impact_usd: impact.refund_fees_kept,
      period_value: metrics.refund_fees_kept(inCur),
      baseline_value: avg(metrics.refund_fees_kept),
      jobs: inCur.filter((r) => n(r.refund_fees_kept) > 0).length,
      explanation: `Capture-and-hold refunds kept ${rate(metrics.refund_fees_kept(inCur), avg(metrics.refund_fees_kept))} of PayPal's non-returned fees.`,
      evidence: top(inCur.filter((r) => n(r.refund_fees_kept) > 0), (r) => n(r.refund_fees_kept), (r) => `kept ${usd(n(r.refund_fees_kept))} of a ${usd(n(r.refunded))} refund`),
    },
    {
      driver: 'volume_and_mix',
      label: 'Volume and mix (everything else)',
      impact_usd: delta - explained,
      period_value: inCur.length,
      baseline_value: avg((rows) => rows.length),
      jobs: inCur.length,
      explanation: `${inCur.length} job(s) this period against ${avg((rows) => rows.length).toFixed(1)} on average before; the remainder of the change not explained above.`,
      evidence: top(inCur.filter((r) => n(r.platform_net) < 0), (r) => -n(r.platform_net), (r) => `lost money: net ${usd(n(r.platform_net))}`),
    },
  ] as Driver[]).map((d) => ({ ...d, impact_usd: cents(d.impact_usd), period_value: cents(d.period_value), baseline_value: cents(d.baseline_value) }))

  drivers.sort((a, b) => Math.abs(b.impact_usd) - Math.abs(a.impact_usd))
  const bFrom = Math.min(...windows.map((w) => w.from))
  return {
    period,
    baseline: { periods: baseWindows.length, days_each: period.days, from: iso(bFrom), to: iso(from - DAY) },
    jobs_in_period: inCur.length,
    net_period: cents(netPeriod),
    net_baseline_avg: cents(netBase),
    delta: cents(delta),
    verdict: !baseWindows.length ? 'no_baseline' : Math.abs(delta) < 0.5 ? 'flat' : delta < 0 ? 'dip' : 'rise',
    drivers,
    waterfall_filter: { field: 'jobs.date', from: period.from, to: period.to },
  }
}
