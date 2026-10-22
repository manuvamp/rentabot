// Job operations: negotiate, escrow, work, review, dispute, and job reads.
// Every handler runs under the job's lock and passes the state table (machine.ts) first.
import { TERMINAL_STATES, secretAsString, type Contract, type JobSpec, type JobSummary, type MessageType, type Quote } from '@rentabot/shared'
import { canViewPlatformAnalytics, platformAnalytics } from '../core/analytics.ts'
import { needsAction } from '../core/machine.ts'
import { captureAndHoldNotice, policyHold } from '../core/escrow.ts'
import { newJobRecord } from '../core/job-factory.ts'
import { heldCents, type JobRecord } from '../core/model.ts'
import type { Services } from '../core/services.ts'
import { OpError, type Handlers } from '../core/types.ts'
import { newId, toCents, toAmount } from '../core/util.ts'
import { json } from '../db/index.ts'
import { idempotent, withJob } from './common.ts'
import type { LockerCaller } from '../core/locker.ts'
import type { OpContext } from '../core/types.ts'
import type { Actor } from '../core/domain.ts'
import type { Role } from '@rentabot/shared'

type H<N extends keyof Handlers> = Handlers[N]

/** Contract-level consistency a party must not be able to sign past. */
function contractProblems(c: Contract): string | null {
  const ids = c.spec.deliverables.map((d) => d.id)
  if (new Set(ids).size !== ids.length) return 'deliverable ids must be unique'
  for (const d of c.spec.deliverables) {
    const lines = c.quote.lines.filter((l) => l.deliverable_id === d.id)
    if (lines.length !== 1) return `deliverable ${d.id} needs exactly one price line (has ${lines.length})`
  }
  const extra = c.quote.lines.find((l) => !ids.includes(l.deliverable_id))
  if (extra) return `price line for unknown deliverable ${extra.deliverable_id}`
  return null
}

/** Why a quote cannot be signed against this spec, or null. Used for quotes in a job and for bids on an open job. */
export function quoteProblems(q: Quote, rec: { spec: JobSpec }): string | null {
  let sum = 0
  for (const l of q.lines) {
    const d = rec.spec.deliverables.find((x) => x.id === l.deliverable_id)
    if (!d) return `line for unknown deliverable ${l.deliverable_id}`
    if (l.quantity !== d.quantity) return `line ${l.deliverable_id} quantity ${l.quantity} ≠ spec quantity ${d.quantity}`
    const unit = toCents(l.unit_price)
    const max = toCents(l.max_total)
    if (l.model === 'per_unit' && max > unit * l.quantity) return `line ${l.deliverable_id}: max_total is above unit_price × quantity`
    if (l.model === 'fixed' && max !== unit) return `line ${l.deliverable_id}: a fixed line's max_total must equal its unit_price`
    sum += max
  }
  if (toCents(q.total_max.value) !== sum) return `total_max $${q.total_max.value} ≠ sum of line max_totals $${toAmount(sum)}`
  if (sum <= 0) return 'the quote total must be above zero'
  return contractProblems({ spec: rec.spec, quote: q } as Contract)
}

/** Where a call came from, for the locker audit: a signed-in person on REST is the web app. */
const surfaceOf = (ctx: OpContext): LockerCaller['surface'] => (ctx.surface === 'rest' && ctx.principal.kind === 'user' ? 'web' : ctx.surface)

export function jobHandlers(s: Services) {
  const d = s.d
  const flows = s.flows
  const caller = (ctx: OpContext, role: Role, actor: Actor): LockerCaller => ({ role, actor, surface: surfaceOf(ctx) })
  /** Credentials never go into the room, inputs or deliveries (core/locker.ts guardText). */
  const guard = (ctx: OpContext, rec: JobRecord, role: Role, actor: Actor, where: string, ...texts: (string | undefined | null)[]) => s.locker.guardText(rec, texts, caller(ctx, role, actor), where)

  // ---------- negotiate ----------
  /** R1: no job can be priced below the minimum settlement, so a budget cap below it could never be quoted. */
  const budgetAtLeastMinimum = (cap: string) => {
    const min = d.cfg.fees.min_settlement_cents
    if (toCents(cap) < min) throw new OpError('invalid_input', `budget_cap $${cap} is below the $${toAmount(min)} minimum job price.`, `Set budget_cap to at least $${toAmount(min)}: no job is settled for less.`)
  }

  const create_job: H<'create_job'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    return d.withLock(`create:${actor.key}:${input.idempotency_key ?? newId('x')}`, async () => {
      const { result, replayed } = await idempotent(s, actor, 'create_job', input.idempotency_key, async () => {
        const bot = d.bot(input.bot_id)
        if (!bot || bot.status === 'delisted') throw new OpError('not_found', `Bot ${input.bot_id} not found.`, 'search_bots lists the bots for hire.')
        if (bot.status !== 'listed') throw new OpError('invalid_state', `${bot.name} is not taking jobs right now (coming soon).`, 'Pick a listed bot from search_bots.')
        if (actor.agents.has(bot.operator_agent_id)) throw new OpError('forbidden', 'You cannot hire a bot you operate.', 'Hire another bot, or use a different buyer agent.')
        const skill = bot.skills.find((k) => k.id === input.spec.skill_id)
        if (!skill) throw new OpError('invalid_input', `${bot.name} has no skill ${input.spec.skill_id}.`, `Use one of: ${bot.skills.map((k) => k.id).join(', ')}.`)
        const ids = input.spec.deliverables.map((x) => x.id)
        if (new Set(ids).size !== ids.length) throw new OpError('invalid_input', 'Deliverable ids must be unique.', 'Number them D1, D2, …')
        const known = new Set([...skill.checks, ...d.intel.checks.list().map((c) => c.id)])
        const unknown = input.spec.deliverables.flatMap((x) => x.acceptance.map((t) => t.check)).filter((c) => !known.has(c))
        if (unknown.length) throw new OpError('invalid_input', `Unknown acceptance checks: ${[...new Set(unknown)].join(', ')}.`, `Use checks from list_checks or the skill's checks (${skill.checks.join(', ')}).`)
        budgetAtLeastMinimum(input.spec.budget_cap.value)
        const verdict = await d.intel.policy.reviewSpec(input.spec, bot)
        if (verdict.class === 'blocked') throw new OpError('policy_blocked', `The policy gate blocked this job: ${verdict.reasons.join('; ') || 'not allowed'}.`, 'Remove the blocked activity from the spec; PayPal’s Acceptable Use Policy and the law apply.')
        const rec = newJobRecord(d, { buyer_agent_id: actor.agent_id, bot, skill, spec: input.spec, title: input.title?.trim() || input.spec.goal, verdict })
        d.save(rec)
        d.post(rec, d.from(actor, 'buyer'), 'job_spec', input.spec.goal, { spec: input.spec, bot_id: bot.id, skill_id: skill.id })
        d.system(rec, `Job opened with ${bot.name}. Policy gate: ${verdict.class}${verdict.reasons.length ? ` (${verdict.reasons.join('; ')})` : ''}. Waiting for the seller's requirements and quote.`)
        s.stats.feedItem('job_opened', `A buyer opened a job with ${bot.name} (budget $${input.spec.budget_cap.value})`, toCents(input.spec.budget_cap.value))
        d.save(rec)
        return { job_id: rec.id }
      })
      void replayed
      const rec = d.load(result.job_id)
      return d.result(rec, 'buyer')
    })
  }

  const submit_requirements: H<'submit_requirements'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'submit_requirements', async ({ rec, role, actor }) => {
      const changed = d.amend(rec, () => (rec.requirements = input.requirements))
      d.post(rec, d.from(actor, role), 'requirements', `Requirements${changed ? '' : ' (unchanged)'}: ${input.requirements.access.length} access request(s), ${input.requirements.questions.length} question(s).`, { requirements: input.requirements, contract_version: rec.version })
      d.save(rec)
      return d.result(rec, role)
    })

  const send_quote: H<'send_quote'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'send_quote', async ({ rec, role, actor }) => {
      const problem = quoteProblems(input.quote, rec)
      if (problem) throw new OpError('invalid_input', `Quote rejected: ${problem}.`, 'One line per deliverable, quantities as in the spec, total_max = sum of max_total.')
      if (Date.parse(input.quote.valid_until) < d.nowMs()) throw new OpError('invalid_input', 'valid_until is in the past.', 'Give the quote a future valid_until.')
      const min = d.feePolicy(rec).min_settlement_cents
      if (toCents(input.quote.total_max.value) < min)
        throw new OpError('invalid_input', `Quote rejected: total_max $${input.quote.total_max.value} is below the $${toAmount(min)} minimum job price.`, `Quote at least $${toAmount(min)} (more units or a higher price); smaller amounts cannot be settled through PayPal at a profit.`)
      d.amend(rec, () => (rec.quote = input.quote))
      d.post(rec, d.from(actor, role), 'quote', `Quote: up to $${input.quote.total_max.value}, turnaround ${input.quote.turnaround}.`, { quote: input.quote, contract_version: rec.version, contract_hash: rec.contract_hash })
      d.save(rec)
      return d.result(rec, role)
    })

  const revise_spec: H<'revise_spec'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'revise_spec', async ({ rec, role, actor }) => {
      if (input.spec.skill_id !== rec.skill_id) throw new OpError('invalid_input', 'A revision cannot change the skill.', 'Open a new job for a different skill.')
      const bot = d.bot(rec.seller_bot_id)!
      budgetAtLeastMinimum(input.spec.budget_cap.value)
      const verdict = await d.intel.policy.reviewSpec(input.spec, bot)
      if (verdict.class === 'blocked') throw new OpError('policy_blocked', `The policy gate blocked this revision: ${verdict.reasons.join('; ')}.`, 'Remove the blocked activity from the spec.')
      rec.policy = verdict
      d.amend(rec, () => (rec.spec = input.spec))
      d.post(rec, d.from(actor, role), 'counter', input.note || 'The buyer revised the job spec.', { spec: input.spec, contract_version: rec.version })
      d.save(rec)
      return d.result(rec, role)
    })

  const provide_inputs: H<'provide_inputs'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'provide_inputs', async ({ rec, role, actor }) => {
      const keys = [...Object.keys(input.answers), ...Object.keys(input.inputs)]
      if (!keys.length) throw new OpError('invalid_input', 'Nothing to provide.', 'Pass answers (Q1…) and/or inputs keyed by the requirements’ inputs_schema.')
      guard(ctx, rec, role, actor, 'input', JSON.stringify(input.answers), JSON.stringify(input.inputs))
      if (rec.state === 'NEGOTIATING') {
        d.amend(rec, () => {
          rec.answers = { ...rec.answers, ...input.answers }
          rec.inputs = { ...rec.inputs, ...input.inputs }
        })
        d.post(rec, d.from(actor, role), 'inputs', `Answers and inputs: ${keys.join(', ')}.`, { answers: input.answers, inputs: input.inputs, contract_version: rec.version })
      } else {
        // After funding the contract is frozen: late inputs are recorded in the room as context.
        d.post(rec, d.from(actor, role), 'inputs', `Additional inputs (not part of the frozen contract): ${keys.join(', ')}.`, { answers: input.answers, inputs: input.inputs, supplemental: true })
      }
      d.save(rec)
      return d.result(rec, role)
    })

  const accept_contract: H<'accept_contract'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'accept_contract', async ({ rec, role, actor }) => {
      if (input.contract_hash !== rec.contract_hash)
        throw new OpError('stale_contract', 'The contract changed since you read it.', `Read the current contract with get_job and accept hash ${rec.contract_hash} if you agree.`, [
          { op: 'get_job', why: 'Read the current contract.', args: { job_id: rec.id } },
        ])
      const contract = d.buildContract(rec)!
      const problem = contractProblems(contract)
      if (problem) throw new OpError('invalid_state', `This contract can't be signed: ${problem}.`, 'The seller should re-quote (one line per deliverable).')
      rec.accepted_by = [...rec.accepted_by.filter((a) => a.role !== role), { role, agent_id: d.agentFor(rec, role), contract_hash: rec.contract_hash!, ts: d.nowIso() }]
      d.post(rec, d.from(actor, role), 'accept', `The ${role} signed contract v${rec.version}.`, { contract_hash: rec.contract_hash, version: rec.version })
      const signed = new Set(rec.accepted_by.filter((a) => a.contract_hash === rec.contract_hash).map((a) => a.role))
      if (signed.has('buyer') && signed.has('seller')) s.flows.agree(rec)
      d.save(rec)
      return d.result(rec, role)
    })

  const decline_job: H<'decline_job'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'decline_job', async ({ rec, role, actor }) => {
      d.post(rec, d.from(actor, role), 'decline', input.reason, {})
      await flows.cancel(rec, role, input.reason)
      return d.result(rec, role)
    })

  const send_message: H<'send_message'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'send_message', async ({ rec, role, actor }) => {
      const t = input.type
      if ((t === 'progress' || t === 'blocker') && role !== 'seller') throw new OpError('forbidden', `Only the seller posts ${t} messages.`, 'Use note, clarify or answer.')
      if ((t === 'progress' || t === 'blocker') && !['IN_PROGRESS', 'BLOCKED'].includes(rec.state)) throw new OpError('invalid_state', `${t} messages are for work in progress.`, 'Use note instead.')
      if (t === 'unblock' && rec.state !== 'BLOCKED') throw new OpError('invalid_state', 'The job is not blocked.', 'Use note instead.')
      guard(ctx, rec, role, actor, 'message', input.text)
      for (const id of input.artifact_ids) if (!s.artifacts.meta(id)) throw new OpError('invalid_input', `Unknown artifact ${id}.`, 'Upload it with upload_artifact first.')
      const body: Record<string, unknown> = input.percent !== undefined ? { percent: input.percent } : {}
      const message = d.post(rec, d.from(actor, role), t as MessageType, input.text, body, input.artifact_ids)
      if (t === 'blocker' && rec.state === 'IN_PROGRESS') {
        rec.blocked_since = d.nowIso()
        d.setState(rec, 'BLOCKED', 'the seller is waiting on the buyer; the delivery deadline is paused')
      } else if (t === 'unblock') {
        // The deadline moves by however long the job was blocked.
        if (rec.blocked_since && rec.deadlines.deliver_by) rec.deadlines.deliver_by = new Date(Date.parse(rec.deadlines.deliver_by) + Math.max(0, d.nowMs() - Date.parse(rec.blocked_since))).toISOString()
        rec.blocked_since = null
        d.setState(rec, 'IN_PROGRESS', `unblocked; delivery due ${rec.deadlines.deliver_by}`)
      }
      d.save(rec)
      return { message, ...d.result(rec, role) }
    })

  // ---------- escrow ----------
  const fund_job: H<'fund_job'> = async (ctx, input) => {
    // A retry with a used key replays (whatever the state is now) instead of hitting the state table.
    const actor0 = d.actor(ctx.principal)
    const prior = d.db.get<{ result: string }>("SELECT result FROM idempotency WHERE principal = ? AND op = 'fund_job' AND key = ?", actor0.key, input.idempotency_key)
    if (prior) {
      const r = JSON.parse(prior.result) as { job_id: string }
      if (r.job_id !== input.job_id) throw new OpError('invalid_input', 'This idempotency_key was already used for another job.', 'Use a new idempotency_key for each job.')
      return withJob(s, ctx, input.job_id, 'get_job', async ({ rec, role }) => ({ ...d.result(rec, role), approval_url: rec.state === 'AWAITING_APPROVAL' ? rec.escrow.approval_url : null }))
    }
    return withJob(s, ctx, input.job_id, 'fund_job', async ({ rec, role, actor }) => {
      const { result } = await idempotent(s, actor, 'fund_job', input.idempotency_key, async () => {
        const out = await s.escrow.fund(rec)
        return { job_id: rec.id, approval_url: out.approval_url }
      })
      if (result.job_id !== rec.id) throw new OpError('invalid_input', 'This idempotency_key was already used for another job.', 'Use a new idempotency_key for each job.')
      const fresh = d.load(rec.id)
      return { ...d.result(fresh, role), approval_url: fresh.state === 'AWAITING_APPROVAL' ? fresh.escrow.approval_url : null, notes: [...(fresh.state === 'AWAITING_APPROVAL' && policyHold(fresh) ? [`Not paid by the mandate: ${policyHold(fresh)}.`] : []), ...(fresh.escrow.mode === 'capture_and_hold' ? [captureAndHoldNotice(d.feePolicy(fresh))] : [])] }
    })
  }

  const get_escrow: H<'get_escrow'> = (ctx, input) => withJob(s, ctx, input.job_id, 'get_escrow', async ({ rec }) => ({ escrow: d.render(rec).escrow }))

  // ---------- work ----------
  const upload_artifact: H<'upload_artifact'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    if (input.job_id) {
      const rec = d.load(input.job_id)
      const role = d.roleIn(rec, actor)
      if (!role || role === 'arbiter') throw new OpError('not_found', `Job ${input.job_id} not found.`, 'Upload to a job you are part of, or omit job_id.')
      if (TERMINAL_STATES.includes(rec.state)) throw new OpError('invalid_state', 'The job has ended.', 'Upload without job_id.')
      if (input.text !== undefined) guard(ctx, rec, role, actor, 'artifact', input.text)
    }
    const given = [input.content_base64, input.text, input.url].filter((x) => x !== undefined).length
    if (given !== 1) throw new OpError('invalid_input', 'Give exactly one of content_base64, text or url.', 'Pick one way to send the content.')
    let bytes: Uint8Array | undefined
    if (input.content_base64 !== undefined) {
      const clean = input.content_base64.replace(/\s+/g, '')
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new OpError('invalid_input', 'content_base64 is not valid base64.', 'Encode the file bytes as base64.')
      bytes = new Uint8Array(Buffer.from(clean, 'base64'))
    } else if (input.text !== undefined) bytes = new TextEncoder().encode(input.text)
    const artifact = s.artifacts.create({ job_id: input.job_id ?? null, name: input.name, mime: input.text !== undefined && input.mime === 'application/octet-stream' ? 'text/plain' : input.mime, bytes, url: input.url, uploaded_by: actor.agent_id })
    return { artifact }
  }

  // share_secret / get_secret: the v1 calls, now thin wrappers over the locker (sealed mode, kind "secret").
  const share_secret: H<'share_secret'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'share_secret', async ({ rec, role, actor }) => {
      const item = await s.locker.put(rec, caller(ctx, role, actor), { access_id: input.access_id, label: input.label, site: '', value: input.value })
      return { secret_id: item.id, sealed_until: item.status === 'available' ? ('now_available' as const) : ('funded' as const) }
    })

  const get_secret: H<'get_secret'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'get_secret', async ({ rec, role, actor }) => {
      const meta = s.locker.item(rec, input.secret_id)
      if (meta.direction !== 'access') throw new OpError('invalid_input', 'get_secret reads access items; this is a handover.', 'Use open_locker_item.')
      if (meta.protection === 'e2e') throw new OpError('invalid_input', 'This item is end-to-end encrypted: the server cannot return it in clear.', 'Call open_locker_item and decrypt it with openWithPrivateKey() and your private key.')
      const out = await s.locker.open(rec, caller(ctx, role, actor), input.secret_id)
      return { access_id: out.item.access_id ?? '', label: out.item.label, value: secretAsString(out.secret!), expires_at: null }
    })

  // ---------- locker ----------
  const lockerNext = (rec: JobRecord, role: Role) => d.result(rec, role).next_actions

  const register_encryption_key: H<'register_encryption_key'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    return d.withLock(`enc-key:${actor.agent_id}`, () => s.locker.registerKey(actor.agent_id, input.jwk, input.label))
  }

  const list_encryption_keys: H<'list_encryption_keys'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    const yours = [...actor.agents].flatMap((a) => s.locker.keysOf(a, false))
    if (!input.job_id) return { yours, buyer: [], seller: [] }
    return withJob(s, ctx, input.job_id, 'list_locker_items', async ({ rec }) => ({ yours, buyer: s.locker.keysOf(rec.buyer_agent_id), seller: s.locker.keysOf(rec.seller_agent_id) }))
  }

  const revoke_encryption_key: H<'revoke_encryption_key'> = async (ctx, input) => ({ key: s.locker.revokeKey(d.actor(ctx.principal), input.kid) })

  const put_locker_item: H<'put_locker_item'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'put_locker_item', async ({ rec, role, actor }) => {
      const item = await s.locker.put(rec, caller(ctx, role, actor), input)
      return { item, next_actions: lockerNext(rec, role) }
    })

  const list_locker_items: H<'list_locker_items'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'list_locker_items', async ({ rec, role }) => ({
      items: s.locker.list(rec),
      consent: s.locker.consentView(rec),
      actions: s.locker.actions(rec.id),
      audit: s.locker.auditLog(rec.id),
      your_role: role,
      next_actions: lockerNext(rec, role),
    }))

  const open_locker_item: H<'open_locker_item'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'open_locker_item', async ({ rec, role, actor }) => {
      const out = await s.locker.open(rec, caller(ctx, role, actor), input.item_id)
      return { ...out, next_actions: lockerNext(rec, role) }
    })

  const shred_locker_item: H<'shred_locker_item'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'shred_locker_item', async ({ rec, role, actor }) => {
      const item = s.locker.shred(rec, caller(ctx, role, actor), input.item_id, input.acknowledged)
      return { item, next_actions: lockerNext(rec, role) }
    })

  const log_action: H<'log_action'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'log_action', async ({ rec, role, actor }) => {
      const out = s.locker.logAction(rec, caller(ctx, role, actor), input)
      return { ...out, next_actions: lockerNext(rec, role) }
    })

  const submit_delivery: H<'submit_delivery'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'submit_delivery', async ({ rec, role, actor }) => {
      const ids = new Set(rec.spec.deliverables.map((x) => x.id))
      const bad = input.delivery.deliverables.find((x) => !ids.has(x.deliverable_id))
      if (bad) throw new OpError('invalid_input', `Unknown deliverable ${bad.deliverable_id}.`, `Deliver against: ${[...ids].join(', ')}.`)
      guard(ctx, rec, role, actor, 'delivery', JSON.stringify(input.delivery))
      const arts = input.delivery.deliverables.flatMap((x) => x.units.flatMap((u) => u.artifact_ids))
      for (const id of arts) if (!s.artifacts.meta(id)) throw new OpError('invalid_input', `Unknown artifact ${id}.`, 'Upload it with upload_artifact first.')
      // The delivery message carries the check results (body.checks), so it is posted once the checks have run.
      const checks = await flows.deliver(rec, input.delivery, d.from(actor, role), [...new Set(arts)])
      return { ...d.result(rec, role), checks }
    })

  // ---------- review ----------
  const run_checks: H<'run_checks'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'run_checks', async ({ rec }) => {
      await s.checks.run(rec, 'all')
      d.save(rec)
      return { checks: s.checks.latest(rec.id), fulfilment: rec.fulfilment }
    })

  const review_delivery: H<'review_delivery'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'review_delivery', async ({ rec, role, actor }) => {
      if (input.decision === 'reject') guard(ctx, rec, role, actor, 'review', JSON.stringify(input.rejections))
      if (input.decision === 'accept') {
        d.post(rec, d.from(actor, role), 'review', 'The buyer accepted the delivery.', { decision: 'accept' })
        await flows.settleEarned(rec, 'the buyer accepted the delivery')
      } else {
        d.post(rec, d.from(actor, role), 'review', input.rejections.map((r) => `${r.deliverable_id}${r.unit_refs.length ? ` [${r.unit_refs.join(', ')}]` : ''}: ${r.reason}`).join('\n') || 'Rejected.', { decision: 'reject', rejections: input.rejections })
        flows.reject(rec, input.rejections)
      }
      return d.result(rec, role)
    })

  // ---------- dispute ----------
  const open_dispute: H<'open_dispute'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'open_dispute', async ({ rec, role, actor }) => {
      guard(ctx, rec, role, actor, 'dispute', input.reason, JSON.stringify(input.claims))
      d.post(rec, d.from(actor, role), 'dispute', input.reason, { claims: input.claims })
      flows.openDispute(rec, role as 'buyer' | 'seller', input.reason, input.claims)
      return d.result(rec, role)
    })

  const add_statement: H<'add_statement'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'add_statement', async ({ rec, role, actor }) => {
      for (const id of input.artifact_ids) if (!s.artifacts.meta(id)) throw new OpError('invalid_input', `Unknown artifact ${id}.`, 'Upload it with upload_artifact first.')
      guard(ctx, rec, role, actor, 'statement', input.text)
      d.post(rec, d.from(actor, role), 'statement', input.text, {}, input.artifact_ids)
      d.save(rec)
      return d.result(rec, role)
    })

  const get_mediation: H<'get_mediation'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'get_mediation', async ({ rec, role }) => {
      const r = d.result(rec, role)
      return { mediation: rec.mediation?.state ?? null, your_role: r.your_role, next_actions: r.next_actions }
    })

  const respond_to_proposal: H<'respond_to_proposal'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'respond_to_proposal', async ({ rec, role, actor }) => {
      guard(ctx, rec, role, actor, 'proposal response', input.reason, input.terms ? JSON.stringify(input.terms) : '')
      const explanation = await flows.respond(rec, role as 'buyer' | 'seller', d.from(actor, role), input)
      d.save(rec)
      return { ...d.result(rec, role), explanation }
    })

  const answer_mediator: H<'answer_mediator'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'answer_mediator', async ({ rec, role, actor }) => {
      guard(ctx, rec, role, actor, 'answer', input.answer)
      flows.answer(rec, role as 'buyer' | 'seller', input.question_id, input.answer)
      d.post(rec, d.from(actor, role), 'mediator_answer', input.answer, { question_id: input.question_id })
      d.save(rec)
      return d.result(rec, role)
    })

  const get_ruling: H<'get_ruling'> = (ctx, input) => withJob(s, ctx, input.job_id, 'get_ruling', async ({ rec }) => ({ ruling: rec.ruling }))

  const accept_ruling: H<'accept_ruling'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'accept_ruling', async ({ rec, role, actor }) => {
      rec.ruling_accepted_by = [...new Set([...rec.ruling_accepted_by, role])]
      d.post(rec, d.from(actor, role), 'note', `The ${role} accepted the ruling.`, { ruling_id: rec.ruling?.id, accepted: true })
      d.save(rec)
      if (rec.ruling_accepted_by.includes('buyer') && rec.ruling_accepted_by.includes('seller')) await flows.executeRuling(rec, 'both parties accepted the ruling')
      return d.result(rec, role)
    })

  const appeal_ruling: H<'appeal_ruling'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'appeal_ruling', async ({ rec, role, actor }) => {
      d.post(rec, d.from(actor, role), 'appeal', input.grounds, { ruling_id: rec.ruling?.id, bond: d.cfg.appealBond })
      flows.appeal(rec, role as 'buyer' | 'seller', input.grounds)
      return d.result(rec, role)
    })

  const arbiter_decide: H<'arbiter_decide'> = async (ctx, input) => {
    if (ctx.principal.kind !== 'user' || !ctx.principal.roles.includes('arbiter')) throw new OpError('forbidden', 'Only a human arbiter can decide appeals.', 'Sign in as an arbiter in the Ops console.')
    return withJob(s, ctx, input.job_id, 'arbiter_decide', async ({ rec, role, actor }) => {
      d.post(rec, d.from(actor, 'arbiter'), 'arbiter_decision', input.note, { decision: input.decision, release_to_seller: input.release_to_seller ?? null })
      await flows.arbiterDecide(rec, actor, input.decision, input.release_to_seller, input.note)
      return d.result(rec, role)
    })
  }

  // ---------- reads ----------
  const get_job: H<'get_job'> = (ctx, input) => withJob(s, ctx, input.job_id, 'get_job', async ({ rec, role }) => d.result(rec, role))

  /** The soonest future deadline; a finished job has none (its old timers no longer apply). */
  const nextDeadline = (rec: JobRecord) =>
    TERMINAL_STATES.includes(rec.state) ? undefined : Object.values(rec.deadlines).filter((t): t is string => !!t && Date.parse(t) > d.nowMs()).sort()[0]

  /** The same escrow numbers the Job Room ledger prints, so a list can show what was authorized, captured, voided and paid without a get_job per row. */
  const summaryMoney = (rec: JobRecord): NonNullable<JobSummary['money']> => {
    const e = rec.escrow
    const m = (c: number) => ({ value: toAmount(c), currency: 'USD' as const })
    return { authorized: m(e.authorized), captured: m(e.captured), voided: m(e.voided), refunded: m(e.refunded), paid_out: m(e.paid_out), payout_pending: m(Math.max(e.payout_requested - e.paid_out, 0)) }
  }

  const list_jobs: H<'list_jobs'> = async (ctx, input) => {
    const actor = d.actor(ctx.principal)
    // The appeals queue: a human arbiter asking for APPEALED jobs gets every appealed job, not only their own.
    if (actor.isArbiter && input.state === 'APPEALED') {
      const queue = d.db.all<{ data: string }>("SELECT data FROM jobs WHERE state = 'APPEALED' ORDER BY updated_at DESC LIMIT ?", input.limit)
      return {
        jobs: queue.map((r): JobSummary => {
          const rec = json<JobRecord>(r.data)
          const next = nextDeadline(rec)
          return { id: rec.id, state: rec.state, title: rec.title, seller_bot_id: rec.seller_bot_id, buyer_agent_id: rec.buyer_agent_id, updated_at: rec.updated_at, your_role: d.roleIn(rec, actor) ?? 'arbiter', held: { value: toAmount(heldCents(rec.escrow)), currency: 'USD' }, money: summaryMoney(rec), next_deadline: next ?? null }
        }),
      }
    }
    const agents = [...actor.agents]
    const marks = agents.map(() => '?').join(',')
    const rows = d.db.all<{ data: string }>(`SELECT data FROM jobs WHERE buyer_agent_id IN (${marks}) OR seller_agent_id IN (${marks}) ORDER BY updated_at DESC`, ...agents, ...agents)
    const jobs: JobSummary[] = []
    for (const r of rows) {
      const rec = json<JobRecord>(r.data)
      const role = d.roleIn(rec, actor)
      if (role !== 'buyer' && role !== 'seller') continue
      if (input.role && input.role !== role) continue
      if (input.state && input.state !== rec.state) continue
      if (input.needs_action && !needsAction(d.view(rec), role)) continue
      const next = nextDeadline(rec)
      jobs.push({ id: rec.id, state: rec.state, title: rec.title, seller_bot_id: rec.seller_bot_id, buyer_agent_id: rec.buyer_agent_id, updated_at: rec.updated_at, your_role: role, held: { value: toAmount(heldCents(rec.escrow)), currency: 'USD' }, money: summaryMoney(rec), next_deadline: next ?? null })
      if (jobs.length >= input.limit) break
    }
    return { jobs }
  }

  const get_messages: H<'get_messages'> = (ctx, input) =>
    withJob(s, ctx, input.job_id, 'get_messages', async ({ rec }) => ({ messages: d.room.list(rec.id, input.after_seq, input.limit), chain_valid: d.room.valid(rec.id) }))

  const get_platform_ledger: H<'get_platform_ledger'> = async (ctx, input) => {
    if (ctx.principal.kind !== 'user' || !ctx.principal.roles.includes('arbiter')) throw new OpError('forbidden', 'Only a human arbiter can read the platform ledger.', 'Sign in as an arbiter in the Ops console.')
    return s.stats.ledger(input.limit)
  }

  const get_platform_analytics: H<'get_platform_analytics'> = async (ctx, input) => {
    const p = ctx.principal
    const persona = p.kind === 'user' ? s.auth.user(p.user_id)?.persona : null
    if (p.kind !== 'user' || !canViewPlatformAnalytics(p.roles, persona, d.cfg.demoMode)) throw new OpError('forbidden', 'The platform analytics are for the human arbiter (and the owner persona in demo mode).', 'Sign in as the Arbiter in the Ops console.')
    return platformAnalytics(d, input.include_simulated)
  }

  const wait_for_events: H<'wait_for_events'> = async (ctx, input) => {
    d.actor(ctx.principal) // must be authenticated
    const res = await d.bus.wait({ principal: ctx.principal, after_cursor: input.after_cursor, job_id: input.job_id, types: input.types }, input.timeout_seconds * 1000)
    return res
  }

  return {
    create_job,
    submit_requirements,
    send_quote,
    revise_spec,
    provide_inputs,
    accept_contract,
    decline_job,
    send_message,
    fund_job,
    get_escrow,
    upload_artifact,
    share_secret,
    get_secret,
    register_encryption_key,
    list_encryption_keys,
    revoke_encryption_key,
    put_locker_item,
    list_locker_items,
    open_locker_item,
    shred_locker_item,
    log_action,
    submit_delivery,
    run_checks,
    review_delivery,
    open_dispute,
    add_statement,
    get_mediation,
    respond_to_proposal,
    answer_mediator,
    get_ruling,
    accept_ruling,
    appeal_ruling,
    arbiter_decide,
    get_job,
    list_jobs,
    get_messages,
    get_platform_ledger,
    get_platform_analytics,
    wait_for_events,
  }
}
