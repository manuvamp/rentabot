// Write handlers for the mock API: negotiation, escrow, delivery, disputes, mandates, selling.
// The seller bot and the mediator are played by ./story.ts; money moves live in ./engine.ts.
import type { Agent, BotCard, Contract, Delivery, Job, Mandate, Role } from '../api/types'
import { emit } from './bus'
import type { Db } from './db'
import {
  append, authorize, computeFulfilment, earnedTotal, heldCents, later, makeArtifact, mandateCovers, origin, ppId, processDelivery, rehash, requireApproval, runChecks, setState, settleEscrow, system, total,
} from './engine'
import { fail, nextActions, requireJob, requireUser, type Caller } from './logic'
import { register } from './registry'
import { grossFromNet } from './engine'
import { markHuman, processSubstitute, registerMediationOps, startMediation } from './mediation'
import { acceptAs, executeGross, executeRuling, makeQuote, recordRulingAccept, scheduleRuling, sellerCure, sellerMaybeAccept, sellerRespond, syncContract } from './story'
import { DAY, HOUR, amt, cents, iso, parseDuration, rid, usd } from './util'

// ------------------------------------------------------------ small helpers
const BLOCKED: [RegExp, string][] = [
  [/\bspam|mass[- ]?(dm|email|message)|bulk unsolicited/i, 'Spam and mass unsolicited messaging are not allowed.'],
  [/fake (review|rating|traffic|analytics)|astroturf/i, 'Fake reviews, ratings and analytics are not allowed.'],
  [/credential[- ]stuffing|brute[- ]?force login/i, 'Credential stuffing is not allowed.'],
  [/captcha[- ]?(solv|farm|bypass)|solve captchas/i, 'CAPTCHA farming is not allowed.'],
  [/\bporn|sexual|adult content|nsfw|escort\b/i, 'Sexually oriented content violates the PayPal Acceptable Use Policy.'],
]
function gate(...texts: string[]): string[] {
  const t = texts.join('\n')
  return BLOCKED.filter(([re]) => re.test(t)).map(([, why]) => why)
}

const agentOf = (c: Caller): string => {
  requireUser(c)
  return c.agent_id ?? fail(403, 'forbidden', 'This identity has no agent.', 'Sign in as the owner or the bot operator, or send an agent API key.')
}

function partyJob(db: Db, id: string, c: Caller, only?: 'buyer' | 'seller'): { job: Job; role: 'buyer' | 'seller' } {
  const { job, role } = requireJob(db, id, c)
  if (role !== 'buyer' && role !== 'seller') fail(403, 'forbidden', 'Only the buyer and the seller can do this.', 'Arbiters act through arbiter_decide.')
  if (only && role !== only) fail(403, 'forbidden', `Only the ${only} can do this.`, `You are the ${role} on this job.`)
  if (c.user) markHuman(db, job.id, role)
  return { job, role: role as 'buyer' | 'seller' }
}

const result = <E extends object>(db: Db, job: Job, role: Role, extra?: E) => ({ job, your_role: role, next_actions: nextActions(db, job, role), ...(extra ?? ({} as E)) })

const wrongState = (job: Job, allowed: string): never => fail(409, 'invalid_state', `This job is ${job.state}, not ${allowed}.`, `This operation only works while the job is ${allowed}. Call get_job to see next_actions.`, [{ op: 'get_job', why: 'See what you can do now.', args: { job_id: job.id } }])

const sellerBotOf = (db: Db, job: Job) => db.bots[job.seller_bot_id]

function checkTurn(job: Job, ...states: Job['state'][]) {
  if (!states.includes(job.state)) wrongState(job, states.join(' or '))
}

function fundResult(db: Db, job: Job, role: Role) {
  return result(db, job, role, { approval_url: job.escrow.approval_url })
}

/** Funds a job: authorizes at once inside a covering mandate, otherwise asks for a PayPal approval. */
function fundNow(db: Db, job: Job, buyerAgent: string) {
  const cover = mandateCovers(db, job, buyerAgent)
  if (cover.ok) authorize(db, job, true)
  else requireApproval(db, job, cover.why)
}

// ------------------------------------------------------------ Spec Copilot
function draftSpec(db: Db, i: { bot_id: string; skill_id: string; goal: string; quantity?: number; deadline?: string; budget_cap?: string; context?: string }) {
  const bot = db.bots[i.bot_id] ?? fail(404, 'not_found', `No bot ${i.bot_id}.`, 'Call search_bots to find a bot.')
  const skill = bot.skills.find((s) => s.id === i.skill_id) ?? fail(404, 'not_found', `${bot.name} has no skill ${i.skill_id}.`, `Skills: ${bot.skills.map((s) => s.id).join(', ')}.`)
  const context = i.context ?? ''
  const fixed = skill.pricing.model === 'fixed'
  const digits = /\b(\d{1,4})\b/.exec(i.goal)
  let quantity = fixed ? 1 : (i.quantity ?? (digits ? Number(digits[1]) : (skill.pricing.min_units ?? 1)))
  if (!fixed) quantity = Math.min(Math.max(quantity, 1), skill.pricing.max_units ?? 100_000)
  const unitC = cents(skill.pricing.price)
  const estimateC = fixed ? unitC : unitC * Math.max(quantity, skill.pricing.min_units ?? 1)
  const product = /(?:product|name|company)\s*[:=]\s*([A-Za-z0-9][\w .-]{1,30})/i.exec(context)?.[1]?.trim() ?? /\b[A-Z]{3,}\b/.exec(`${context} ${i.goal}`)?.[0] ?? 'ORANO'
  const domain = /https?:\/\/([^\s/)]+)/i.exec(`${context} ${i.goal}`)?.[1] ?? `${product.toLowerCase().replace(/\s+/g, '')}.com`
  const params = (check: string): Record<string, unknown> => {
    switch (check) {
      case 'listing_url_live': return { status: 200 }
      case 'listing_mentions_product': return { must_include: [product, domain] }
      case 'lead_verified': return { require_on_site: true }
      case 'lint_passed': return { max_words: 120 }
      case 'report_sections_present': return { sections: ['llms.txt', 'agent.json', 'mcp.json', 'openapi', 'schema.org', 'robots'] }
      default: return {}
    }
  }
  const unit = (skill.pricing.unit ?? 'unit').replace(/_/g, ' ')
  const goal = i.goal.trim().slice(0, 300)
  const spec = {
    skill_id: skill.id,
    goal: goal.length >= 10 ? goal : `${goal} (via ${bot.name})`,
    deliverables: [
      {
        id: 'D1',
        description: fixed ? `${skill.title}: ${goal}`.slice(0, 600) : `At least ${quantity} ${unit}${quantity === 1 ? '' : 's'}: ${goal}`.slice(0, 600),
        quantity,
        acceptance: skill.checks.map((c) => ({ check: c, params: params(c) })),
        rubric: bot.id === 'bot_DirectoryBlaster' ? 'Listings use the approved tagline and category "Productivity".' : '',
      },
    ],
    deadline: i.deadline ?? iso(Date.now() + parseDuration(skill.turnaround) + 2 * DAY),
    budget_cap: usd(i.budget_cap ? cents(i.budget_cap) : Math.ceil((estimateC * 1.33) / 100) * 100),
    out_of_scope: bot.id === 'bot_DirectoryBlaster' ? ['paid directories', 'creating new social accounts'] : [],
    context,
    context_artifact_ids: [] as string[],
  }
  const warnings: string[] = []
  if (!fixed && skill.pricing.min_units && quantity < skill.pricing.min_units) warnings.push(`${quantity} is below this bot's minimum of ${skill.pricing.min_units} units. The quote will round up to ${skill.pricing.min_units}.`)
  if (spec.deliverables[0].rubric) warnings.push('The rubric line is judged by a person or the mediator, not by a check. Only acceptance tests are paid automatically.')
  if (!/https?:\/\//i.test(context)) warnings.push('No URL in the context. The seller will ask for one, which costs a round trip.')
  if (i.goal.trim().length < 30) warnings.push('A longer goal gives the seller more to work with.')
  if (!fixed) warnings.push(`You pay per verified ${unit}. The budget cap is only the most that can be held.`)
  const reasons = gate(i.goal, context)
  const policy = reasons.length
    ? { class: 'blocked' as const, reasons }
    : bot.policy.requires_scope_proof
      ? { class: 'restricted' as const, reasons: ['Needs scope proof (DNS TXT or /.well-known/rentabot-scope.txt) before funding.'] }
      : { class: 'standard' as const, reasons: [] as string[] }
  return { spec, estimate: usd(estimateC), warnings, policy }
}

// ------------------------------------------------------------ registration
export function registerWriteOps() {
  registerMediationOps()
  // ---------- account
  register('register_agent', ({ name, description, payout_email }, { db }) => {
    if (!name || String(name).length < 2) fail(400, 'invalid_input', 'name must be at least 2 characters.', 'Pick a recognisable agent name.')
    const id = rid('agt')
    const code = `${rid('c').slice(2, 6)}-${rid('d').slice(2, 6)}`.toUpperCase()
    const agent: Agent = { id, name, description: description ?? '', owner_id: null, claimed: false, payout_email: payout_email ?? null, created_at: new Date().toISOString() }
    db.agents[id] = agent
    db.claims[code] = id
    emit('bot', null, `New agent registered: ${name}. Spending locked until a human claims it.`, { agent_id: id })
    return {
      agent,
      api_key: `rab_${rid('k', 28).slice(2)}`,
      claim_url: `${origin()}/agents/mandate?claim=${code}`,
      claim_code: code,
      next_actions: [{ op: 'search_bots', why: 'Browse bots now. To spend, give your owner the claim_url so they can approve a mandate.', args: {} }],
    }
  })

  register('claim_agent', ({ claim_code }, { db, caller }) => {
    const user = requireUser(caller)
    const code = String(claim_code ?? '').trim().toUpperCase()
    const id = db.claims[code] ?? fail(404, 'not_found', 'That claim code is not valid or was already used.', 'Ask the agent to call register_agent again for a fresh code.')
    const agent = db.agents[id]
    agent.owner_id = user.id
    agent.claimed = true
    delete db.claims[code]
    emit('bot', null, `${agent.name} was claimed by ${user.name}`, { agent_id: id })
    return { agent }
  })

  register('request_mandate', ({ monthly_cap, per_job_cap, categories, expires_in_days = 30 }, { db, caller }) => {
    const agentId = agentOf(caller)
    const agent = db.agents[agentId]
    if (!agent.owner_id) fail(409, 'invalid_state', 'This agent has no owner yet.', 'Open the claim_url from register_agent as a signed-in human first, then ask for a mandate.')
    if (cents(per_job_cap) > cents(monthly_cap)) fail(400, 'invalid_input', 'per_job_cap is larger than monthly_cap.', 'Lower per_job_cap or raise monthly_cap.')
    const id = rid('mdt')
    const prev = db.mandates[agentId]
    const mandate: Mandate = {
      id,
      agent_id: agentId,
      owner_id: agent.owner_id,
      status: 'pending_approval',
      monthly_cap: usd(cents(monthly_cap)),
      per_job_cap: usd(cents(per_job_cap)),
      categories,
      expires_at: iso(Date.now() + expires_in_days * DAY),
      spent_this_month: prev?.spent_this_month ?? usd(0),
      approval_url: `${origin()}/sim/paypal/mandate/${id}`,
      rail: db.rail,
      created_at: new Date().toISOString(),
    }
    if (prev) db.scratch[`prevMandate:${id}`] = prev
    db.mandates[agentId] = mandate
    emit('mandate', null, `Mandate requested: $${monthly_cap}/month, $${per_job_cap} per job`, { mandate_id: id })
    return { mandate, approval_url: mandate.approval_url, next_actions: [{ op: 'get_mandate', why: 'Poll until a human approves it on PayPal.', args: {} }] }
  })

  // ---------- Spec Copilot
  register('draft_job_spec', (input, { db, caller }) => {
    requireUser(caller)
    return draftSpec(db, input)
  })

  // ---------- negotiate
  register('create_job', ({ bot_id, spec, title, idempotency_key }, { db, caller }) => {
    const buyer = agentOf(caller)
    const key = idempotency_key ? `idem:create:${buyer}:${idempotency_key}` : null
    if (key && db.scratch[key]) {
      const j = db.jobs[db.scratch[key] as string]
      return result(db, j, 'buyer')
    }
    const bot = db.bots[bot_id] ?? fail(404, 'not_found', `No bot ${bot_id}.`, 'Call search_bots to find a bot.')
    if (bot.status !== 'listed') fail(409, 'invalid_state', `${bot.name} is not taking jobs yet.`, 'Pick a listed bot with search_bots.')
    if (!bot.skills.some((s) => s.id === spec?.skill_id)) fail(400, 'invalid_input', `${bot.name} has no skill ${spec?.skill_id}.`, `Skills: ${bot.skills.map((s) => s.id).join(', ')}.`)
    const reasons = gate(spec.goal, spec.context ?? '', ...spec.deliverables.map((d: { description: string }) => d.description))
    if (reasons.length) fail(422, 'policy_blocked', `The policy gate blocked this job: ${reasons.join(' ')}`, 'Rewrite the goal as a legitimate task, or choose a different bot. Blocked specs never reach escrow.')
    const id = rid('job')
    const now = new Date().toISOString()
    const spec2 = { context: '', context_artifact_ids: [], out_of_scope: [], ...spec } as Contract['spec']
    const job: Job = {
      id,
      state: 'NEGOTIATING',
      title: title ?? `${bot.name}: ${spec2.goal.slice(0, 70)}`,
      buyer_agent_id: buyer,
      seller_bot_id: bot.id,
      seller_agent_id: bot.operator_agent_id,
      skill_id: spec2.skill_id,
      contract: null,
      contract_hash: null,
      accepted_by: [],
      escrow: {
        job_id: id, rail: db.rail, mode: 'hold', status: 'none', authorized: usd(0), captured: usd(0), voided: usd(0), refunded: usd(0), fees: usd(0), paid_out: usd(0), approval_url: null,
        paypal: { order_id: null, authorization_id: null, capture_ids: [], refund_ids: [], payout_item_ids: [] }, honor_expires_at: null, authorization_expires_at: null, events: [],
      },
      fulfilment: spec2.deliverables.map((d) => ({ deliverable_id: d.id, expected_units: d.quantity, passed_units: 0, pending_units: 0, failed_units: 0, earned: usd(0) })),
      ruling: null,
      mediation: null,
      deadlines: { fund_by: null, deliver_by: null, review_until: null, cure_until: null, appeal_until: null, verify_until: null },
      policy: { class: 'standard', reasons: [] },
      message_count: 0,
      created_at: now,
      updated_at: now,
    }
    db.jobs[id] = job
    db.messages[id] = []
    db.scratch[`pending:${id}`] = { spec: spec2 }
    append(db, job, 'buyer', 'job_spec', spec2.goal, { spec: spec2 })
    if (key) db.scratch[key] = id
    sellerRespond(db, job)
    return result(db, job, 'buyer')
  })

  register('submit_requirements', ({ job_id, requirements }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'seller')
    checkTurn(job, 'NEGOTIATING')
    const pend = (db.scratch[`pending:${job.id}`] ??= {}) as { requirements?: unknown }
    pend.requirements = { access: [], assumptions: [], questions: [], ...requirements }
    append(db, job, 'seller', 'requirements', 'Updated requirements.', { requirements: pend.requirements })
    if (syncContract(db, job)) emit('state', job.id, 'Contract updated, acceptances reset', {})
    return result(db, job, role)
  })

  register('send_quote', ({ job_id, quote }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'seller')
    checkTurn(job, 'NEGOTIATING')
    const pend = (db.scratch[`pending:${job.id}`] ??= {}) as { quote?: unknown }
    pend.quote = { excludes: [], ...quote }
    syncContract(db, job)
    append(db, job, 'seller', 'quote', `Quote: $${quote.total_max.value} maximum.`, { quote: pend.quote })
    return result(db, job, role)
  })

  register('revise_spec', ({ job_id, spec, note = '' }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'buyer')
    checkTurn(job, 'NEGOTIATING')
    const reasons = gate(spec.goal, spec.context ?? '')
    if (reasons.length) fail(422, 'policy_blocked', `The policy gate blocked this revision: ${reasons.join(' ')}`, 'Rewrite the goal as a legitimate task.')
    const spec2 = { context: '', context_artifact_ids: [], out_of_scope: [], ...spec } as Contract['spec']
    const pend = (db.scratch[`pending:${job.id}`] ??= {}) as { spec?: Contract['spec'] }
    pend.spec = spec2
    if (job.contract) {
      job.contract = { ...job.contract, spec: spec2 }
      rehash(job)
    }
    append(db, job, 'buyer', 'job_spec', note || 'Revised the spec.', { spec: spec2 })
    // the seller re-quotes
    later(1500, () => {
      const j = db.jobs[job.id]
      if (!j || j.state !== 'NEGOTIATING') return
      const q = makeQuote(sellerBotOf(db, j), spec2)
      ;(db.scratch[`pending:${j.id}`] as { quote?: unknown }).quote = q
      syncContract(db, j)
      append(db, j, 'seller', 'quote', `Re-quoted: $${q.total_max.value} maximum.`, { quote: q })
    })
    return result(db, job, role)
  })

  register('provide_inputs', ({ job_id, answers = {}, inputs = {} }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'buyer')
    checkTurn(job, 'NEGOTIATING', 'AGREED')
    if (!job.contract) fail(409, 'invalid_state', "The seller has not sent requirements and a quote yet.", 'Wait for the seller: call wait_for_events on this job.')
    if (job.state === 'AGREED') fail(409, 'invalid_state', 'The contract is frozen.', 'Change terms with an amendment, or start a new job.')
    const clean = Object.fromEntries(Object.entries(answers as Record<string, string>).filter(([, v]) => String(v).trim() !== ''))
    const cur = job.contract!
    job.contract = { ...cur, answers: { ...cur.answers, ...clean }, inputs: { ...cur.inputs, ...inputs } }
    rehash(job)
    append(db, job, 'buyer', 'answer', 'Answers and inputs provided.', { answers: clean, inputs })
    return result(db, job, role)
  })

  register('accept_contract', ({ job_id, contract_hash }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    if (job.state !== 'NEGOTIATING') {
      if (job.state === 'AGREED' && job.accepted_by.some((a) => a.role === role)) return result(db, job, role)
      wrongState(job, 'NEGOTIATING')
    }
    if (!job.contract || !job.contract_hash) fail(409, 'invalid_state', 'There is no contract to sign yet.', 'Wait for the seller to send requirements and a quote.')
    if (contract_hash !== job.contract_hash) fail(409, 'stale_contract', 'The contract changed since you read it.', 'Call get_job, read the new contract_hash and terms, then accept that hash.', [{ op: 'get_job', why: 'Read the current contract.', args: { job_id: job.id } }])
    if (role === 'buyer') {
      const open = job.contract!.requirements.questions.filter((q) => !job.contract!.answers[q.id])
      if (open.length) fail(409, 'invalid_state', `The seller's question${open.length > 1 ? 's' : ''} ${open.map((q) => q.id).join(', ')} still need an answer.`, 'Call provide_inputs with your answers, then accept the new contract hash.', [{ op: 'provide_inputs', why: 'Answer the questions first.', args: { job_id: job.id } }])
    }
    acceptAs(db, job, role)
    if (role === 'buyer') sellerMaybeAccept(db, job)
    return result(db, job, role)
  })

  register('decline_job', ({ job_id, reason }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    checkTurn(job, 'NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED')
    if ((job.state === 'IN_PROGRESS' || job.state === 'BLOCKED') && role !== 'buyer') fail(403, 'forbidden', 'Only the buyer can cancel a job in progress.', 'Open a dispute or deliver instead.')
    append(db, job, role, 'decline', reason, { reason })
    settleEscrow(db, job, 'Job cancelled: authorization released')
    job.deadlines = { ...job.deadlines, fund_by: null }
    setState(job, 'CANCELLED', reason)
    system(db, job, `Job cancelled by the ${role}. Nothing was charged.`, { event: 'cancelled' })
    return result(db, job, role)
  })

  register('send_message', ({ job_id, type, text, percent, artifact_ids = [] }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    if (['SETTLED', 'CANCELLED', 'EXPIRED'].includes(job.state)) wrongState(job, 'open')
    if ((type === 'progress' || type === 'blocker') && role !== 'seller') fail(403, 'forbidden', `Only the seller can post ${type}.`, 'Use note or clarify instead.')
    if (type === 'unblock' && role !== 'buyer') fail(403, 'forbidden', 'Only the buyer can unblock.', 'Ask the buyer to unblock you.')
    const body: Record<string, unknown> = type === 'progress' ? { percent: percent ?? 0 } : {}
    const message = append(db, job, role, type, text, body, artifact_ids)
    if (type === 'blocker' && job.state === 'IN_PROGRESS') setState(job, 'BLOCKED', 'seller is waiting on the buyer')
    if (type === 'unblock' && job.state === 'BLOCKED') setState(job, 'IN_PROGRESS', 'buyer unblocked the seller')
    return { message, ...result(db, job, role) }
  })

  // ---------- escrow
  register('fund_job', ({ job_id }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'buyer')
    if (job.state === 'AWAITING_APPROVAL' || job.state === 'IN_PROGRESS' || job.state === 'BLOCKED') return fundResult(db, job, role)
    checkTurn(job, 'AGREED')
    fundNow(db, job, job.buyer_agent_id)
    return fundResult(db, job, role)
  })

  // ---------- work
  register('upload_artifact', ({ job_id, name, mime = 'application/octet-stream', content_base64, text, url }, { db, caller }) => {
    requireUser(caller)
    const bytes = text ? new TextEncoder().encode(text).length : content_base64 ? Math.floor((String(content_base64).length * 3) / 4) : 0
    const a = makeArtifact(db, job_id ?? null, name, mime, caller.agent_id ?? caller.user!.id, bytes)
    if (url) a.url = url
    return { artifact: a }
  })

  register('share_secret', ({ job_id, access_id, label, value }, { db, caller }) => {
    const { job } = partyJob(db, job_id, caller, 'buyer')
    checkTurn(job, 'NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED')
    const id = rid('sec')
    const store = (db.scratch[`secrets:${job.id}`] ??= {}) as Record<string, { access_id: string; label: string; value: string }>
    store[id] = { access_id, label, value }
    const funded = job.escrow.status === 'authorized' || job.escrow.status === 'partially_captured'
    system(db, job, `Secret shared for access request ${access_id} (${label}). The value is never logged.${funded ? '' : ' It stays sealed until the escrow is funded.'}`, { event: 'secret_shared', access_id })
    emit('secret', job.id, `Secret shared for ${access_id}`, { secret_id: id })
    return { secret_id: id, sealed_until: funded ? 'now_available' : 'funded' }
  })

  register('get_secret', ({ job_id, secret_id }, { db, caller }) => {
    const { job } = partyJob(db, job_id, caller, 'seller')
    if (!(job.escrow.status === 'authorized' || job.escrow.status === 'partially_captured')) fail(409, 'invalid_state', 'The secret is still sealed.', 'Secrets unseal for the seller only after the escrow is funded.')
    const s = ((db.scratch[`secrets:${job.id}`] ?? {}) as Record<string, { access_id: string; label: string; value: string }>)[secret_id] ?? fail(404, 'not_found', `No secret ${secret_id}.`, 'Check the secret id from the room.')
    system(db, job, `Seller read the secret for ${s.access_id}.`, { event: 'secret_read', access_id: s.access_id })
    return { access_id: s.access_id, label: s.label, value: s.value, expires_at: null }
  })

  register('submit_delivery', ({ job_id, delivery }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'seller')
    checkTurn(job, 'IN_PROGRESS', 'CURE')
    const d: Delivery = { ...delivery, note: delivery.note ?? '', deliverables: (delivery.deliverables ?? []).map((x: Delivery['deliverables'][number]) => ({ ...x, note: x.note ?? '', units: (x.units ?? []).map((u) => ({ ...u, artifact_ids: u.artifact_ids ?? [], meta: u.meta ?? {} })) })) }
    if (db.scratch[`amend:${job.id}`] && job.state === 'IN_PROGRESS') {
      const sub = processSubstitute(db, job, d)
      return { ...result(db, job, role), checks: sub }
    }
    const { checks } = processDelivery(db, job, d)
    return { ...result(db, job, role), checks }
  })

  // ---------- review
  register('run_checks', ({ job_id }, { db, caller }) => {
    const { job } = partyJob(db, job_id, caller)
    const delivery = db.scratch[`delivery:${job.id}`] as Delivery | undefined
    if (!delivery || !job.contract) fail(409, 'invalid_state', 'There is no delivery to check.', 'Wait for the seller to call submit_delivery.')
    const attempt = ((db.scratch[`attempt:${job.id}`] as number | undefined) ?? 1)
    const previous = (db.scratch[`checks:${job.id}`] as ReturnType<typeof runChecks>) ?? []
    const checks = previous.map((c) => ({ ...c, status: c.status === 'pending' ? ('pass' as const) : c.status, attempt: attempt + 1, ran_at: new Date().toISOString() }))
    db.scratch[`checks:${job.id}`] = checks
    db.scratch[`attempt:${job.id}`] = attempt + 1
    job.fulfilment = computeFulfilment(db, job, delivery!, checks)
    system(db, job, `Checks re-run (attempt ${attempt + 1}): ${job.fulfilment.reduce((a, f) => a + f.passed_units, 0)} of ${job.fulfilment.reduce((a, f) => a + f.expected_units, 0)} units verified.`, { event: 'checks' })
    emit('check', job.id, 'Checks re-run', { attempt: attempt + 1 })
    return { checks, fulfilment: job.fulfilment }
  })

  register('review_delivery', ({ job_id, decision, rejections = [] }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller, 'buyer')
    checkTurn(job, 'DELIVERED')
    if (decision === 'accept') {
      append(db, job, 'buyer', 'review', 'Accepted the delivery.', { decision: 'accept', rejections: [] })
      executeGross(db, job, earnedTotal(job), 'buyer accepted the delivery')
    } else {
      if (!rejections.length) fail(400, 'invalid_input', 'A rejection must name what is wrong.', 'Pass rejections: [{ deliverable_id, unit_refs, check, reason }]. Vague rejections count against you in mediation.')
      append(db, job, 'buyer', 'review', `Rejected ${rejections.length} item${rejections.length > 1 ? 's' : ''}.`, { decision: 'reject', rejections })
      setState(job, 'CURE', 'buyer rejected items; one cure window')
      job.deadlines.review_until = null
      job.deadlines.cure_until = iso(Date.now() + parseDuration(job.contract?.timers.cure_window ?? 'PT48H'))
      system(db, job, 'Cure window opened. The seller can redo the rejected units once.', { event: 'cure' })
      sellerCure(db, job)
    }
    return result(db, job, role)
  })

  // ---------- dispute
  register('open_dispute', ({ job_id, reason, claims }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    checkTurn(job, 'DELIVERED', 'CURE', 'IN_PROGRESS')
    append(db, job, role, 'dispute', reason, { reason, claims })
    setState(job, 'DISPUTED', 'escrow frozen, mediator started')
    job.deadlines.review_until = null
    job.deadlines.cure_until = null
    system(db, job, `Dispute opened by the ${role}. Escrow is frozen. The AI mediator is reading the room.`, { event: 'dispute_opened' })
    startMediation(db, job)
    return result(db, job, role)
  })

  register('add_statement', ({ job_id, text, artifact_ids = [] }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    checkTurn(job, 'DISPUTED')
    append(db, job, role, 'statement', text, {}, artifact_ids)
    return result(db, job, role)
  })

  register('answer_mediator', ({ job_id, question_id, answer }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    checkTurn(job, 'DISPUTED')
    const msgs = db.messages[job.id] ?? []
    const q = msgs.find((m) => m.type === 'mediator_question' && (m.body as { question_id?: string }).question_id === question_id) ?? fail(404, 'not_found', `No mediator question ${question_id}.`, 'Check get_job next_actions for the open question id.')
    if ((q.body as { to?: string }).to !== role) fail(403, 'forbidden', 'That question is addressed to the other party.', 'Only the addressed party can answer.')
    if (msgs.some((m) => m.type === 'mediator_answer' && (m.body as { question_id?: string }).question_id === question_id && m.from.role === role)) return result(db, job, role)
    append(db, job, role, 'mediator_answer', answer, { question_id })
    scheduleRuling(db, job)
    return result(db, job, role)
  })

  register('accept_ruling', ({ job_id }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    checkTurn(job, 'RULED')
    const list = (db.scratch[`ruling-accepted:${job.id}`] as string[] | undefined) ?? []
    if (!list.includes(role)) recordRulingAccept(db, job, role)
    return result(db, job, role)
  })

  register('appeal_ruling', ({ job_id, grounds }, { db, caller }) => {
    const { job, role } = partyJob(db, job_id, caller)
    checkTurn(job, 'RULED')
    if (String(grounds ?? '').length < 20) fail(400, 'invalid_input', 'Grounds must be specific (at least 20 characters).', 'Say which finding or clause the ruling got wrong.')
    append(db, job, role, 'appeal', 'Appealing to a human.', { grounds })
    setState(job, 'APPEALED', `${role} appealed`)
    job.deadlines.appeal_until = null
    system(db, job, 'Appeal accepted. Case sent to a human arbiter. Escrow stays frozen until they decide.', { event: 'appealed' })
    emit('ruling', job.id, 'Appeal filed, waiting for the arbiter', {})
    return result(db, job, role)
  })

  register('arbiter_decide', ({ job_id, decision, release_to_seller, note }, { db, caller }) => {
    const user = requireUser(caller)
    if (user.role !== 'arbiter') fail(403, 'forbidden', 'Only a human arbiter can decide appeals.', 'Sign in as the Arbiter.')
    const { job } = requireJob(db, job_id, caller)
    checkTurn(job, 'APPEALED')
    if (decision === 'override' && !release_to_seller) fail(400, 'invalid_input', 'An override needs release_to_seller.', 'Say how much the seller should receive after fees.')
    const r = job.ruling
    const gross =
      decision === 'confirm' && r
        ? cents(r.remedy.release_to_seller.value) + cents(r.remedy.fees.platform.value) + cents(r.remedy.fees.mediation.value)
        : Math.min(grossFromNet(cents(release_to_seller)), cents(job.escrow.authorized.value))
    append(db, job, { kind: 'user', id: user.id, role: 'arbiter' }, 'arbiter_decision', note, { decision, note, ...(release_to_seller ? { release_to_seller } : {}) })
    emit('ruling', job.id, `Arbiter ${decision === 'confirm' ? 'confirmed' : 'overrode'} the ruling`, { decision })
    executeGross(db, job, gross, `arbiter ${decision === 'confirm' ? 'confirmed the ruling' : 'overrode the ruling'}`)
    return result(db, job, 'arbiter')
  })

  // ---------- sell
  register('register_bot', (input, { db, caller }) => {
    const agentId = agentOf(caller)
    const reasons = gate(input.name, input.tagline, input.description)
    if (reasons.length) fail(422, 'policy_blocked', `The policy gate blocked this listing: ${reasons.join(' ')}`, 'List a legitimate service.')
    const bot: BotCard = {
      id: rid('bot'),
      name: input.name,
      tagline: input.tagline,
      description: input.description,
      operator_agent_id: agentId,
      capability_class: input.capability_class,
      skills: input.skills.map((s: BotCard['skills'][number]) => ({ ...s, verify_window: s.verify_window ?? 'PT0H', examples: s.examples ?? [] })),
      policy: { class: input.capability_class === 'security' ? 'restricted' : 'standard', requires_scope_proof: input.capability_class === 'security', notes: '' },
      a2a_url: input.a2a_url ?? null,
      ...(input.passport ? { passport: declared(input.passport) } : {}),
      mode: input.mode,
      status: 'listed',
      reputation: { jobs_completed: 0, on_time_rate: null, dispute_rate: null, rulings_lost: 0, integrity_flags: 0, avg_fulfilment: null, settled_by_agreement: 0 },
      created_at: new Date().toISOString(),
    }
    db.bots[bot.id] = bot
    emit('bot', null, `New bot listed: ${bot.name}`, { bot_id: bot.id })
    return { bot }
  })

  register('update_bot', ({ bot_id, patch }, { db, caller }) => {
    const agentId = agentOf(caller)
    const bot = db.bots[bot_id] ?? fail(404, 'not_found', `No bot ${bot_id}.`, 'Check the bot id.')
    if (bot.operator_agent_id !== agentId) fail(403, 'forbidden', 'You do not operate this bot.', 'Only the operator agent can update a listing.')
    Object.assign(bot, patch, patch.passport ? { passport: declared(patch.passport) } : {})
    emit('bot', null, `Bot updated: ${bot.name}`, { bot_id })
    return { bot }
  })

  // ---------- simulated PayPal pages
  register('__sim_paypal_info', ({ kind, id }, { db }) => {
    if (kind === 'order') {
      const job = Object.values(db.jobs).find((j) => j.escrow.paypal.order_id === id) ?? fail(404, 'not_found', 'No such simulated PayPal order.', 'Open the link from the job again.')
      return {
        kind, id, title: `Authorize payment for "${job.title}"`, amount: amt(total(job)), currency: 'USD', job_id: job.id,
        lines: [
          { label: 'Pay to', value: 'Rent-A-Bot escrow (simulated)' },
          { label: 'Intent', value: 'AUTHORIZE: held on your account, not taken' },
          { label: 'Captured only for', value: 'units that pass the contract checks' },
          { label: 'Contract', value: (job.contract_hash ?? '').slice(0, 22) + '…' },
        ],
        return_to: `/jobs/${job.id}`,
      }
    }
    if (kind === 'mandate') {
      const m = Object.values(db.mandates).find((x) => x.id === id) ?? fail(404, 'not_found', 'No such simulated mandate.', 'Request a mandate again.')
      const agent = db.agents[m.agent_id]
      return {
        kind, id, title: `Let ${agent?.name ?? 'this agent'} pay within limits`, amount: m.monthly_cap.value, currency: 'USD',
        lines: [
          { label: 'Monthly cap', value: `$${m.monthly_cap.value}` },
          { label: 'Per-job cap', value: `$${m.per_job_cap.value}` },
          { label: 'Categories', value: m.categories.map((c) => c.replace(/_/g, ' ')).join(', ') },
          { label: 'Expires', value: m.expires_at.slice(0, 10) },
        ],
        return_to: '/agents/mandate',
      }
    }
    return fail(404, 'not_found', `Unknown simulated PayPal object kind "${kind}".`, 'Use order or mandate.')
  })

  register('__sim_paypal_approve', ({ kind, id, approve }, { db }) => {
    if (kind === 'order') {
      const job = Object.values(db.jobs).find((j) => j.escrow.paypal.order_id === id) ?? fail(404, 'not_found', 'No such simulated PayPal order.', 'Open the link from the job again.')
      if (job.state === 'AWAITING_APPROVAL') {
        if (approve) authorize(db, job, false)
        else {
          job.escrow.status = 'none'
          job.escrow.approval_url = null
          job.escrow.paypal.order_id = null
          setState(job, 'AGREED', 'approval declined')
          system(db, job, 'The PayPal approval was declined. Nothing was authorized.', { event: 'approval_declined' })
        }
      }
      return { redirect: `/jobs/${job.id}` }
    }
    if (kind === 'mandate') {
      const m = Object.values(db.mandates).find((x) => x.id === id) ?? fail(404, 'not_found', 'No such simulated mandate.', 'Request a mandate again.')
      if (m.status === 'pending_approval') {
        if (approve) {
          m.status = 'active'
          m.approval_url = null
        } else {
          const prev = db.scratch[`prevMandate:${m.id}`] as Mandate | undefined
          if (prev) db.mandates[m.agent_id] = prev
          else {
            m.status = 'revoked'
            m.approval_url = null
          }
        }
        emit('mandate', null, `Mandate ${approve ? 'approved' : 'declined'}`, { mandate_id: m.id })
      }
      return { redirect: '/agents/mandate' }
    }
    return fail(404, 'not_found', `Unknown simulated PayPal object kind "${kind}".`, 'Use order or mandate.')
  })

  void [heldCents, mandateCovers, ppId, executeRuling, HOUR]
}

/** An operator's passport is declared, never verified (only Rent-A-Bot verifies). */
function declared(p: NonNullable<BotCard['passport']>): NonNullable<BotCard['passport']> {
  return { ...p, connections: p.connections.map((c) => ({ ...c, verified: false })) }
}
