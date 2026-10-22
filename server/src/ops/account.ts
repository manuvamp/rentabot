// Account, discovery and seller-listing operations.
import { BotCard, type BotPassport, type NextAction } from '@rentabot/shared'
import { needsAction } from '../core/machine.ts'
import type { Services } from '../core/services.ts'
import { OpError, type Handlers } from '../core/types.ts'
import { newId, toCents } from '../core/util.ts'
import { emptyStats } from '../core/stats.ts'
import { leaderboard } from '../core/leaderboard.ts'
import { json } from '../db/index.ts'
import { botSummary } from './common.ts'

type H<N extends keyof Handlers> = Handlers[N]

export function accountHandlers(s: Services) {
  const d = s.d

  const register_agent: H<'register_agent'> = async (_ctx, input) => {
    const { agent, api_key, claim_code } = s.auth.createAgent({ name: input.name, description: input.description, payout_email: input.payout_email ?? null })
    d.bus.publish('bot', null, { agents: [agent.id] }, `Agent ${agent.name} registered`, { agent_id: agent.id })
    return {
      agent,
      api_key,
      claim_code,
      claim_url: `${d.cfg.publicUrl}/claim?code=${claim_code}`,
      next_actions: [
        { op: 'search_bots', why: 'Find a specialist bot for your task (no money needed to browse, draft a spec or negotiate).', args: {} },
        { op: 'request_mandate', why: `To spend, send your human ${d.cfg.publicUrl}/claim?code=${claim_code} (a web page, not a tool): they log in with PayPal, claim you, and approve the mandate once.`, args: {} },
        { op: 'whoami', why: 'Check your profile. On reconnect send "Authorization: Bearer <api_key>"; this MCP session is already you.', args: {} },
      ],
    }
  }

  const whoami: H<'whoami'> = async (ctx) => {
    const actor = d.actor(ctx.principal)
    const agent = d.agent(actor.agent_id)
    if (!agent) throw new OpError('not_found', 'Agent not found.', 'Register again with register_agent.')
    const owner = agent.owner_id ? s.auth.user(agent.owner_id) : undefined
    const mandate = s.escrow.mandateFor(agent.id)
    const bots = d.db.all<{ data: string }>("SELECT data FROM bots WHERE operator_agent_id = ? AND status != 'delisted' ORDER BY created_at", agent.id).map((r) => botSummary(json<BotCard>(r.data)))
    let buyerOpen = 0
    let sellerOpen = 0
    let needs = 0
    for (const id of d.openJobIds()) {
      const rec = d.load(id)
      const role = rec.buyer_agent_id === agent.id ? 'buyer' : rec.seller_agent_id === agent.id ? 'seller' : null
      if (!role) continue
      if (role === 'buyer') buyerOpen++
      else sellerOpen++
      if (needsAction(d.view(rec), role)) needs++
    }
    const next: NextAction[] = []
    // claim_agent is for people (REST only): an agent can only ask its owner to open the claim_url.
    if (!agent.claimed) next.push({ op: 'request_mandate', why: 'A human must claim this agent before it can spend: send them the claim_url from register_agent (a web page; they log in with PayPal and paste nothing). Ask for a mandate meanwhile.', args: {} })
    else if (!mandate || mandate.status !== 'active') next.push({ op: 'request_mandate', why: 'Get a spending mandate so you can fund jobs without a human click.', args: {} })
    if (needs) next.push({ op: 'list_jobs', why: `${needs} job(s) are waiting on you.`, args: { needs_action: true } })
    next.push({ op: 'search_bots', why: 'Find a specialist bot to hire.', args: {} })
    next.push({ op: 'wait_for_events', why: 'Wait for activity on your jobs.', args: { after_cursor: d.bus.latestCursor() } })
    return {
      agent,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      mandate,
      bots,
      jobs: { as_buyer_open: buyerOpen, as_seller_open: sellerOpen, needs_your_action: needs },
      payment_rail: d.rail.kind,
      next_actions: next,
    }
  }

  const request_mandate: H<'request_mandate'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    const agent = d.agent(actor.agent_id)!
    const mandate = await s.escrow.requestMandate(agent.id, agent.owner_id, input)
    return {
      mandate,
      approval_url: mandate.approval_url,
      next_actions: [
        { op: 'get_mandate', why: `Send approval_url to your owner${agent.claimed ? '' : ', who must also open your claim_url (from register_agent; a web page, not a tool)'}, then poll until the mandate is active.`, args: {} },
      ],
    }
  }

  const get_mandate: H<'get_mandate'> = async (ctx) => {
    const actor = d.actor(ctx.principal)
    return { mandate: s.escrow.mandateFor(actor.agent_id) }
  }

  const claim_agent: H<'claim_agent'> = async (ctx, input) => {
    if (ctx.principal.kind !== 'user') throw new OpError('forbidden', 'Only a signed-in person can claim an agent.', 'Open the claim_url in a browser and sign in.')
    return { agent: s.auth.claim(ctx.principal.user_id, input.claim_code) }
  }

  // ---------- discover ----------
  const search_bots: H<'search_bots'> = async (_ctx, input) => {
    const q = input.query?.toLowerCase().trim()
    const max = input.max_unit_price ? toCents(input.max_unit_price) : null
    const bots = d.db
      .all<{ data: string }>("SELECT data FROM bots WHERE status = 'listed' ORDER BY created_at")
      .map((r) => json<BotCard>(r.data))
      .filter((b) => !input.capability_class || b.capability_class === input.capability_class)
      .filter((b) => !input.mode || b.mode === input.mode)
      .filter((b) => !input.skill || b.skills.some((k) => k.id === input.skill))
      .filter((b) => max === null || b.skills.some((k) => toCents(k.pricing.price) <= max))
      .map((b) => {
        if (!q) return { b, score: 1 }
        const hay = [b.name, b.tagline, b.description, b.capability_class, ...b.skills.flatMap((k) => [k.id, k.title, k.description])].join(' ').toLowerCase()
        const words = q.split(/\s+/).filter(Boolean)
        // Words match at a word start ("direct" finds "directories"); most of the query must match.
        const hits = words.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)).length
        const score = hits >= Math.ceil(words.length / 2) ? hits + (b.name.toLowerCase().includes(q) ? 3 : 0) : 0
        return { b, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    // An agent that never sets limit must still be told when bots were cut off.
    return { bots: bots.slice(0, input.limit).map((x) => botSummary(x.b)), total: bots.length }
  }

  const get_leaderboard: H<'get_leaderboard'> = async (_ctx, input) => leaderboard(d, input.sort_by, input.limit)

  const get_bot: H<'get_bot'> = async (_ctx, input) => {
    const bot = d.bot(input.bot_id)
    if (!bot || bot.status === 'delisted') throw new OpError('not_found', `Bot ${input.bot_id} not found.`, 'search_bots lists the bots for hire.')
    return { bot }
  }

  const list_checks: H<'list_checks'> = async () => ({ checks: d.intel.checks.list() })

  const draft_job_spec: H<'draft_job_spec'> = async (_ctx, input) => {
    const bot = d.bot(input.bot_id)
    if (!bot || bot.status === 'delisted') throw new OpError('not_found', `Bot ${input.bot_id} not found.`, 'search_bots lists the bots for hire.')
    const skill = bot.skills.find((k) => k.id === input.skill_id)
    if (!skill) throw new OpError('invalid_input', `Bot ${bot.name} has no skill ${input.skill_id}.`, `Use one of: ${bot.skills.map((k) => k.id).join(', ')}.`)
    const draft = await d.intel.copilot.draft({
      bot,
      skill,
      goal: input.goal,
      quantity: input.quantity,
      deadline: input.deadline,
      budget_cap: input.budget_cap,
      context: input.context,
      checks: d.intel.checks.list(),
    })
    const policy = await d.intel.policy.reviewSpec(draft.spec, bot)
    return { spec: draft.spec, estimate: draft.estimate, warnings: draft.warnings, policy }
  }

  // ---------- sell ----------
  const register_bot: H<'register_bot'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    const verdict = await d.intel.policy.reviewBot(input)
    if (verdict.class === 'blocked') throw new OpError('policy_blocked', `The listing was blocked by the policy gate: ${verdict.reasons.join('; ') || 'not allowed'}.`, 'Remove the blocked activity from the listing; PayPal’s Acceptable Use Policy applies.')
    const now = d.nowIso()
    const bot = BotCard.parse({
      id: newId('bot'),
      name: input.name,
      tagline: input.tagline,
      description: input.description,
      operator_agent_id: actor.agent_id,
      capability_class: input.capability_class,
      skills: input.skills,
      policy: { class: verdict.class, requires_scope_proof: input.capability_class === 'security', notes: verdict.reasons.join('; ').slice(0, 500) },
      a2a_url: input.a2a_url ?? null,
      ...(input.passport ? { passport: declaredPassport(input.passport) } : {}),
      mode: input.mode,
      status: verdict.class === 'standard' ? 'listed' : 'paused',
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null },
      created_at: now,
    })
    d.db.run('INSERT INTO bots (id, operator_agent_id, status, data, stats, created_at) VALUES (?, ?, ?, ?, ?, ?)', bot.id, bot.operator_agent_id, bot.status, JSON.stringify(bot), JSON.stringify(emptyStats()), now)
    if (bot.status === 'listed') s.stats.feedItem('bot_listed', `New bot for hire: ${bot.name} (${bot.capability_class.replace(/_/g, ' ')})`)
    return { bot }
  }

  const update_bot: H<'update_bot'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    const bot = d.bot(input.bot_id)
    if (!bot) throw new OpError('not_found', `Bot ${input.bot_id} not found.`, 'whoami lists the bots you operate.')
    if (!actor.agents.has(bot.operator_agent_id)) throw new OpError('forbidden', 'Only the bot’s operator can update it.', 'Use the API key of the agent that registered the bot.')
    const next = BotCard.parse({ ...bot, ...Object.fromEntries(Object.entries(input.patch).filter(([, v]) => v !== undefined)), ...(input.patch.passport ? { passport: declaredPassport(input.patch.passport) } : {}) })
    if (input.patch.skills || input.patch.description || input.patch.tagline) {
      const verdict = await d.intel.policy.reviewBot(next)
      if (verdict.class === 'blocked') throw new OpError('policy_blocked', `The update was blocked by the policy gate: ${verdict.reasons.join('; ')}.`, 'Remove the blocked activity from the listing.')
      next.policy = { ...next.policy, class: verdict.class, notes: verdict.reasons.join('; ').slice(0, 500) }
      if (verdict.class !== 'standard' && next.status === 'listed') next.status = 'paused'
    }
    d.db.run('UPDATE bots SET data = ?, status = ? WHERE id = ?', JSON.stringify(next), next.status, next.id)
    d.bus.publish('bot', null, { agents: [bot.operator_agent_id], public: next.status === 'listed' }, `${next.name} updated (${next.status})`, { bot_id: next.id, status: next.status })
    return { bot: next }
  }

  return { register_agent, whoami, request_mandate, get_mandate, claim_agent, search_bots, get_leaderboard, get_bot, list_checks, draft_job_spec, register_bot, update_bot }
}

/** An operator's own passport: stored as declared. Only Rent-A-Bot marks a connection verified (house bots, a passed probe). */
function declaredPassport(p: BotPassport): BotPassport {
  return { ...p, connections: p.connections.map((c) => ({ ...c, verified: false })) }
}
