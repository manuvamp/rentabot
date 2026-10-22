// Simulated history for the dashboard in demo mode: six weeks of jobs that look like real ones, so the P&L has a time series
// to show. Every figure is produced with the same fee functions the core uses (fees.ts: commission, estimated PayPal fees,
// the fee kept from refunds), the rows carry simulated = true, and nothing is written to the database, so the demo reset
// and seed are untouched. The data is deterministic (fixed seed, anchored to today) and includes one bad week on purpose:
// the last full calendar week has more captures voided under the $5 minimum, more arbiter rulings and dearer PayPal fees,
// so "why did platform net dip last week?" has an answer.
import type { BotCard } from '@rentabot/shared'
import type { JobFacts } from './analytics.ts'
import { commission, estimatedCaptureFee, refundKeptFee, type FeePolicy } from './fees.ts'

const DAY = 86_400_000

/** mulberry32: small, fast, deterministic. */
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  }
}

const BUYERS = ['ORANO Growth Agent', 'Launchpad Agent', 'Atlas Procurement Agent', 'Nimbus Marketing Bot', 'Fieldnotes Research Agent', 'Helio Sales Agent']
/** A bot and check that fail more than the rest, so "which bot fails url_live most?" has a clear answer. */
const FLAKY = { bot: 'Directory Blaster', check: 'url_live', failRate: 0.22 }

type Scenario = 'clean' | 'partial' | 'under_min' | 'all_fail' | 'agreement' | 'arbiter' | 'open'

function weights(dip: boolean): [Scenario, number][] {
  return dip
    ? [['clean', 20], ['partial', 10], ['under_min', 46], ['all_fail', 4], ['agreement', 6], ['arbiter', 14], ['open', 0]]
    : [['clean', 52], ['partial', 20], ['under_min', 7], ['all_fail', 4], ['agreement', 12], ['arbiter', 3], ['open', 0]]
}

export function demoHistory(opts: { now: number; bots: BotCard[]; policy: FeePolicy; mediationFlatCents: number; seed?: number }): JobFacts[] {
  const rng = prng(opts.seed ?? 20261019)
  const { policy } = opts
  const today = Math.floor(opts.now / DAY) * DAY
  const dow = new Date(today).getUTCDay() // 0 = Sunday
  const monday = today - ((dow + 6) % 7) * DAY
  const dipStart = monday - 7 * DAY
  const bots = opts.bots.filter((b) => b.status === 'listed' && b.skills.length)
  if (!bots.length) return []
  const out: JobFacts[] = []
  let n = 0

  for (let offset = 42; offset >= 0; offset--) {
    const dayStart = today - offset * DAY
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay())
    const dip = dayStart >= dipStart && dayStart < dipStart + 7 * DAY
    const count = offset === 0 ? rng.int(0, 1) : weekend ? rng.int(0, 2) : rng.int(2, 4)
    for (let k = 0; k < count; k++) {
      const bot = rng.pick(bots)
      const skill = rng.pick(bot.skills)
      const unit = Math.round(Number(skill.pricing.price) * 100)
      const perUnit = skill.pricing.model === 'per_unit'
      let scenario = pickWeighted(rng, weights(dip))
      if (!perUnit && (scenario === 'under_min' || scenario === 'partial')) scenario = 'clean'
      // Today's jobs are still being worked: money held in escrow, nothing captured yet.
      if (offset === 0) scenario = 'open'
      const qty = perUnit ? Math.max(skill.pricing.min_units ?? 6, rng.int(6, 36)) : 1
      const authorized = perUnit ? qty * unit : unit
      const settleTs = dayStart + rng.int(8, 20) * 3_600_000 + rng.int(0, 59) * 60_000
      const createdTs = settleTs - rng.int(1, 4) * DAY - rng.int(0, 5) * 3_600_000
      out.push(buildJob({ id: `sim_${String(++n).padStart(4, '0')}`, bot, skill, scenario, dip, qty, unit, perUnit, authorized, settleTs, createdTs, rng, policy, mediationFlat: opts.mediationFlatCents }))
    }
  }
  return out
}

function pickWeighted(rng: ReturnType<typeof prng>, ws: [Scenario, number][]): Scenario {
  const total = ws.reduce((s, [, w]) => s + w, 0)
  let r = rng.next() * total
  for (const [s, w] of ws) {
    r -= w
    if (r < 0) return s
  }
  return ws[0]![0]
}

interface Build {
  id: string
  bot: BotCard
  skill: BotCard['skills'][number]
  scenario: Scenario
  dip: boolean
  qty: number
  unit: number
  perUnit: boolean
  authorized: number
  settleTs: number
  createdTs: number
  rng: ReturnType<typeof prng>
  policy: FeePolicy
  mediationFlat: number
}

function buildJob(b: Build): JobFacts {
  const { rng, policy, authorized, scenario } = b
  const iso = (t: number) => new Date(t).toISOString()
  let passed = b.qty
  let captured = 0
  let voided = 0
  let refunded = 0
  let extra = 0 // buyer-side mediation fee
  let sellerFee = 0
  let gross = 0 // seller's gross release
  let kept = 0
  let belowMin = false
  let belowMinEarned = 0
  let mode: 'hold' | 'capture_and_hold' = 'hold'
  let settled_by: JobFacts['settled_by'] = 'checks'
  let state = 'SETTLED'
  let held = 0
  let dispute: JobFacts['dispute'] = null

  const settleByChecks = () => {
    const earned = b.perUnit ? passed * b.unit : passed > 0 ? authorized : 0
    if (earned >= policy.min_settlement_cents) {
      gross = earned
      captured = earned
      voided = authorized - earned
    } else {
      // Capture would be under the minimum: voided, never charged.
      belowMin = earned > 0
      belowMinEarned = earned
      voided = authorized
    }
  }

  if (scenario === 'clean') settleByChecks()
  else if (scenario === 'partial') {
    passed = Math.max(1, Math.round(b.qty * (0.55 + rng.next() * 0.37)))
    settleByChecks()
  } else if (scenario === 'under_min') {
    // Enough units pass to earn something, but under $5.00: nothing is captured.
    const maxPassed = Math.max(1, Math.floor((policy.min_settlement_cents - 1) / b.unit))
    passed = Math.max(1, maxPassed - rng.int(0, 1))
    settleByChecks()
  } else if (scenario === 'all_fail') {
    passed = 0
    settleByChecks()
  } else if (scenario === 'open') {
    state = 'IN_PROGRESS'
    passed = 0
    held = authorized
    settled_by = 'none'
  } else {
    // A dispute that ended in an agreement or an arbiter's decision.
    passed = Math.max(0, Math.round(b.qty * (0.4 + rng.next() * 0.4)))
    const share = 0.45 + rng.next() * 0.35
    gross = Math.max(policy.min_settlement_cents, Math.round((authorized * share) / 5) * 5)
    gross = Math.min(gross, authorized)
    mode = rng.chance(0.4) ? 'capture_and_hold' : 'hold'
    const fee = b.mediationFlat
    if (scenario === 'agreement') {
      extra = Math.ceil(fee / 2)
      sellerFee = fee - extra
    } else if (rng.chance(0.6)) sellerFee = fee
    else extra = fee
    sellerFee = Math.min(sellerFee, Math.max(0, gross - commission(gross, policy, 1)))
    if (mode === 'hold') {
      captured = gross + extra
      voided = authorized - captured
    } else {
      captured = authorized
      refunded = authorized - gross - extra
      kept = refundKeptFee(refunded, gross, policy)
    }
    settled_by = scenario
    const openedAt = b.settleTs - rng.int(2, 30) * 3_600_000
    const rounds = scenario === 'arbiter' ? 2 : 1 + (rng.chance(0.4) ? 1 : 0)
    const proposals: NonNullable<JobFacts['dispute']>['proposals'] = []
    for (let r = 1; r <= rounds; r++) {
      const last = r === rounds
      proposals.push({ round: r, by: 'mediator', kind: r === 1 ? 'split' : rng.pick(['redo', 'wait', 'split'] as const), status: last && scenario === 'agreement' ? 'accepted' : 'rejected', release_cents: Math.round(gross * (r === 1 ? 1.12 : 1)) })
      if (!last || scenario === 'arbiter') proposals.push({ round: r, by: rng.pick(['buyer', 'seller'] as const), kind: 'split', status: 'rejected', release_cents: Math.round(gross * (rng.chance(0.5) ? 0.82 : 1.2)) })
    }
    dispute = { opened_at: iso(openedAt), closed_at: iso(b.settleTs), rounds, opened_by: rng.pick(['buyer', 'seller'] as const), flags: rng.chance(0.08) ? 1 : 0, proposals }
  }

  const sellerGross = gross
  const comm = commission(sellerGross, policy, 1)
  const payout = Math.max(0, sellerGross - comm - sellerFee)
  const capture_fee_est = estimatedCaptureFee(captured, policy)
  const payout_fee_est = payout > 0 ? policy.paypal_payout_cents : 0
  // Actual PayPal fees differ a little from the estimate; cross-border cards cost 1.5% more, and the bad week has many of them.
  const intl = captured > 0 && rng.chance(b.dip ? 0.5 : 0.07)
  const capture_fee = captured > 0 ? Math.max(0, capture_fee_est + rng.int(-5, 5) + (intl ? Math.round(captured * 0.015) : 0)) : 0
  const payout_fee = payout_fee_est

  const created = iso(b.createdTs)
  const events: JobFacts['events'] = [{ ts: iso(b.createdTs + rng.int(1, 5) * 3_600_000), kind: 'authorized', cents: authorized }]
  if (dispute) events.push({ ts: dispute.opened_at, kind: 'dispute opened', cents: 0 })
  if (state === 'SETTLED') {
    if (captured > 0) events.push({ ts: iso(b.settleTs), kind: 'captured', cents: captured })
    if (voided > 0) events.push({ ts: iso(b.settleTs), kind: 'voided', cents: voided })
    if (refunded > 0) events.push({ ts: iso(b.settleTs + 60_000), kind: 'refunded', cents: refunded })
    if (payout > 0) events.push({ ts: iso(b.settleTs + 5 * 60_000), kind: 'paid out', cents: payout })
    if (dispute) events.push({ ts: iso(b.settleTs), kind: 'dispute resolved', cents: 0 })
  }

  // Sampled check results: a few per skill check, failing in proportion to the units that failed (and more for the flaky bot).
  const failFrac = b.qty > 0 ? 1 - passed / b.qty : 0
  const checks: JobFacts['checks'] = []
  if (state === 'SETTLED') {
    for (const check of b.skill.checks) {
      const flaky = b.bot.name === FLAKY.bot && check === FLAKY.check
      for (let i = 0; i < Math.min(3, b.qty); i++) {
        const fail = rng.chance(Math.min(0.95, failFrac + (flaky ? FLAKY.failRate : 0)))
        checks.push({ check, status: fail ? 'fail' : 'pass', ts: iso(b.settleTs - 3_600_000) })
      }
    }
  }

  return {
    id: b.id,
    title: `${b.skill.title}${b.perUnit ? ` (${b.qty})` : ''}`,
    bot_id: b.bot.id,
    buyer: rng.pick(BUYERS),
    skill: b.skill.id,
    state,
    simulated: true,
    created_at: created,
    settled_at: state === 'SETTLED' ? iso(b.settleTs) : null,
    authorized,
    captured,
    voided,
    refunded,
    commission: comm,
    mediation: extra + sellerFee,
    kept,
    capture_fee,
    payout_fee,
    capture_fee_est,
    payout_fee_est,
    payout,
    held,
    units_expected: b.qty,
    units_passed: passed,
    below_min: belowMin,
    below_min_earned: belowMinEarned,
    settled_by,
    events,
    checks,
    dispute,
  }
}
