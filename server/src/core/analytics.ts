// Platform analytics for the AG Studio dashboard (/ops/studio): the ledger as flat tables.
// Every money column comes from the same code as get_platform_ledger (jobPnl, the JobRecord's own escrow figures) and the
// estimates from fees.ts, so the dashboard and the Ops P&L table can never disagree. In demo mode, labelled simulated
// history jobs (analytics-demo.ts) are added to the live jobs so the dashboard has weeks of data.
import type { BotCard, CheckResult } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { Domain } from './domain.ts'
import { estimatedCaptureFee } from './fees.ts'
import { demoHistory } from './analytics-demo.ts'
import { heldCents, type JobRecord } from './model.ts'
import { jobPnl } from './stats.ts'
import { toCents } from './util.ts'

export type SettledBy = 'agreement' | 'arbiter' | 'ruling' | 'checks' | 'none'

/** One job as the analytics tables need it, in integer cents. Live jobs and simulated history both become this. */
export interface JobFacts {
  id: string
  title: string
  bot_id: string
  buyer: string
  skill: string
  state: string
  simulated: boolean
  created_at: string
  settled_at: string | null
  authorized: number
  captured: number
  voided: number
  refunded: number
  commission: number
  mediation: number
  kept: number
  capture_fee: number
  payout_fee: number
  capture_fee_est: number
  payout_fee_est: number
  payout: number
  held: number
  units_expected: number
  units_passed: number
  /** A capture that would have been under the $5 minimum settlement was voided instead. */
  below_min: boolean
  /** What the passing units earned, when that was under the minimum and so never captured. */
  below_min_earned: number
  settled_by: SettledBy
  events: { ts: string; kind: string; cents: number }[]
  checks: { check: string; status: 'pass' | 'fail' | 'pending' | 'error'; ts: string }[]
  dispute: null | {
    opened_at: string
    closed_at: string | null
    rounds: number
    opened_by: string
    flags: number
    proposals: { round: number; by: string; kind: string; status: string; release_cents: number }[]
  }
}

export interface BotFacts {
  id: string
  name: string
  capability_class: string
}

export type Row = Record<string, string | number | boolean | null>

export interface AnalyticsTables {
  jobs: Row[]
  events: Row[]
  disputes: Row[]
  proposals: Row[]
  funnel: Row[]
  bots: Row[]
  checks: Row[]
}

const usd = (cents: number) => Math.round(cents) / 100
const day = (iso: string) => iso.slice(0, 10)
const EVENT_KINDS: Record<string, string> = {
  authorized: 'authorized',
  reauthorized: 'authorized',
  captured: 'captured',
  voided: 'voided',
  refunded: 'refunded',
  payout_succeeded: 'paid out',
  dispute_opened: 'dispute opened',
  dispute_resolved: 'dispute resolved',
}

/** A live JobRecord as JobFacts. Figures are the record's own; estimates use the job's frozen fee terms. */
export function factsOfRecord(d: Domain, rec: JobRecord, checks: CheckResult[]): JobFacts {
  const e = rec.escrow
  const p = jobPnl(rec)
  const policy = d.feePolicy(rec)
  const med = rec.mediation
  const agreed = !!med?.state.agreed_proposal_id
  const settled_by: SettledBy = rec.state !== 'SETTLED' ? 'none' : agreed ? 'agreement' : rec.appeal || rec.ruling?.decided_by.startsWith('arbiter') ? 'arbiter' : rec.ruling && rec.ruling.decided_by !== 'checks' ? 'ruling' : 'checks'
  const earned = rec.earned_cents
  const below_min = earned > 0 && earned < policy.min_settlement_cents && e.captured === 0 && e.voided > 0
  return {
    id: rec.id,
    title: rec.title,
    bot_id: rec.seller_bot_id,
    buyer: d.agent(rec.buyer_agent_id)?.name ?? rec.buyer_agent_id,
    skill: rec.skill_id,
    state: rec.state,
    simulated: false,
    created_at: rec.created_at,
    settled_at: rec.settled_at,
    authorized: e.authorized,
    captured: e.captured,
    voided: e.voided,
    refunded: e.refunded,
    commission: p.commission,
    mediation: p.mediation,
    kept: p.kept,
    capture_fee: p.capture_fee,
    payout_fee: p.payout_fee,
    capture_fee_est: estimatedCaptureFee(e.captured, policy),
    payout_fee_est: e.paid_out > 0 || e.payout_requested > 0 ? policy.paypal_payout_cents : 0,
    payout: e.paid_out,
    held: heldCents(e),
    units_expected: rec.fulfilment.reduce((s, f) => s + f.expected_units, 0),
    units_passed: rec.fulfilment.reduce((s, f) => s + f.passed_units, 0),
    below_min,
    below_min_earned: below_min ? earned : 0,
    settled_by,
    events: e.events
      .filter((x) => EVENT_KINDS[x.kind])
      .map((x) => ({ ts: x.ts, kind: EVENT_KINDS[x.kind]!, cents: x.amount ? toCents(x.amount.value) : 0 })),
    checks: latestChecks(checks).map((c) => ({ check: c.check, status: c.status, ts: c.ran_at })),
    dispute: med
      ? {
          opened_at: med.opened_at,
          closed_at: med.closed_at,
          rounds: med.state.round,
          opened_by: med.opened_by,
          flags: med.state.assessment?.integrity_flags.length ?? 0,
          proposals: med.state.proposals.map((x) => ({ round: x.round, by: x.by, kind: x.kind, status: x.status, release_cents: toCents(x.terms.release_now ?? '0.00') })),
        }
      : null,
  }
}

/** The last attempt of every (deliverable, unit, check). */
function latestChecks(all: CheckResult[]): CheckResult[] {
  const by = new Map<string, CheckResult>()
  for (const c of all) {
    const k = `${c.deliverable_id}|${c.unit_ref ?? ''}|${c.check}`
    const cur = by.get(k)
    if (!cur || c.attempt >= cur.attempt) by.set(k, c)
  }
  return [...by.values()]
}

/** The facts for every funded job on this server (newest first), plus the bot list. Optionally with the simulated history. */
export function collectFacts(d: Domain, opts: { includeSimulated: boolean }): { facts: JobFacts[]; bots: BotFacts[]; live: number; simulated: number } {
  const recs = d.db.all<{ data: string }>('SELECT data FROM jobs').map((r) => json<JobRecord>(r.data)).filter((j) => j.escrow.authorized > 0 || j.escrow.captured > 0)
  const checksByJob = new Map<string, CheckResult[]>()
  for (const r of d.db.all<{ job_id: string; data: string }>('SELECT job_id, data FROM check_results')) {
    const list = checksByJob.get(r.job_id) ?? []
    list.push(json<CheckResult>(r.data))
    checksByJob.set(r.job_id, list)
  }
  const live = recs.map((j) => factsOfRecord(d, j, checksByJob.get(j.id) ?? []))
  const botCards = d.db.all<{ data: string }>('SELECT data FROM bots').map((r) => json<BotCard>(r.data))
  const bots = botCards.map((b) => ({ id: b.id, name: b.name, capability_class: b.capability_class }))
  const simulated = opts.includeSimulated && d.cfg.demoMode ? demoHistory({ now: d.nowMs(), bots: botCards, policy: d.cfg.fees, mediationFlatCents: toCents(d.cfg.mediationFlat) }) : []
  const facts = [...live, ...simulated].sort((a, b) => (b.settled_at ?? b.created_at).localeCompare(a.settled_at ?? a.created_at))
  return { facts, bots, live: live.length, simulated: simulated.length }
}

/**
 * Who may read platform-wide figures: the arbiter always; the owner persona only in demo mode (the demo sign-in has no
 * arbiter-only path to a dashboard, but a production owner is just a customer and must never see the platform's margins).
 */
export function canViewPlatformAnalytics(roles: readonly string[], persona: string | null | undefined, demoMode: boolean): boolean {
  return roles.includes('arbiter') || (demoMode && persona === 'owner')
}

/** The op's output: live jobs, plus the labelled simulated history in demo mode. */
export function platformAnalytics(d: Domain, includeSimulated: boolean) {
  const { facts, bots, live, simulated } = collectFacts(d, { includeSimulated })
  return { currency: 'USD' as const, generated_at: d.nowIso(), simulated_jobs: simulated, live_jobs: live, tables: toTables(facts, bots, new Map(bots.map((b) => [b.id, b.name]))) }
}

/** The seven tables. Dates are ISO strings; money is USD numbers. */
export function toTables(facts: JobFacts[], bots: BotFacts[], botNames: Map<string, string>): AnalyticsTables {
  const t: AnalyticsTables = { jobs: [], events: [], disputes: [], proposals: [], funnel: [], bots: [], checks: [] }
  const botAgg = new Map<string, { jobs: number; settled: number; expected: number; passed: number; disputes: number; arbiter: number; net: number; captured: number }>()
  for (const b of bots) botAgg.set(b.id, { jobs: 0, settled: 0, expected: 0, passed: 0, disputes: 0, arbiter: 0, net: 0, captured: 0 })
  const bot = (id: string) => botNames.get(id) ?? id

  for (const j of facts) {
    const fees = j.capture_fee + j.payout_fee
    const fees_est = j.capture_fee_est + j.payout_fee_est
    const net = j.commission + j.mediation + j.kept - fees
    const when = j.settled_at ?? j.created_at
    const disputed = !!j.dispute
    t.jobs.push({
      job_id: j.id,
      title: j.title,
      bot_id: j.bot_id,
      bot: bot(j.bot_id),
      buyer: j.buyer,
      skill: j.skill,
      state: j.state,
      simulated: j.simulated,
      date: day(when),
      created_on: day(j.created_at),
      authorized: usd(j.authorized),
      captured: usd(j.captured),
      voided: usd(j.voided),
      refunded: usd(j.refunded),
      held_now: usd(j.held),
      commission: usd(j.commission),
      mediation_fees: usd(j.mediation),
      refund_fees_kept: usd(j.kept),
      paypal_capture_fee: usd(j.capture_fee),
      paypal_payout_fee: usd(j.payout_fee),
      paypal_fees: usd(fees),
      paypal_fees_est: usd(fees_est),
      fee_variance: usd(fees - fees_est),
      seller_payout: usd(j.payout),
      platform_net: usd(net),
      loss_making: net < 0,
      disputed,
      dispute_count: disputed ? 1 : 0,
      agreement_count: j.settled_by === 'agreement' ? 1 : 0,
      arbiter_count: j.settled_by === 'arbiter' ? 1 : 0,
      below_minimum_void: j.below_min,
      earned_not_captured: usd(j.below_min_earned),
      settled_by: j.settled_by,
      units_expected: j.units_expected,
      units_passed: j.units_passed,
    })
    const a = botAgg.get(j.bot_id)
    if (a) {
      a.jobs += 1
      if (j.state === 'SETTLED') a.settled += 1
      a.expected += j.units_expected
      a.passed += j.units_passed
      a.disputes += disputed ? 1 : 0
      a.arbiter += j.settled_by === 'arbiter' ? 1 : 0
      a.net += net
      a.captured += j.captured
    }
    j.events.forEach((e, i) =>
      t.events.push({ event_id: `${j.id}:${i}`, job_id: j.id, bot: bot(j.bot_id), ts: e.ts, date: day(e.ts), kind: e.kind, amount: usd(e.cents), simulated: j.simulated }),
    )
    j.checks.forEach((c, i) =>
      t.checks.push({
        check_id: `${j.id}:${i}`,
        job_id: j.id,
        bot_id: j.bot_id,
        bot: bot(j.bot_id),
        check: c.check,
        status: c.status,
        date: day(c.ts),
        total: 1,
        passed: c.status === 'pass' ? 1 : 0,
        failed: c.status === 'fail' || c.status === 'error' ? 1 : 0,
        simulated: j.simulated,
      }),
    )
    if (j.dispute) {
      const dp = j.dispute
      const minutes = dp.closed_at ? Math.round((Date.parse(dp.closed_at) - Date.parse(dp.opened_at)) / 60_000) : null
      const outcome = j.settled_by === 'none' ? 'open' : j.settled_by
      t.disputes.push({ dispute_id: `${j.id}:d`, job_id: j.id, bot: bot(j.bot_id), opened_at: dp.opened_at, date: day(dp.opened_at), opened_by: dp.opened_by, rounds: dp.rounds, proposals: dp.proposals.length, outcome, minutes_to_close: minutes, integrity_flags: dp.flags, simulated: j.simulated })
      dp.proposals.forEach((p, i) =>
        t.proposals.push({ proposal_id: `${j.id}:p${i}`, job_id: j.id, round: p.round, kind: p.kind, by: p.by, status: p.status, release_now: usd(p.release_cents), outcome, simulated: j.simulated }),
      )
      const stages: [number, string][] = [[1, 'Opened']]
      if (dp.proposals.length) stages.push([2, 'Mediator proposed'])
      if (dp.proposals.some((p) => p.by !== 'mediator') || dp.rounds > 1) stages.push([3, 'Countered or re-proposed'])
      if (j.settled_by === 'agreement') stages.push([4, 'Agreed'])
      if (j.settled_by === 'arbiter' || j.settled_by === 'ruling') stages.push([5, 'Ruling'])
      for (const [no, name] of stages) t.funnel.push({ funnel_id: `${j.id}:${no}`, job_id: j.id, stage_no: no, stage: `${no}. ${name}`, simulated: j.simulated })
    }
  }
  for (const b of bots) {
    const a = botAgg.get(b.id)!
    t.bots.push({ bot_id: b.id, name: b.name, capability_class: b.capability_class, jobs: a.jobs, settled: a.settled, units_expected: a.expected, units_passed: a.passed, disputes: a.disputes, arbiter_rulings: a.arbiter, captured: usd(a.captured), platform_net: usd(a.net) })
  }
  return t
}
