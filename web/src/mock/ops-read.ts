// Read-only and account handlers for the mock API.
import type { BotCard, Job, Message } from '../api/types'
import { subscribe, eventLog, currentCursor } from './bus'
import { fail, needsAction, nextActions, pendingQuestions, requireJob, requireUser, roleOf, summary } from './logic'
import { register } from './registry'
import { amt, cents } from './util'

const toSummary = (b: BotCard) => ({
  id: b.id,
  name: b.name,
  tagline: b.tagline,
  capability_class: b.capability_class,
  mode: b.mode,
  reputation: b.reputation,
  passport: b.passport,
  skills: b.skills.map((s) => ({ id: s.id, title: s.title, pricing: s.pricing, turnaround: s.turnaround, checks: s.checks, brief: s.brief })),
})

export function registerReadOps() {
  register('search_bots', ({ query, capability_class, skill, max_unit_price, mode, limit = 25 }, { db }) => {
    const q = String(query ?? '').toLowerCase().trim()
    const bots = Object.values(db.bots)
      .filter((b) => b.status === 'listed')
      .filter((b) => !capability_class || b.capability_class === capability_class)
      .filter((b) => !mode || b.mode === mode)
      .filter((b) => !skill || b.skills.some((s) => s.id === skill))
      .filter((b) => !max_unit_price || b.skills.some((s) => Number(s.pricing.price) <= Number(max_unit_price)))
      .filter((b) => !q || `${b.name} ${b.tagline} ${b.description} ${b.skills.map((s) => s.title + s.description).join(' ')}`.toLowerCase().includes(q))
    return { bots: bots.slice(0, limit).map(toSummary), total: bots.length }
  })

  register('get_bot', ({ bot_id }, { db }) => ({ bot: db.bots[bot_id] ?? fail(404, 'not_found', `No bot ${bot_id}.`, 'Call search_bots to find bots.') }))

  register('list_checks', (_i, { db }) => ({ checks: db.checks }))

  register('whoami', (_i, { db, caller }) => {
    const user = requireUser(caller)
    const agent = caller.agent_id ? db.agents[caller.agent_id] : undefined
    if (!agent) {
      // the arbiter has no agent: return a placeholder profile so the call still works
      return {
        agent: { id: 'agt_ArbiterHuman1', name: user.name, description: 'Human arbiter', owner_id: user.id, claimed: true, payout_email: null, created_at: new Date().toISOString() },
        owner: { id: user.id, name: user.name },
        mandate: null,
        bots: [],
        jobs: { as_buyer_open: 0, as_seller_open: 0, needs_your_action: Object.values(db.jobs).filter((j) => j.state === 'APPEALED').length },
        payment_rail: db.rail,
        next_actions: [],
      }
    }
    const jobs = Object.values(db.jobs)
    const open = (j: Job) => !['SETTLED', 'CANCELLED', 'EXPIRED'].includes(j.state)
    return {
      agent,
      owner: agent.owner_id ? { id: agent.owner_id, name: db.users[agent.owner_id]?.name ?? 'Owner' } : null,
      mandate: db.mandates[agent.id] ?? null,
      bots: Object.values(db.bots).filter((b) => b.operator_agent_id === agent.id && b.status === 'listed').map(toSummary),
      jobs: {
        as_buyer_open: jobs.filter((j) => j.buyer_agent_id === agent.id && open(j)).length,
        as_seller_open: jobs.filter((j) => j.seller_agent_id === agent.id && open(j)).length,
        needs_your_action: jobs.filter((j) => {
          const r = roleOf(j, caller)
          return r && needsAction(db, j, r)
        }).length,
      },
      payment_rail: db.rail,
      next_actions: db.mandates[agent.id]?.status === 'active' ? [] : [{ op: 'request_mandate', why: 'Ask your owner for a spending mandate so you can fund jobs without approving each one.', args: {} }],
    }
  })

  register('get_mandate', (_i, { db, caller }) => {
    requireUser(caller)
    return { mandate: caller.agent_id ? (db.mandates[caller.agent_id] ?? null) : null }
  })

  register('get_job', ({ job_id }, { db, caller }) => {
    const { job, role } = requireJob(db, job_id, caller)
    return { job, your_role: role, next_actions: nextActions(db, job, role) }
  })

  register('list_jobs', ({ role, state, needs_action = false, limit = 20 }, { db, caller }) => {
    requireUser(caller)
    const rows = Object.values(db.jobs)
      .map((j) => ({ j, r: roleOf(j, caller) }))
      .filter((x): x is { j: Job; r: NonNullable<typeof x.r> } => x.r !== null)
      // arbiters only see the appeals queue
      .filter((x) => x.r !== 'arbiter' || x.j.state === 'APPEALED')
      .filter((x) => !role || x.r === role)
      .filter((x) => !state || x.j.state === state)
      .filter((x) => !needs_action || needsAction(db, x.j, x.r))
      .sort((a, b) => {
        const na = needsAction(db, a.j, a.r) ? 0 : 1
        const nb = needsAction(db, b.j, b.r) ? 0 : 1
        return na - nb || b.j.updated_at.localeCompare(a.j.updated_at)
      })
      .slice(0, limit)
    return { jobs: rows.map((x) => summary(db, x.j, x.r)) }
  })

  register('get_messages', ({ job_id, after_seq = -1, limit = 50 }, { db, caller }) => {
    const { job } = requireJob(db, job_id, caller)
    const msgs: Message[] = (db.messages[job.id] ?? []).filter((m) => m.seq > after_seq).slice(0, limit)
    return { messages: msgs, chain_valid: true }
  })

  // public: seller track records from the mock jobs (the server computes the same columns from its ledger)
  register('get_leaderboard', ({ sort_by = 'verified_units', limit = 20 }, { db }) => {
    const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null)
    const rows = Object.values(db.bots)
      .filter((b) => b.status === 'listed')
      .map((b) => {
        const mine = Object.values(db.jobs).filter((j) => j.seller_bot_id === b.id)
        const funded = mine.filter((j) => !['none', 'pending_approval'].includes(j.escrow.status))
        const passed = mine.reduce((s, j) => s + j.fulfilment.reduce((a, f) => a + f.passed_units, 0), 0)
        const failed = mine.reduce((s, j) => s + j.fulfilment.reduce((a, f) => a + f.failed_units, 0), 0)
        const disputed = mine.filter((j) => j.mediation)
        const agreed = disputed.filter((j) => j.mediation?.agreed_proposal_id).length
        return {
          bot_id: b.id, name: b.name, tagline: b.tagline, mode: b.mode,
          jobs_settled: mine.filter((j) => j.state === 'SETTLED').length, jobs_funded: funded.length,
          verified_units: passed, units_checked: passed + failed, pass_rate: ratio(passed, passed + failed),
          on_time_rate: b.reputation.on_time_rate, dispute_rate: ratio(disputed.length, funded.length),
          disputes: disputed.length, settled_by_agreement: agreed, agreement_share: ratio(agreed, disputed.length),
          released: amt(mine.reduce((s, j) => s + cents(j.escrow.captured.value), 0)),
        }
      })
    const val = (r: (typeof rows)[number]): number | null => (sort_by === 'released' ? Number(r.released) : ((r as Record<string, unknown>)[sort_by === 'agreement_share' ? 'agreement_share' : sort_by] as number | null))
    const dir = sort_by === 'dispute_rate' ? 1 : -1
    rows.sort((a, b) => {
      const x = val(a), y = val(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
      return x === y ? b.verified_units - a.verified_units : (x - y) * dir
    })
    return { sort_by, payment_rail: db.rail, rows: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })) }
  })

  register('get_escrow', ({ job_id }, { db, caller }) => ({ escrow: requireJob(db, job_id, caller).job.escrow }))

  register('get_ruling', ({ job_id }, { db, caller }) => ({ ruling: requireJob(db, job_id, caller).job.ruling }))

  // arbiter only: commission and mediation fees earned minus the PayPal fees (mock: 3.49% + $0.49 per capture, $0.25 per payout)
  register('get_platform_ledger', ({ limit = 100 }, { db, caller }) => {
    const user = requireUser(caller)
    if (user.role !== 'arbiter') fail(403, 'forbidden', 'Only a human arbiter can read the platform ledger.', 'Sign in as the Arbiter.')
    const lines = Object.values(db.jobs)
      .filter((j) => cents(j.escrow.captured.value) > 0)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map((j) => {
        const captured = cents(j.escrow.captured.value)
        const commission = cents(j.escrow.fees.value)
        const mediation = j.mediation && j.contract ? cents(j.contract.fees.mediation_flat) : 0
        const captureFee = Math.round(captured * 0.0349) + 49 * Math.max(j.escrow.paypal.capture_ids.length, 1)
        const payoutFee = 25 * j.escrow.paypal.payout_item_ids.length
        return { job_id: j.id, title: j.title, state: j.state, captured, commission, mediation, captureFee, payoutFee }
      })
    const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((a, l) => a + f(l), 0)
    const net = (l: { commission: number; mediation: number; captureFee: number; payoutFee: number }) => l.commission + l.mediation - l.captureFee - l.payoutFee
    return {
      currency: 'USD' as const,
      totals: {
        jobs: lines.length,
        captured: amt(sum((l) => l.captured)),
        commission: amt(sum((l) => l.commission)),
        mediation_fees: amt(sum((l) => l.mediation)),
        refund_fees_kept: amt(0),
        paypal_capture_fees: amt(sum((l) => l.captureFee)),
        paypal_payout_fees: amt(sum((l) => l.payoutFee)),
        net: amt(sum(net)),
      },
      jobs: lines.map((l) => ({ job_id: l.job_id, title: l.title, state: l.state, captured: amt(l.captured), commission: amt(l.commission), mediation_fees: amt(l.mediation), refund_fees_kept: amt(0), paypal_capture_fees: amt(l.captureFee), paypal_payout_fees: amt(l.payoutFee), net: amt(net(l)) })),
    }
  })

  register('wait_for_events', async ({ job_id, after_cursor = 0, timeout_seconds = 25, types }, { db, caller }) => {
    requireUser(caller)
    if (job_id) requireJob(db, job_id, caller)
    const pick = () => eventLog().filter((e) => e.cursor > after_cursor && (!job_id || e.job_id === job_id) && (!types || types.includes(e.type)))
    let events = pick()
    if (!events.length && timeout_seconds > 0) {
      await new Promise<void>((resolve) => {
        const off = subscribe(job_id ?? null, () => {
          off()
          clearTimeout(t)
          resolve()
        })
        const t = setTimeout(() => {
          off()
          resolve()
        }, Math.min(timeout_seconds, 4) * 1000)
      })
      events = pick()
    }
    return { events, cursor: events.length ? events[events.length - 1].cursor : Math.max(after_cursor, currentCursor()), timed_out: events.length === 0 }
  })

  void pendingQuestions
}
