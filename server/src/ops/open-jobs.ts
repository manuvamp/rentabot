// Open-job operations: post, browse, bid, withdraw, compare, award. The state lives in core/open-jobs.ts; this file validates
// (specs and quotes exactly as create_job and send_quote do) and turns outcomes into results with next_actions.
import type { BotCard, NextAction } from '@rentabot/shared'
import { newId, durationMs, toAmount, toCents } from '../core/util.ts'
import { MIN_BID_WINDOW_MS, MAX_BID_WINDOW_MS, AWARD_GRACE, type BidRecord, type OpenJobRecord, type Viewer } from '../core/open-jobs.ts'
import type { Services } from '../core/services.ts'
import { OpError, type Handlers } from '../core/types.ts'
import { idempotent } from './common.ts'
import { quoteProblems } from './jobs.ts'

type H<N extends keyof Handlers> = Handlers[N]

export function openJobHandlers(s: Services) {
  const d = s.d
  const oj = s.openJobs

  const viewerOf = (rec: OpenJobRecord, actor: ReturnType<typeof d.actor> | null): Viewer => (!actor ? { kind: 'public' } : actor.agents.has(rec.buyer_agent_id) ? { kind: 'owner' } : { kind: 'agents', agents: actor.agents })

  const ownerOf = (rec: OpenJobRecord, actor: ReturnType<typeof d.actor>) => {
    // Strangers learn nothing about other buyers' bids.
    if (!actor.agents.has(rec.buyer_agent_id)) throw new OpError('forbidden', 'Only the buyer who posted this open job can see its bids and award it.', 'list_open_jobs shows the public board.')
  }

  const gone = (rec: OpenJobRecord): OpError =>
    new OpError('invalid_state', `This open job is ${rec.state}${rec.close_reason ? `: ${rec.close_reason}` : ''}`.slice(0, 300), 'list_open_jobs shows the jobs that still take bids.', rec.state === 'awarded' && rec.job_id ? [{ op: 'get_job', why: 'The award created this job.', args: { job_id: rec.job_id } }] : [{ op: 'list_open_jobs', why: 'Find a job that still takes bids.', args: { for_my_bots: true } }])

  // ---------- post ----------
  const post_open_job: H<'post_open_job'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    return d.withLock(`create:${actor.key}:${input.idempotency_key ?? newId('x')}`, async () => {
      const { result } = await idempotent(s, actor, 'post_open_job', input.idempotency_key, async () => {
        const spec = input.spec
        const ids = spec.deliverables.map((x) => x.id)
        if (new Set(ids).size !== ids.length) throw new OpError('invalid_input', 'Deliverable ids must be unique.', 'Number them D1, D2, …')
        const min = d.cfg.fees.min_settlement_cents
        if (toCents(spec.budget_cap.value) < min) throw new OpError('invalid_input', `budget_cap $${spec.budget_cap.value} is below the $${toAmount(min)} minimum job price.`, `Set budget_cap to at least $${toAmount(min)}: no job is settled for less.`)
        const windowMs = durationMs(input.bid_window)
        if (windowMs < MIN_BID_WINDOW_MS || windowMs > MAX_BID_WINDOW_MS) throw new OpError('invalid_input', `bid_window ${input.bid_window} is outside the allowed range.`, 'Use between PT5M and P14D, e.g. PT2H (the default) or P1D.')
        const now = d.nowMs()
        // A fast demo clock shortens the window, but never below the floor in real time (BID_WINDOW_FLOOR_MS, 5 min): a PT5M
        // window on a 60x clock was 5 seconds, so only in-process house bots could ever bid.
        const bid_until = new Date(now + Math.max(d.dur(input.bid_window), d.cfg.bidWindowFloorMs)).toISOString()
        if (Date.parse(spec.deadline) <= Date.parse(bid_until)) throw new OpError('invalid_input', 'spec.deadline must be after the bid window closes.', `Choose a deadline later than ${bid_until} plus the time the work needs.`)
        // Who could bid: listed bots with this skill that the buyer does not run.
        const probe = { spec, category: input.category ?? null, buyer_agent_id: actor.agent_id }
        const bots = oj.matchingBots(probe).filter((b) => !actor.agents.has(b.operator_agent_id))
        if (!bots.length) {
          const skills = [...new Set(d.db.all<{ data: string }>("SELECT data FROM bots WHERE status = 'listed'").flatMap((r) => (JSON.parse(r.data) as BotCard).skills.map((k) => k.id)))]
          throw new OpError('invalid_input', `No listed bot${input.category ? ` of class ${input.category}` : ''} has the skill ${spec.skill_id}, so nobody could bid.`, `Use a skill id that bots list: ${skills.slice(0, 12).join(', ') || 'none yet'}. search_bots shows them.`, [{ op: 'search_bots', why: 'See which skills bots offer.', args: {} }])
        }
        if (bots.some((b) => b.capability_class === 'security' || b.policy.requires_scope_proof))
          throw new OpError('invalid_input', 'Security and scope-proof work cannot be posted as an open job.', 'Hire the bot directly with create_job: it needs scope proof for the target before funding.')
        const known = new Set([...d.intel.checks.list().map((c) => c.id), ...bots.flatMap((b) => b.skills.filter((k) => k.id === spec.skill_id).flatMap((k) => k.checks))])
        const unknown = spec.deliverables.flatMap((x) => x.acceptance.map((t) => t.check)).filter((c) => !known.has(c))
        if (unknown.length) throw new OpError('invalid_input', `Unknown acceptance checks: ${[...new Set(unknown)].join(', ')}.`, 'Use checks from list_checks.')
        // The policy gate sees the spec as it would for a bot of the class the bidders have.
        const stand = { ...bots[0]!, name: 'Open job (every matching bot)', tagline: `Bids from the ${bots.length} bot(s) with the ${spec.skill_id} skill`, description: '' }
        const verdict = await d.intel.policy.reviewSpec(spec, stand)
        if (verdict.class === 'blocked') throw new OpError('policy_blocked', `The policy gate blocked this job: ${verdict.reasons.join('; ') || 'not allowed'}.`, 'Remove the blocked activity from the spec; PayPal’s Acceptable Use Policy and the law apply.')
        const stamp = d.nowIso()
        const rec: OpenJobRecord = {
          id: newId('opn'),
          state: 'open',
          title: (input.title ?? spec.goal).slice(0, 140),
          buyer_agent_id: actor.agent_id,
          spec,
          category: input.category ?? null,
          award: input.award,
          bid_window: input.bid_window,
          bid_until,
          award_until: input.award === 'manual' ? new Date(Date.parse(bid_until) + d.dur(AWARD_GRACE)).toISOString() : bid_until,
          policy: verdict,
          bids: [],
          awarded_bid_id: null,
          job_id: null,
          close_reason: null,
          closed_at: null,
          created_at: stamp,
          updated_at: stamp,
        }
        oj.save(rec)
        oj.announcePosted(rec)
        return { open_job_id: rec.id }
      })
      const rec = oj.load(result.open_job_id)
      return { open_job: oj.render(rec, { kind: 'owner' }), next_actions: oj.nextActionsForBuyer(rec) }
    })
  }

  // ---------- browse ----------
  const list_open_jobs: H<'list_open_jobs'> = async (ctx, input) => {
    const p = ctx.principal
    const actor = p.kind === 'public' ? null : d.actor(p)
    if ((input.mine || input.for_my_bots) && !actor) throw new OpError('unauthenticated', 'mine and for_my_bots need an API key.', 'Send "Authorization: Bearer <api key>", or call register_agent first.', [{ op: 'register_agent', why: 'Create an agent identity and get an API key.', args: {} }])
    const status = input.status ?? (input.mine || input.open_job_id ? 'all' : 'open')
    const words = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const myBots = actor ? d.db.all<{ data: string }>("SELECT data FROM bots WHERE status = 'listed'").map((r) => JSON.parse(r.data) as BotCard).filter((b) => actor.agents.has(b.operator_agent_id)) : []
    const out = []
    for (const rec of oj.all()) {
      if (input.open_job_id && rec.id !== input.open_job_id) continue
      if (input.mine && !actor!.agents.has(rec.buyer_agent_id)) continue
      const open = oj.biddingOpen(rec)
      if (status === 'open' && !open) continue
      if (status === 'closed' && open) continue
      if (input.skill && rec.spec.skill_id !== input.skill) continue
      if (input.category && rec.category !== input.category && !oj.matchingBots(rec).some((b) => b.capability_class === input.category)) continue
      if (words.length) {
        const hay = [rec.title, rec.spec.goal, rec.spec.skill_id, rec.category ?? '', ...rec.spec.deliverables.map((x) => x.description)].join(' ').toLowerCase()
        const hits = words.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)).length
        if (hits < Math.ceil(words.length / 2)) continue
      }
      if (input.for_my_bots) {
        // Only jobs one of my bots could bid on and has not bid on yet.
        if (!open || actor!.agents.has(rec.buyer_agent_id)) continue
        const mine = myBots.filter((b) => b.skills.some((k) => k.id === rec.spec.skill_id) && (!rec.category || b.capability_class === rec.category))
        if (!mine.some((b) => !rec.bids.some((x) => x.bot_id === b.id && x.status === 'active'))) continue
      }
      out.push(oj.render(rec, viewerOf(rec, actor)))
      if (out.length >= input.limit) break
    }
    return { open_jobs: out }
  }

  // ---------- bid ----------
  const submit_bid: H<'submit_bid'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    return d.withLock(`open:${input.open_job_id}`, async () => {
      const rec = oj.load(input.open_job_id)
      const bot = d.bot(input.bot_id)
      if (!bot || bot.status === 'delisted') throw new OpError('not_found', `Bot ${input.bot_id} not found.`, 'whoami lists the bots you operate.')
      if (!actor.agents.has(bot.operator_agent_id)) throw new OpError('forbidden', 'You can only bid with a bot you operate.', 'whoami lists the bots you operate.')
      if (actor.agents.has(rec.buyer_agent_id)) throw new OpError('forbidden', 'You cannot bid on your own open job.', 'Bid with a bot operated by another agent.')
      if (bot.status !== 'listed') throw new OpError('invalid_state', `${bot.name} is not listed right now.`, 'update_bot can list it again.')
      if (rec.state !== 'open') throw gone(rec)
      if (!oj.biddingOpen(rec)) throw new OpError('invalid_state', `Bidding closed at ${rec.bid_until}.`, 'list_open_jobs shows the jobs that still take bids.', [{ op: 'list_open_jobs', why: 'Find a job that still takes bids.', args: { for_my_bots: true } }])
      const skill = bot.skills.find((k) => k.id === rec.spec.skill_id)
      if (!skill) throw new OpError('invalid_input', `${bot.name} has no skill ${rec.spec.skill_id}.`, `This job needs the skill ${rec.spec.skill_id}; your bot has: ${bot.skills.map((k) => k.id).join(', ')}.`)
      if (rec.category && bot.capability_class !== rec.category) throw new OpError('invalid_input', `This job is for ${rec.category} bots; ${bot.name} is ${bot.capability_class}.`, 'Bid with a bot of that class.')
      if (rec.bids.some((b) => b.bot_id === bot.id && b.status === 'active')) throw new OpError('invalid_state', `${bot.name} already has a standing bid on this job.`, 'withdraw_bid first if you want to change it.', [{ op: 'withdraw_bid', why: 'Withdraw the standing bid, then bid again.', args: { open_job_id: rec.id, bid_id: rec.bids.find((b) => b.bot_id === bot.id && b.status === 'active')!.id } }])
      // Checks the bot cannot promise would make the bid unfulfillable.
      const unsupported = [...new Set(rec.spec.deliverables.flatMap((x) => x.acceptance.map((t) => t.check)).filter((c) => !skill.checks.includes(c)))]
      if (unsupported.length) throw new OpError('invalid_input', `The job requires checks your skill does not support: ${unsupported.join(', ')}.`, `Your skill ${skill.id} supports: ${skill.checks.join(', ')}. Skip this job.`)
      const problem = quoteProblems(input.quote, rec)
      if (problem) throw new OpError('invalid_input', `Bid rejected: ${problem}.`, 'One line per deliverable, quantities as in the spec, total_max = sum of max_total.')
      const total = toCents(input.quote.total_max.value)
      const min = d.cfg.fees.min_settlement_cents
      if (total < min) throw new OpError('invalid_input', `Bid rejected: total_max $${input.quote.total_max.value} is below the $${toAmount(min)} minimum job price.`, `Quote at least $${toAmount(min)}.`)
      if (total > toCents(rec.spec.budget_cap.value)) throw new OpError('invalid_input', `Bid rejected: total_max $${input.quote.total_max.value} is above the buyer's budget cap $${rec.spec.budget_cap.value}.`, 'Quote within the cap (fewer units, or skip this job).')
      if (Date.parse(input.quote.valid_until) < Math.max(d.nowMs(), Date.parse(rec.award_until))) throw new OpError('invalid_input', `valid_until must stay valid until the buyer can award (${rec.award_until}).`, 'Give the quote a later valid_until.')
      const stamp = d.nowIso()
      const bid: BidRecord = { id: newId('bid'), bot_id: bot.id, agent_id: bot.operator_agent_id, requirements: input.requirements, quote: input.quote, pitch: input.pitch.trim(), status: 'active', created_at: stamp, updated_at: stamp }
      rec.bids.push(bid)
      oj.save(rec)
      oj.announceBid(rec, bid, 'active')
      const next: NextAction[] = [
        { op: 'wait_for_events', why: 'Wait for the award: bid_awarded opens a normal job for you; bid_declined means another bid won.', args: { after_cursor: d.bus.latestCursor(), types: ['bid_awarded', 'bid_declined', 'open_job_closed'] } },
        { op: 'withdraw_bid', why: 'Take the bid back before the award.', args: { open_job_id: rec.id, bid_id: bid.id } },
      ]
      return { bid: oj.renderBid(rec, bid), open_job: oj.render(rec, { kind: 'agents', agents: actor.agents }), next_actions: next }
    })
  }

  const withdraw_bid: H<'withdraw_bid'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    return d.withLock(`open:${input.open_job_id}`, async () => {
      const rec = oj.load(input.open_job_id)
      const bid = rec.bids.find((b) => b.id === input.bid_id)
      if (!bid || !actor.agents.has(bid.agent_id)) throw new OpError('not_found', `Bid ${input.bid_id} not found.`, 'It is returned by submit_bid.')
      const next: NextAction[] = [{ op: 'list_open_jobs', why: 'Find other jobs to bid on.', args: { for_my_bots: true } }]
      if (bid.status === 'withdrawn') return { bid: oj.renderBid(rec, bid), next_actions: next }
      if (bid.status !== 'active' || rec.state !== 'open') throw new OpError('invalid_state', `The bid is ${bid.status}; it can only be withdrawn while the job is open.`, 'Read the result with list_open_jobs open_job_id=…')
      bid.status = 'withdrawn'
      bid.updated_at = d.nowIso()
      oj.save(rec)
      oj.announceBid(rec, bid, 'withdrawn')
      return { bid: oj.renderBid(rec, bid), next_actions: next }
    })
  }

  // ---------- buyer ----------
  const list_bids: H<'list_bids'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    const rec = oj.load(input.open_job_id)
    ownerOf(rec, actor)
    const records = oj.records()
    const standing = oj.awardable(rec)
    return {
      open_job: oj.render(rec, { kind: 'owner' }),
      bids: rec.bids.map((b) => oj.renderBid(rec, b, records)),
      recommended: { lowest_price: oj.byPrice(standing)[0]?.id ?? null, best_record: oj.byRecord(standing, records)[0]?.id ?? null },
      next_actions: oj.nextActionsForBuyer(rec),
    }
  }

  const award_bid: H<'award_bid'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    return d.withLock(`open:${input.open_job_id}`, async () => {
      const rec = oj.load(input.open_job_id)
      ownerOf(rec, actor)
      if (rec.state === 'awarded') {
        // Idempotent: the same bid again returns the same job; another bid is too late.
        if (rec.awarded_bid_id !== input.bid_id) throw new OpError('invalid_state', 'This open job was already awarded to a different bid.', 'get_job on its job_id continues the awarded job.', [{ op: 'get_job', why: 'The awarded job.', args: { job_id: rec.job_id } }])
        return { ...d.result(d.load(rec.job_id!), 'buyer'), open_job: oj.render(rec, { kind: 'owner' }) }
      }
      if (rec.state !== 'open') throw gone(rec)
      const bid = rec.bids.find((b) => b.id === input.bid_id)
      if (!bid) throw new OpError('not_found', `Bid ${input.bid_id} not found on this open job.`, 'list_bids shows the bids.', [{ op: 'list_bids', why: 'The bids on this job.', args: { open_job_id: rec.id } }])
      if (bid.status !== 'active') throw new OpError('invalid_state', `That bid is ${bid.status}.`, 'Award a standing bid from list_bids.', [{ op: 'list_bids', why: 'The bids on this job.', args: { open_job_id: rec.id } }])
      if (d.nowMs() > Date.parse(rec.award_until)) throw new OpError('invalid_state', `The time to award this job ended at ${rec.award_until}.`, 'Post it again with post_open_job.')
      const job = await oj.awardLocked(rec, bid, 'buyer')
      return { ...d.result(job, 'buyer'), open_job: oj.render(rec, { kind: 'owner' }) }
    })
  }

  return { post_open_job, list_open_jobs, submit_bid, withdraw_bid, list_bids, award_bid }
}
