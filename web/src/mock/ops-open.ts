// Open jobs ("competitive mode") for the mock API: post_open_job, list_open_jobs, submit_bid, withdraw_bid, list_bids, award_bid.
// Compact on purpose: a few seeded open jobs, simulated bots that bid a few seconds after a post, and award via create_job.
import type { Bid, BotCard, JobSpec, OpenJob } from '../api/types'
import { emit } from './bus'
import type { Db } from './db'
import { IDS } from './db'
import { fail, requireUser, type Caller } from './logic'
import { handlers, register, type Ctx } from './registry'
import { amt, cents, HOUR, iso, parseDuration, rid, usd } from './util'

interface Stored {
  oj: OpenJob
  buyer: string
  bids: Bid[]
}
const KEY = 'open_jobs'

function store(db: Db): Record<string, Stored> {
  if (!db.scratch[KEY]) db.scratch[KEY] = seed(db)
  return db.scratch[KEY] as Record<string, Stored>
}

const listed = (db: Db) => Object.values(db.bots).filter((b) => b.status === 'listed')

function specFor(bot: BotCard, goal: string, qty: number, budget: number, context = ''): JobSpec {
  const s = bot.skills[0]
  return {
    skill_id: s.id,
    goal,
    deliverables: [{ id: 'D1', description: goal.slice(0, 200), quantity: qty, acceptance: s.checks.slice(0, 3).map((check) => ({ check, params: {} })), rubric: '' }],
    deadline: iso(Date.now() + 3 * 24 * HOUR),
    budget_cap: usd(budget),
    out_of_scope: [],
    context,
    context_artifact_ids: [],
  } as unknown as JobSpec
}

const EXTRA_INPUTS = [['logo_png'], ['category', 'short_pitch'], [], ['launch_date']]
const PITCHES = [
  'Done this exact job 14 times this month. Every unit comes with a screenshot and a live URL.',
  'Cheapest on the counter, same checks. I start the moment you fund.',
  'Slower, but I double-check every listing before I deliver it.',
  '',
]

function makeBid(db: Db, s: Stored, bot: BotCard, i: number): Bid {
  const oj = s.oj
  const skill = bot.skills.find((k) => k.id === oj.spec.skill_id) ?? bot.skills[0]
  const qty = oj.spec.deliverables.reduce((n, d) => n + d.quantity, 0)
  const cap = cents(oj.spec.budget_cap.value)
  const unit = Math.max(50, Math.round(cents(skill.pricing.price) * (1 - 0.12 * (i % 3))))
  const total = Math.max(500, Math.min(cap, skill.pricing.model === 'fixed' ? unit : unit * qty))
  const r = bot.reputation
  const verified = r.jobs_completed * 11
  const inputs = ['product_name', 'product_url', ...EXTRA_INPUTS[i % EXTRA_INPUTS.length]]
  const access = i % 2 === 0 ? [{ id: 'A1', kind: 'inbox_verification', why: 'Confirm sign-up emails.', scope: 'read-only, label:verify', required: true }] : []
  const assumptions = i === 1 ? ['Listings use the copy you provide, unedited.'] : []
  const questions = i === 2 ? [{ id: 'Q1', text: 'Any directories to skip?' }] : []
  const turnaround = skill.turnaround ?? 'PT48H'
  return {
    id: rid('bid', 12),
    open_job_id: oj.id,
    bot_id: bot.id,
    bot_name: bot.name,
    bot_tagline: bot.tagline,
    status: 'active',
    price: usd(total),
    turnaround,
    pitch: PITCHES[i % PITCHES.length],
    requirements: { inputs_schema: { type: 'object', properties: Object.fromEntries(inputs.map((n) => [n, { type: 'string' }])), required: inputs.slice(0, 2) }, access, assumptions, questions },
    quote: {
      lines: oj.spec.deliverables.map((d) => ({ deliverable_id: d.id, model: skill.pricing.model, unit_price: amt(skill.pricing.model === 'fixed' ? total : Math.round(total / qty)), quantity: d.quantity, max_total: amt(total) })),
      total_max: usd(total),
      turnaround,
      excludes: [],
      valid_until: iso(Date.now() + 2 * 24 * HOUR),
    },
    requirements_summary: { inputs, required_inputs: inputs.slice(0, 2), access: access.map((a) => ({ id: a.id, kind: a.kind, scope: a.scope, required: a.required })), questions: questions.length, assumptions },
    track_record: {
      jobs_settled: r.jobs_completed,
      jobs_funded: r.jobs_completed,
      verified_units: verified,
      units_checked: verified ? verified + Math.round(verified * 0.08) : 0,
      pass_rate: r.jobs_completed ? (r.avg_fulfilment ?? 0.9) : null,
      on_time_rate: r.jobs_completed ? r.on_time_rate : null,
      dispute_rate: r.jobs_completed ? r.dispute_rate : null,
      disputes: Math.round(r.jobs_completed * (r.dispute_rate ?? 0)),
    },
    created_at: new Date().toISOString(),
  } as unknown as Bid
}

/** Bidders: bots with the skill first, then any listed bot so the demo always has quotes to compare. */
function bidders(db: Db, skill: string, n: number): BotCard[] {
  const all = listed(db)
  return [...all.filter((b) => b.skills.some((s) => s.id === skill)), ...all.filter((b) => !b.skills.some((s) => s.id === skill))].slice(0, n)
}

function newOpenJob(db: Db, spec: JobSpec, title: string, award: OpenJob['award'], windowMs: number, created = Date.now()): OpenJob {
  return {
    id: rid('opn', 12),
    state: 'open',
    title,
    spec,
    category: null,
    award,
    bid_window: 'PT2H',
    bid_until: iso(created + windowMs),
    award_until: iso(created + windowMs + 24 * HOUR),
    bids_count: 0,
    matching_bots: Math.max(1, listed(db).filter((b) => b.skills.some((s) => s.id === spec.skill_id)).length),
    awarded_to: null,
    close_reason: null,
    created_at: iso(created),
    closed_at: null,
    policy: { class: 'standard', reasons: [] },
    awarded_bid_id: null,
    job_id: null,
  } as unknown as OpenJob
}

function seed(db: Db): Record<string, Stored> {
  const out: Record<string, Stored> = {}
  const bots = listed(db)
  if (!bots.length) return out
  const add = (bot: BotCard, buyer: string, title: string, qty: number, budget: number, award: OpenJob['award'], startedAgo: number, windowMs: number, nBids: number) => {
    const oj = newOpenJob(db, specFor(bot, title, qty, budget, buyer === IDS.orano ? 'ORANO is a personal AI assistant. Site: https://oranoai.com' : ''), title, award, windowMs, Date.now() - startedAgo)
    const s: Stored = { oj, buyer, bids: [] }
    s.bids = bidders(db, oj.spec.skill_id, nBids).map((b, i) => makeBid(db, s, b, i))
    oj.bids_count = s.bids.length
    out[oj.id] = s
    return s
  }
  const b0 = bots[0]
  const b1 = bots[1] ?? b0
  const b2 = bots[2] ?? b0
  add(b0, IDS.orano, 'List ORANO on 30 AI tool directories before launch', 30, 9000, 'manual', 48 * 60_000, 2 * HOUR, 3)
  add(b1, IDS.glob, 'Build a list of 50 seed-stage fintech founders with verified emails', 50, 6000, 'lowest_price', 102 * 60_000, 2 * HOUR, 1)
  add(b2, IDS.orano, 'Audit oranoai.com for agent readiness', 1, 2500, 'manual', 0, 24 * HOUR, 0)
  const done = add(b0, IDS.glob, 'Submit Glob Studio to 20 design directories', 20, 5000, 'best_record', 30 * HOUR, 2 * HOUR, 2)
  done.oj.state = 'awarded'
  done.oj.awarded_to = { bot_id: done.bids[0].bot_id, bot_name: done.bids[0].bot_name, price: done.bids[0].price }
  done.oj.closed_at = done.oj.bid_until
  done.bids[0].status = 'awarded'
  done.bids.slice(1).forEach((b) => (b.status = 'declined'))
  const gone = add(b1, IDS.orano, 'Find 25 podcasts that take founder guests', 25, 1500, 'manual', 3 * 24 * HOUR, HOUR, 0)
  gone.oj.state = 'expired'
  gone.oj.closed_at = gone.oj.bid_until
  gone.oj.close_reason = 'No bot bid before the window closed.'
  return out
}

const standing = (s: Stored) => s.bids.filter((b) => b.status === 'active')

function recommended(s: Stored) {
  const st = standing(s)
  const lowest = [...st].sort((a, b) => cents(a.price.value) - cents(b.price.value))[0]
  const score = (b: Bid) => (b.track_record.pass_rate ?? -1) * 1000 + b.track_record.verified_units
  const best = [...st].sort((a, b) => score(b) - score(a))[0]
  return { lowest_price: lowest?.id ?? null, best_record: best && best.track_record.pass_rate !== null ? best.id : null }
}

function view(s: Stored, caller: Caller): OpenJob {
  const count = standing(s).length + s.bids.filter((b) => b.status === 'awarded').length
  const oj = { ...s.oj, bids_count: count, matching_bots: Math.max(s.oj.matching_bots, s.bids.length) }
  if (caller.agent_id === s.buyer) return oj
  const { policy: _p, awarded_bid_id: _a, job_id: _j, context: _c, context_artifact_ids: _ca, ...pub } = oj
  void _p, _a, _j, _c, _ca
  return { ...pub, spec: { ...oj.spec, context: '', context_artifact_ids: [] } } as OpenJob
}

function doAward(db: Db, s: Stored, bid: Bid, ctx: Ctx) {
  const bot = db.bots[bid.bot_id]
  // mock only: filler bidders may lack the skill, so the job uses the winner's own skill
  const spec = bot.skills.some((k) => k.id === s.oj.spec.skill_id) ? s.oj.spec : { ...s.oj.spec, skill_id: bot.skills[0].id }
  const res = handlers.create_job({ bot_id: bot.id, spec, title: s.oj.title, idempotency_key: `award-${bid.id}` }, ctx) as { job: { id: string; origin?: unknown } }
  res.job.origin = { open_job_id: s.oj.id, bid_id: bid.id }
  s.oj.state = 'awarded'
  s.oj.awarded_to = { bot_id: bid.bot_id, bot_name: bid.bot_name, price: bid.price }
  s.oj.awarded_bid_id = bid.id
  s.oj.job_id = res.job.id as never
  s.oj.closed_at = new Date().toISOString()
  for (const b of s.bids) if (b.status === 'active') b.status = b.id === bid.id ? 'awarded' : 'declined'
  emit('bid_awarded', null, `${bid.bot_name} won "${s.oj.title}"`, { open_job_id: s.oj.id, bid_id: bid.id })
  emit('open_job_closed', null, `Open job closed: ${s.oj.title}`, { open_job_id: s.oj.id })
  return res
}

/** Close open jobs whose window passed: auto modes award, manual ones expire after award_until. */
function sweep(db: Db) {
  const now = Date.now()
  for (const s of Object.values(store(db))) {
    if (s.oj.state !== 'open' || now < Date.parse(s.oj.bid_until)) continue
    const st = standing(s)
    if (s.oj.award !== 'manual' && st.length) {
      const r = recommended(s)
      const pick = st.find((b) => b.id === (s.oj.award === 'lowest_price' ? r.lowest_price : (r.best_record ?? r.lowest_price)))!
      const owner = Object.values(db.users).find((u) => u.agent_id === s.buyer) ?? null
      doAward(db, s, pick, { db, caller: { user: owner, agent_id: s.buyer } })
    } else if (!st.length || now >= Date.parse(s.oj.award_until)) {
      s.oj.state = 'expired'
      s.oj.closed_at = new Date().toISOString()
      s.oj.close_reason = st.length ? 'The award window passed without an award.' : 'No bot bid before the window closed.'
    }
  }
}

function mine(db: Db, id: string, caller: Caller): Stored {
  requireUser(caller)
  const s = store(db)[id] ?? fail(404, 'not_found', `No open job ${id}.`, 'Call list_open_jobs to browse.')
  if (s.buyer !== caller.agent_id) fail(403, 'forbidden', 'Only the buyer who posted this open job can do that.', 'Use list_open_jobs mine=true for your own.')
  return s
}

export function registerOpenJobOps() {
  register('list_open_jobs', ({ query, skill, open_job_id, mine: onlyMine = false, status, limit = 20 }, { db, caller }) => {
    sweep(db)
    if (onlyMine) requireUser(caller)
    const st = status ?? (onlyMine || open_job_id ? 'all' : 'open')
    const q = String(query ?? '').toLowerCase().trim()
    const now = Date.now()
    const rows = Object.values(store(db))
      .filter((s) => !open_job_id || s.oj.id === open_job_id)
      .filter((s) => !onlyMine || s.buyer === caller.agent_id)
      .filter((s) => !skill || s.oj.spec.skill_id === skill)
      .filter((s) => !q || `${s.oj.title} ${s.oj.spec.goal}`.toLowerCase().includes(q))
      .filter((s) => {
        const open = s.oj.state === 'open' && now < Date.parse(s.oj.bid_until)
        return st === 'all' || (st === 'open' ? open : !open)
      })
      .sort((a, b) => Date.parse(b.oj.created_at) - Date.parse(a.oj.created_at))
      .slice(0, limit)
    return { open_jobs: rows.map((s) => view(s, caller)) }
  })

  register('post_open_job', ({ spec, title, bid_window = 'PT2H', award = 'manual' }, { db, caller }) => {
    const user = requireUser(caller)
    if (!caller.agent_id) fail(403, 'forbidden', `${user.name} has no buyer agent.`, 'Sign in as the buyer.')
    if (cents(spec?.budget_cap?.value ?? 0) < 500) fail(400, 'invalid_input', 'spec.budget_cap must be at least $5.00.', 'Raise the budget cap.')
    const ms = parseDuration(bid_window) || 2 * HOUR
    const oj = newOpenJob(db, { context: '', context_artifact_ids: [], out_of_scope: [], ...spec }, (title ?? spec.goal).slice(0, 140), award, ms)
    oj.bid_window = bid_window
    const s: Stored = { oj, buyer: caller.agent_id!, bids: [] }
    store(db)[oj.id] = s
    emit('open_job_posted', null, `New open job: ${oj.title}`, { open_job_id: oj.id })
    // simulated bots answer the post a few seconds later
    bidders(db, spec.skill_id, 3).forEach((bot, i) =>
      setTimeout(() => {
        if (s.oj.state !== 'open' || Date.now() >= Date.parse(s.oj.bid_until)) return
        const bid = makeBid(db, s, bot, i)
        s.bids.push(bid)
        emit('bid_received', null, `${bot.name} bid ${bid.price.value} USD`, { open_job_id: oj.id, bid_id: bid.id })
      }, 3500 + i * 4500),
    )
    return { open_job: view(s, caller), next_actions: [{ op: 'list_bids', why: 'Compare the bids as they arrive.', args: { open_job_id: oj.id } }] }
  })

  register('list_bids', ({ open_job_id }, { db, caller }) => {
    sweep(db)
    const s = mine(db, open_job_id, caller)
    const canAward = s.oj.state === 'open'
    return {
      open_job: view(s, caller),
      bids: s.bids,
      recommended: recommended(s),
      next_actions: canAward && standing(s).length ? [{ op: 'award_bid', why: 'Pick the bid you want.', args: { open_job_id, bid_id: recommended(s).lowest_price } }] : [],
    }
  })

  register('award_bid', ({ open_job_id, bid_id }, ctx) => {
    const { db, caller } = ctx
    const s = mine(db, open_job_id, caller)
    if (s.oj.state === 'awarded') {
      if (s.oj.awarded_bid_id !== bid_id) fail(409, 'invalid_state', 'This open job was already awarded to another bid.', 'Open the job it created.')
      const job = db.jobs[s.oj.job_id as string]
      return { job, your_role: 'buyer', next_actions: [], open_job: view(s, caller) }
    }
    if (s.oj.state !== 'open') fail(409, 'invalid_state', 'This open job is closed.', 'Repost it with post_open_job.')
    const bid = s.bids.find((b) => b.id === bid_id && b.status === 'active') ?? fail(404, 'not_found', `No standing bid ${bid_id}.`, 'Call list_bids.')
    const res = doAward(db, s, bid, ctx)
    return { ...(res as object), open_job: view(s, caller) }
  })

  register('submit_bid', ({ open_job_id, bot_id, requirements, quote, pitch = '' }, { db, caller }) => {
    requireUser(caller)
    const s = store(db)[open_job_id] ?? fail(404, 'not_found', `No open job ${open_job_id}.`)
    const bot = db.bots[bot_id] ?? fail(404, 'not_found', `No bot ${bot_id}.`)
    if (bot.operator_agent_id !== caller.agent_id) fail(403, 'forbidden', 'You can only bid with your own bots.')
    if (s.oj.state !== 'open' || Date.now() >= Date.parse(s.oj.bid_until)) fail(409, 'invalid_state', 'Bidding is closed.')
    if (s.bids.some((b) => b.bot_id === bot_id && b.status === 'active')) fail(409, 'conflict', 'This bot already has a standing bid.', 'withdraw_bid first.')
    const bid = makeBid(db, s, bot, s.bids.length)
    Object.assign(bid, { requirements, quote, price: quote.total_max, turnaround: quote.turnaround, pitch: String(pitch).slice(0, 500) })
    s.bids.push(bid)
    emit('bid_received', null, `${bot.name} bid`, { open_job_id, bid_id: bid.id })
    return { bid, open_job: view(s, caller), next_actions: [] }
  })

  register('withdraw_bid', ({ open_job_id, bid_id }, { db, caller }) => {
    requireUser(caller)
    const s = store(db)[open_job_id] ?? fail(404, 'not_found', `No open job ${open_job_id}.`)
    const bid = s.bids.find((b) => b.id === bid_id) ?? fail(404, 'not_found', `No bid ${bid_id}.`)
    if (db.bots[bid.bot_id]?.operator_agent_id !== caller.agent_id) fail(403, 'forbidden', 'Not your bid.')
    if (bid.status === 'active') bid.status = 'withdrawn'
    return { bid, next_actions: [] }
  })
}
