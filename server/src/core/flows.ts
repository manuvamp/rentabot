// Job workflows after the contract: delivery → checks → review → release, cure, cancellation,
// negotiation-first mediation (assessment, proposals, answers, agreement), recommended rulings and
// their execution, appeals, and the timer tick.
// Release rules:
//  - accept, or review window expiry: release what passed; if delayed checks are pending and the
//    verify window is open, release the passed part now and keep the pending share authorized.
//  - reject: CURE window; if it ends without a redelivery, rejected units count as failed.
//  - dispute: the escrow is frozen while the mediator assesses and the parties negotiate (up to 3 rounds).
//    Both sides accepting the same proposal executes it (executeAgreement): split / cancel settle at once;
//    redo / substitute / wait only secure the agreed part (no interim capture: one capture per job), amend the contract and
//    let the agreed checks decide the held money (seller gross = secured + min(held, what the checks earn beyond the agreement)),
//    all paid with the job's single final capture.
//    No agreement: the mediator's last fair proposal becomes a ruling (appealable), executed exactly.
import { Ruling, type Assessment, type CounterTerms, type Proposal, type Remedy, type Role } from '@rentabot/shared'
import { scanText } from '../intelligence/mediator/injection.ts'
import { findAgreement, makeCounterProposal, roundComplete, type ProposeResult } from '../intelligence/negotiation/negotiator.ts'
import { settlementFeesFrom } from '../intelligence/negotiation/terms.ts'
import type { MediationBundle } from '../intelligence/types.ts'
import { scaleMs } from '../config.ts'
import type { CheckRunner } from './checks.ts'
import { termsSummary, type Actor, type Domain } from './domain.ts'
import type { EscrowService } from './escrow.ts'
import { commission, mediationFeeByFaults } from './fees.ts'
import type { JobRecord, Rejection } from './model.ts'
import { MEDIATOR, type From } from './room.ts'
import type { Stats } from './stats.ts'
import { OpError } from './types.ts'
import { newId, toAmount, toCents, usd } from './util.ts'

const MAX_CHECKS_IN_MESSAGE = 500

export class Flows {
  private d: Domain
  private escrow: EscrowService
  private checks: CheckRunner
  private stats: Stats
  /** Jobs with a mediator step running (the model call happens outside the job lock). */
  private stepping = new Set<string>()
  constructor(d: Domain, escrow: EscrowService, checks: CheckRunner, stats: Stats) {
    this.d = d
    this.escrow = escrow
    this.checks = checks
    this.stats = stats
  }

  // ---------- negotiation end ----------
  /** Both parties signed the same hash: freeze and start the funding clock. */
  agree(rec: JobRecord) {
    rec.agreed_hash = rec.contract_hash
    rec.deadlines.fund_by = new Date(this.d.nowMs() + this.d.dur(rec.timers.fund_by)).toISOString()
    this.d.setState(rec, 'AGREED', `both parties signed contract ${rec.contract_hash} (v${rec.version})`, { contract_hash: rec.contract_hash })
    this.stats.feedItem('contract_signed', `${this.stats.botName(rec)}: contract signed for up to $${rec.quote?.total_max.value}`, rec.quote ? toCents(rec.quote.total_max.value) : null)
  }

  // ---------- delivery ----------
  /** Record a delivery, run every check, post the delivery message (with the results) and move to DELIVERED. */
  async deliver(rec: JobRecord, delivery: NonNullable<JobRecord['delivery']>, from: From, artifact_ids: string[] = []) {
    const now = this.d.nowMs()
    if (rec.delivery_count === 0) rec.on_time = !rec.deadlines.deliver_by || now <= Date.parse(rec.deadlines.deliver_by)
    const redo = !!rec.agreement && rec.agreement.kind !== 'wait'
    // A cure redelivery fixes the rejected units; it must never wipe units that already passed.
    const cure = rec.state === 'CURE' && !rec.agreement
    rec.delivery = redo || cure ? this.mergeDelivery(rec, delivery) : delivery
    rec.delivered_at = this.d.nowIso()
    rec.delivery_count += 1
    rec.review = { accepted: false, accepted_at: null, rejections: [] }
    const results = await this.checks.run(rec, 'all')
    const units = delivery.deliverables.reduce((n, x) => n + x.units.length, 0)
    this.d.post(rec, from, 'delivery', delivery.note || `Delivery: ${units} unit(s).`, { delivery, checks: results.slice(0, MAX_CHECKS_IN_MESSAGE) }, artifact_ids)
    rec.deadlines.review_until = new Date(now + this.d.dur(rec.timers.review_window)).toISOString()
    rec.deadlines.cure_until = null
    rec.deadlines.verify_until = new Date(now + this.d.dur(rec.timers.verify_window)).toISOString()
    this.d.setState(rec, 'DELIVERED', `delivery #${rec.delivery_count} received; ${this.summary(rec)}`)
    const passed = rec.fulfilment.reduce((s, f) => s + f.passed_units, 0)
    const expected = rec.fulfilment.reduce((s, f) => s + f.expected_units, 0)
    this.stats.feedItem('units_verified', `${this.stats.botName(rec)}: ${passed}/${expected} ${this.stats.unitWord(rec)} verified`, rec.earned_cents)
    this.d.save(rec)
    // An agreed redo needs no review: the buyer already agreed that the agreed checks decide the held money.
    if (redo) await this.settleEarned(rec, 'the agreed redo was delivered and checked')
    return results
  }

  /** A redelivery (cure, or a redo/substitute agreement) replaces the units it names and keeps the rest;
   *  a substitute agreement also drops the failed units it replaces. */
  private mergeDelivery(rec: JobRecord, incoming: NonNullable<JobRecord['delivery']>): NonNullable<JobRecord['delivery']> {
    const ag = rec.agreement
    const prev = rec.delivery
    if (!prev) return incoming
    const out: NonNullable<JobRecord['delivery']> = { ...incoming, deliverables: prev.deliverables.map((x) => ({ ...x, units: [...x.units] })) }
    for (const inc of incoming.deliverables) {
      const target = out.deliverables.find((x) => x.deliverable_id === inc.deliverable_id)
      if (!target) {
        out.deliverables.push({ ...inc, units: [...inc.units] })
        continue
      }
      if (ag?.kind === 'substitute' && inc.deliverable_id === ag.deliverable_id) {
        const drop = new Set(ag.replaces)
        target.units = target.units.filter((x) => !drop.has(x.ref))
      }
      for (const u of inc.units) {
        const i = target.units.findIndex((x) => x.ref === u.ref)
        if (i >= 0) target.units[i] = u
        else target.units.push(u)
      }
      if (inc.note) target.note = inc.note
    }
    return out
  }

  summary(rec: JobRecord) {
    const p = rec.fulfilment.reduce((s, f) => s + f.passed_units, 0)
    const e = rec.fulfilment.reduce((s, f) => s + f.expected_units, 0)
    const pend = rec.fulfilment.reduce((s, f) => s + f.pending_units, 0)
    return `${p}/${e} units passed their checks${pend ? `, ${pend} pending` : ''}; earned $${toAmount(rec.earned_cents)}${rec.held_pending_cents ? ` (+$${toAmount(rec.held_pending_cents)} held for pending units)` : ''}`
  }

  /**
   * The seller's cumulative gross when the checks settle the job. Normally what the checks earned; under a settlement
   * agreement: what was secured at agreement plus what the agreed checks earned beyond that, up to the held amount.
   */
  targetGross(rec: JobRecord): number {
    const ag = rec.agreement
    if (!ag) return rec.earned_cents
    const gain = Math.max(0, rec.earned_cents - ag.base_earned_cents)
    return Math.min(rec.escrow.authorized, ag.secured_cents + Math.min(ag.held_cents, gain))
  }

  /** Release what the checks say was earned. Final unless pending units can still pass. */
  async settleEarned(rec: JobRecord, why: string, opts: { excludeRejected?: boolean } = {}) {
    this.checks.recompute(rec, opts.excludeRejected)
    const verifyOpen = !!rec.deadlines.verify_until && this.d.nowMs() < Date.parse(rec.deadlines.verify_until)
    const target = this.targetGross(rec)
    if (rec.held_pending_cents > 0 && verifyOpen) {
      if (rec.state === 'CURE') this.d.setState(rec, 'DELIVERED', 'cure window ended; delayed checks still pending')
      rec.review.accepted = true
      rec.review.accepted_at = this.d.nowIso()
      rec.deadlines.review_until = null
      this.d.save(rec)
      // An interim settlement only when both the verified part and the still-pending tail reach MIN_SETTLEMENT, so neither
      // capture is below the minimum; the second capture pays the extra-settlement fee (fees.ts commission).
      const minSettle = this.d.feePolicy(rec).min_settlement_cents
      if (target - rec.escrow.seller_release >= minSettle && rec.held_pending_cents >= minSettle) await this.escrow.release(rec, target, false, `${why}: interim settlement of verified units`)
      this.d.system(rec, `${why}. $${toAmount(rec.held_pending_cents)} stays held for pending units until ${rec.deadlines.verify_until}.`)
      this.d.save(rec)
      return
    }
    await this.escrow.release(rec, target, true, why)
    this.finish(rec, `${why}; ${this.summary(rec)}`)
  }

  private finish(rec: JobRecord, why: string) {
    rec.settled_at = this.d.nowIso()
    rec.deadlines = { ...rec.deadlines, review_until: null, cure_until: null, appeal_until: null }
    this.d.setState(rec, 'SETTLED', why, { captured: toAmount(rec.escrow.captured), voided: toAmount(rec.escrow.voided), refunded: toAmount(rec.escrow.refunded) })
    this.d.save(rec)
  }

  reject(rec: JobRecord, rejections: Rejection[]) {
    const contract = this.d.buildContract(rec)!
    for (const r of rejections) {
      if (!contract.spec.deliverables.some((d) => d.id === r.deliverable_id))
        throw new OpError('invalid_input', `Unknown deliverable ${r.deliverable_id}.`, `Name one of: ${contract.spec.deliverables.map((d) => d.id).join(', ')}.`)
      const units = new Set((rec.delivery?.deliverables.find((x) => x.deliverable_id === r.deliverable_id)?.units ?? []).map((u) => u.ref))
      const unknown = r.unit_refs.filter((u) => !units.has(u))
      if (unknown.length) throw new OpError('invalid_input', `Unknown unit refs: ${unknown.join(', ')}.`, 'Use the unit refs from the delivery.')
    }
    if (!rejections.length) throw new OpError('invalid_input', 'A rejection must name at least one deliverable and a reason.', 'Add rejections: [{deliverable_id, unit_refs, check?, reason}].')
    rec.review.rejections = rejections
    rec.deadlines.review_until = null
    rec.deadlines.cure_until = new Date(this.d.nowMs() + this.d.dur(rec.timers.cure_window)).toISOString()
    this.d.setState(rec, 'CURE', `the buyer rejected ${rejections.length} item(s); the seller has until ${rec.deadlines.cure_until} to fix them`)
    this.d.save(rec)
  }

  async cancel(rec: JobRecord, role: Role, reason: string) {
    await this.escrow.returnAll(rec, `cancelled by the ${role}`)
    this.d.setState(rec, 'CANCELLED', `${role} cancelled: ${reason}`)
    this.d.save(rec)
  }

  // ---------- disputes: negotiation-first mediation ----------
  openDispute(rec: JobRecord, role: 'buyer' | 'seller', reason: string, claims: string[]) {
    rec.mediation = {
      opened_by: role,
      reason,
      claims,
      opened_at: this.d.nowIso(),
      closed_at: null,
      // An earlier agreement's secured part is the seller's already, even though it is paid with the final capture.
      released_cents: Math.max(rec.escrow.seller_release, rec.agreement?.secured_cents ?? 0),
      questions: [],
      answer_until: null,
      state: { status: 'investigating', round: 0, deadline: null, assessment: null, proposals: [], agreed_proposal_id: null },
    }
    rec.deadlines = { ...rec.deadlines, review_until: null, cure_until: null }
    this.d.setState(rec, 'DISPUTED', `${role} opened a dispute; the escrow is frozen (nothing is captured or voided) while the mediator assesses and proposes settlements`)
    this.d.save(rec)
    this.scheduleStep(rec.id)
  }

  scheduleStep(job_id: string) {
    void this.d.track(this.negotiate(job_id))
  }

  private bundle(rec: JobRecord, fresh: Awaited<ReturnType<CheckRunner['run']>>): MediationBundle {
    const contract = this.d.buildContract(rec)!
    const messages = this.d.room.list(rec.id)
    const lateBy = rec.delivered_at && rec.deadlines.deliver_by ? Math.max(0, (Date.parse(rec.delivered_at) - Date.parse(rec.deadlines.deliver_by)) / 60_000) : rec.deadlines.deliver_by ? Math.max(0, (this.d.nowMs() - Date.parse(rec.deadlines.deliver_by)) / 60_000) : 0
    let open = 0
    for (const m of messages) {
      if (m.type === 'blocker') open++
      else if (m.type === 'unblock' && open > 0) open--
    }
    return {
      job_id: rec.id,
      contract,
      contract_hash: rec.agreed_hash ?? rec.contract_hash!,
      messages,
      delivery: rec.delivery,
      checks: fresh.length ? fresh : this.checks.latest(rec.id),
      fulfilment: rec.fulfilment,
      timeline: { late_by_minutes: Math.round(lateBy), unanswered_blockers: open, vague_rejections: rec.review.rejections.filter((r) => r.reason.trim().length < 20 && !r.check).length },
      dispute: { opened_by: rec.mediation!.opened_by, reason: rec.mediation!.reason, claims: rec.mediation!.claims },
      // What the seller already got is not negotiable; the rest of the authorization is (authorized − already released).
      amounts: {
        authorized: usd(rec.escrow.authorized),
        already_captured: usd(rec.mediation!.released_cents),
        platform_fee_bps: rec.fees.platform_bps,
        platform_fee_floor_cents: toCents(rec.fees.floor),
        mediation_flat: { value: rec.fees.mediation_flat, currency: 'USD' },
      },
      answers: (rec.mediation!.questions ?? []).map((q) => ({ question_id: q.id, to: q.to, question: q.text, answer: q.answer })),
    }
  }

  private roundDeadline() {
    return new Date(this.d.nowMs() + this.d.dur(this.d.cfg.mediationRound)).toISOString()
  }

  /**
   * One mediator step: assess + propose round 1 after a dispute opens, or post the next round once every proposal of the
   * round is answered or the round ended. The model calls happen outside the job lock; the result is applied under it.
   */
  async negotiate(job_id: string) {
    if (this.stepping.has(job_id)) return
    this.stepping.add(job_id)
    try {
      await this.negotiateOnce(job_id)
    } finally {
      this.stepping.delete(job_id)
    }
  }

  private async negotiateOnce(job_id: string) {
    type Prep = { mode: 'open' | 'advance'; bundle: MediationBundle; assessment: Assessment | null; history: Proposal[]; round: number; timedOut: boolean }
    const prep = await this.d.withLock(job_id, async (): Promise<Prep | null> => {
      const rec = this.d.load(job_id)
      const m = rec.mediation
      if (rec.state !== 'DISPUTED' || !m) return null
      const ms = m.state
      if (ms.status === 'investigating') {
        const fresh = rec.delivery ? await this.checks.run(rec, 'all') : [] // the mediator never trusts a party's claim about a check
        this.d.save(rec)
        return { mode: 'open', bundle: this.bundle(rec, fresh), assessment: null, history: [], round: 1, timedOut: false }
      }
      let timedOut = false
      if (ms.status === 'negotiating') {
        const agreed = findAgreement(ms.proposals)
        if (agreed) {
          await this.safeExecuteAgreement(rec, agreed)
          return null
        }
        timedOut = !!ms.deadline && this.d.nowMs() >= Date.parse(ms.deadline)
        if (!timedOut && !roundComplete(ms.proposals, ms.round)) return null
        ms.status = 'proposing'
        this.d.save(rec)
      } else if (ms.status !== 'proposing') return null
      if (!ms.assessment) return null
      return { mode: 'advance', bundle: this.bundle(rec, []), assessment: ms.assessment, history: ms.proposals, round: ms.round + 1, timedOut }
    })
    if (!prep) return
    let assessment = prep.assessment
    let result: ProposeResult | null = null
    let failure: string | null = null
    try {
      assessment ??= await this.d.intel.negotiator.assess(prep.bundle)
      result = await this.d.intel.negotiator.propose(prep.bundle, assessment, prep.history, prep.round)
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
    await this.d.withLock(job_id, async () => {
      const rec = this.d.load(job_id)
      const m = rec.mediation
      if (rec.state !== 'DISPUTED' || !m) return
      const ms = m.state
      const expected = prep.mode === 'open' ? ms.status === 'investigating' : ms.status === 'proposing' && ms.round + 1 === prep.round
      if (!expected) return
      if (!result || !assessment) return this.escalate(rec, `The mediator failed: ${failure ?? 'no result'}`)
      this.applyProposals(rec, assessment, result, prep.round, prep.timedOut)
    })
  }

  private applyProposals(rec: JobRecord, assessment: Assessment, result: ProposeResult, round: number, timedOut: boolean) {
    const m = rec.mediation!
    const ms = m.state
    if (round === 1) ms.assessment = assessment
    const a = ms.assessment!
    // Earlier open proposals are closed: rejected if a side said no, expired if nobody answered in time, otherwise superseded.
    const closing = new Set(result.supersedes)
    for (const p of ms.proposals) {
      if (p.status !== 'open' || !closing.has(p.id)) continue
      const rejected = p.responses.buyer?.answer === 'reject' || p.responses.seller?.answer === 'reject'
      p.status = rejected ? 'rejected' : timedOut && !(p.responses.buyer && p.responses.seller) ? 'expired' : 'superseded'
    }
    for (const f of result.new_flags) if (!a.integrity_flags.some((x) => x.party === f.party && x.message_id !== null && x.message_id === f.message_id)) a.integrity_flags.push(f)
    if (timedOut) this.d.system(rec, `Round ${round - 1} ended: proposals nobody answered count as no answer.`)
    if (result.outcome === 'agreed') return this.d.save(rec) // an acceptance is executed by respond() or the next tick; never here
    if (result.outcome === 'no_agreement' || (!result.done && result.proposals.length === 0)) {
      ms.status = 'no_agreement'
      ms.deadline = null
      this.d.post(rec, MEDIATOR, 'note', result.message.slice(0, 8000), { round, outcome: 'no_agreement', integrity_flags: result.new_flags })
      this.d.save(rec)
      return this.recommend(rec)
    }
    const stamp = this.d.nowIso()
    for (const p of result.proposals) ms.proposals.push({ ...p, created_at: p.created_at ?? stamp })
    ms.round = round
    ms.status = 'negotiating'
    ms.deadline = this.roundDeadline()
    this.d.post(rec, MEDIATOR, 'proposal', result.message.slice(0, 8000), {
      round,
      deadline: ms.deadline,
      proposals: result.proposals.map((p) => ({ id: p.id, kind: p.kind, terms: p.terms, preview: p.preview ?? null, rationale: p.rationale })),
      integrity_flags: result.new_flags,
    })
    this.d.save(rec)
  }

  /** No agreement: the mediator's last fair proposal becomes the recommended ruling (or goes straight to a human). */
  private recommend(rec: JobRecord) {
    const ms = rec.mediation!.state
    const bundle = this.bundle(rec, [])
    const fin = this.d.intel.negotiator.finalRecommendation(bundle, ms.assessment!, ms.proposals)
    this.applyRuling(rec, { ...fin.ruling, remedy: this.totalRemedy(rec, fin.remedy) })
  }

  /** The negotiator speaks in "what is still available"; rulings state the seller's TOTAL gross (including anything already released). */
  private totalRemedy(rec: JobRecord, remedy: Remedy): Remedy {
    const released = rec.mediation?.released_cents ?? rec.escrow.seller_release
    const total = released + toCents(remedy.release_to_seller.value)
    const refund = toCents(remedy.refund_to_buyer.value)
    return { ...remedy, type: refund === 0 ? 'release_full' : total === released ? 'refund_full' : 'split', release_to_seller: usd(total) }
  }

  /** A party answers a proposal: accept, reject (reason) or counter (terms). Both accepting the same proposal executes it. */
  async respond(rec: JobRecord, role: 'buyer' | 'seller', from: From, input: { proposal_id: string; answer: 'accept' | 'reject' | 'counter'; reason?: string | undefined; terms?: CounterTerms | undefined }): Promise<string> {
    const m = rec.mediation
    const ms = m?.state
    if (!m || !ms) throw new OpError('invalid_state', 'There is no mediation on this job.', 'Open a dispute first (open_dispute).')
    if (ms.status !== 'negotiating') {
      const why =
        ms.status === 'investigating' || ms.status === 'proposing'
          ? 'The mediator is still preparing the proposals.'
          : ms.status === 'agreed'
            ? 'The parties already agreed.'
            : 'Negotiation is over: the recommended ruling is out.'
      throw new OpError('invalid_state', `${why} (mediation is ${ms.status}).`, 'Call get_mediation; next_actions lists what you can do now.')
    }
    if (ms.deadline && this.d.nowMs() >= Date.parse(ms.deadline)) throw new OpError('invalid_state', 'This round has ended; the mediator is posting the next one.', 'Call get_mediation in a moment and answer the new proposals.')
    const p = ms.proposals.find((x) => x.id === input.proposal_id)
    if (!p) throw new OpError('not_found', `No proposal ${input.proposal_id} in this mediation.`, 'get_mediation lists the proposal ids.')
    if (p.status !== 'open') throw new OpError('invalid_state', `Proposal ${p.id} is ${p.status}.`, 'Answer an open proposal; get_mediation lists them.')
    if (p.responses[role]) throw new OpError('invalid_state', `You already answered proposal ${p.id} (${p.responses[role]!.answer}).`, 'Each proposal can be answered once: answer another open proposal, or add_statement.')
    const reason = (input.reason ?? '').trim()
    if (input.answer === 'reject' && reason.length < 3) throw new OpError('invalid_input', 'A rejection needs a reason.', 'Say which term you cannot accept and why (reason).')
    if (input.answer === 'counter' && !input.terms) throw new OpError('invalid_input', 'A counter needs terms.', 'Send only the fields you change, e.g. terms: { "release_now": "40.00" }.')
    const a = ms.assessment!
    const bundle = this.bundle(rec, [])
    const ev = input.answer === 'counter' ? this.d.intel.negotiator.evaluateCounter(bundle, a, { by: role, terms: input.terms!, base: p.terms, reason }) : null
    if (ev && !ev.ok) throw new OpError('invalid_input', `Counter not executable: ${ev.errors.join('; ')}.`, ev.explanation)

    const verb = input.answer === 'accept' ? 'accepted' : input.answer === 'reject' ? 'rejected' : 'countered'
    const msg = this.d.post(rec, from, 'proposal_response', `The ${role} ${verb} proposal ${p.id}${reason ? `: ${reason}` : '.'}`.slice(0, 8000), {
      proposal_id: p.id,
      answer: input.answer,
      reason,
      terms: input.terms ?? null,
      normalized: ev?.normalized ?? null,
      flags: ev?.flags ?? [],
    })
    p.responses[role] = { answer: input.answer, reason, terms: input.terms ?? null, message_id: msg.id, ts: this.d.nowIso() }

    // Text addressed to the mediator is data: flag it now (both sides see it) and it can never improve its sender's terms.
    const scanned = [reason, input.terms?.note ?? '', input.terms?.redo?.instruction ?? ''].filter(Boolean).join('\n')
    const hits = scanned ? scanText({ party: role, message_id: msg.id, source: `response:${p.id}`, text: scanned, argument: true }) : []
    if (hits.length) {
      a.integrity_flags.push({ party: role, message_id: msg.id, excerpt: hits[0]!.excerpt.slice(0, 400), kind: 'prompt_injection', round: ms.round })
      this.d.system(rec, `Integrity flag: the ${role}'s response contains text addressed to the mediator. It is ignored, shown to both sides, and cannot move any amount in the ${role}'s favour.`, { party: role, message_id: msg.id })
    }

    let explanation: string
    if (ev) {
      const cp = makeCounterProposal(rec.id, p, role, ev.normalized, ev.flags, reason, this.d.intel.negotiator.termsCtx(bundle, a), settlementFeesFrom(this.d.feePolicy(rec)))
      if (!ms.proposals.some((x) => x.id === cp.id)) {
        cp.created_at = this.d.nowIso()
        ms.proposals.push(cp)
        this.d.post(rec, from, 'proposal', `Counter-proposal ${cp.id} from the ${role}: ${termsSummary(cp.terms)}.`, { proposal_id: cp.id, round: cp.round, counters: p.id, terms: cp.terms, preview: cp.preview ?? null, flags: cp.flags })
      }
      explanation = ev.explanation
    } else explanation = input.answer === 'accept' ? `You accepted proposal ${p.id}: ${termsSummary(p.terms)}.` : `You rejected proposal ${p.id}.`

    const agreed = findAgreement(ms.proposals)
    this.d.save(rec)
    if (agreed) {
      const ok = await this.safeExecuteAgreement(rec, agreed)
      return ok ? `${explanation} Both sides accepted proposal ${agreed.id}; it was executed.` : `${explanation} Both sides accepted proposal ${agreed.id}; PayPal did not complete the execution, the platform retries automatically.`
    }
    if (roundComplete(ms.proposals, ms.round)) this.scheduleStep(rec.id)
    return explanation
  }

  /** executeAgreement that never loses the acceptance: a failing PayPal call is retried by the next tick. */
  private async safeExecuteAgreement(rec: JobRecord, p: Proposal): Promise<boolean> {
    try {
      await this.executeAgreement(rec, p)
      return true
    } catch (e) {
      console.error(`[mediation] ${rec.id}: executing agreement ${p.id} failed:`, e instanceof Error ? e.message : e)
      this.d.save(rec)
      return false
    }
  }

  /**
   * Execute the proposal both sides accepted, through the escrow service only.
   *   split / cancel : final settlement: capture release_now (final capture voids the rest), pay the seller, SETTLED.
   *   redo / substitute / wait : secure release_now (nothing is captured now: one capture per job), keep the held part, amend
   *     the contract, and let the agreed checks decide the held money (CURE for redo / substitute, DELIVERED for wait); the secured
   *     part and what the checks earn are paid together by the final settlement (escrow.release voids it below the minimum).
   * Money first, bookkeeping after: if PayPal fails the agreement stays accepted and the next tick retries; every escrow step is idempotent.
   */
  async executeAgreement(rec: JobRecord, p: Proposal) {
    const m = rec.mediation!
    const ms = m.state
    const e = rec.escrow
    const t = p.terms
    const released = m.released_cents // not e.seller_release: a failed first attempt may already have raised it
    const avail = e.authorized - released
    const R = toCents(t.release_now)
    const F = toCents(t.refund_now)
    const H = t.redo ? toCents(t.redo.amount_on_success) : t.wait_until ? avail - R - F : 0
    if (R < 0 || F < 0 || H < 0 || R + F + H !== avail) return this.escalate(rec, `The agreed proposal ${p.id} no longer adds up to the $${toAmount(avail)} still held (release $${toAmount(R)} + refund $${toAmount(F)} + held $${toAmount(H)}).`)
    const policy = this.d.feePolicy(rec)
    const secured = released + R
    const comm = commission(secured, policy) - commission(released, policy)
    const min = policy.min_settlement_cents
    const dollars = H
      ? `secure $${toAmount(R)} for the seller now, paid with the final settlement (the seller receives $${toAmount(R - comm)} after the $${toAmount(comm)} platform commission), refund $${toAmount(F)}, hold $${toAmount(H)}` +
        (secured < min ? `; if the seller's total stays below the $${toAmount(min)} minimum settlement it is voided, not paid` : '')
      : `release $${toAmount(R)} (the seller receives $${toAmount(R - comm)} after the $${toAmount(comm)} platform commission), refund $${toAmount(F)}`
    const label = `settled by agreement (${p.kind}, ${p.id})`

    if (H === 0) {
      await this.escrow.release(rec, secured, true, label)
      this.closeAgreed(rec, p, `Agreement: both sides accepted proposal ${p.id} (${p.kind}): ${dollars}. Executed on PayPal.`, { executed: 'final', release: toAmount(R), refund: toAmount(F), commission: toAmount(comm) })
      this.finish(rec, `settled by agreement: $${toAmount(secured)} released to the seller, $${toAmount(F)} returned to the buyer`)
      return
    }

    // Money still held for a redo / wait: the agreed part is only secured (rec.agreement.secured_cents → targetGross); no interim
    // capture, so the job keeps one capture and an untouched authorization stays re-authorizable.
    await this.escrow.refundNow(rec, F, 'Agreed refund returned to the buyer now.')
    const f = this.checks.recompute(rec)
    const kind = t.redo ? (p.kind === 'substitute' ? 'substitute' : 'redo') : 'wait'
    const now = this.d.nowMs()
    const dl = t.redo?.deadline ?? t.wait_until!
    const proposed = Date.parse(dl) - Date.parse(p.created_at ?? m.opened_at)
    const span = Number.isFinite(proposed) && proposed > 0 ? scaleMs(this.d.cfg, proposed) : this.d.dur(rec.timers.cure_window)
    const deadline = new Date(now + span).toISOString()
    const did = t.redo?.deliverable_id ?? null
    const failed = did ? (f?.units[did]?.failed ?? []) : []
    rec.agreement = {
      proposal_id: p.id,
      kind,
      deliverable_id: did,
      units: t.redo?.units ?? [],
      replaces: kind === 'substitute' ? failed.slice(0, t.redo!.units.length) : [],
      instruction: t.redo?.instruction ?? '',
      acceptance: t.redo?.acceptance ?? [],
      deadline,
      secured_cents: secured,
      held_cents: H,
      base_earned_cents: rec.earned_cents,
      agreed_at: this.d.nowIso(),
    }
    this.d.amend(rec, () => {
      rec.amendments.push({
        proposal_id: p.id,
        kind,
        deliverable_id: did,
        units: t.redo?.units ?? [],
        instruction: (t.redo?.instruction ?? '').slice(0, 600),
        deadline,
        acceptance: t.redo?.acceptance ?? [],
        amount_on_success: toAmount(H),
        agreed_at: rec.agreement!.agreed_at,
      })
    })
    this.closeAgreed(rec, p, `Agreement: both sides accepted proposal ${p.id} (${p.kind}): ${dollars}. The contract is amended (v${rec.version}); the agreed checks decide the held $${toAmount(H)}${kind === 'wait' ? ` when the wait ends (${deadline})` : `; the seller redelivers by ${deadline}`}.`, {
      executed: 'partial',
      release: toAmount(R),
      refund: toAmount(F),
      held: toAmount(H),
      commission: toAmount(comm),
      deadline,
      contract_version: rec.version,
    })
    if (kind === 'wait') {
      rec.review = { accepted: true, accepted_at: this.d.nowIso(), rejections: [] }
      rec.deadlines = { ...rec.deadlines, review_until: null, cure_until: null, appeal_until: null, verify_until: deadline }
      this.d.setState(rec, 'DELIVERED', `agreement: the held $${toAmount(H)} waits until ${deadline}, then the checks settle it`)
    } else {
      rec.review = { accepted: false, accepted_at: null, rejections: [] }
      rec.deadlines = { ...rec.deadlines, review_until: null, cure_until: deadline, verify_until: null, appeal_until: null }
      this.d.setState(rec, 'CURE', `agreement: the seller ${kind === 'redo' ? 'fixes' : 'replaces'} ${t.redo!.units.length} unit(s) by ${deadline}; the agreed checks decide the held $${toAmount(H)}`)
    }
    this.d.save(rec)
  }

  private closeAgreed(rec: JobRecord, p: Proposal, text: string, body: Record<string, unknown>) {
    const m = rec.mediation!
    const ms = m.state
    for (const x of ms.proposals) if (x.status === 'open') x.status = x.id === p.id ? 'accepted' : 'superseded'
    ms.agreed_proposal_id = p.id
    ms.status = 'agreed'
    ms.deadline = null
    m.closed_at = this.d.nowIso()
    this.d.post(rec, MEDIATOR, 'settlement', text.slice(0, 8000), { proposal_id: p.id, kind: p.kind, terms: p.terms, ...body })
    this.stats.feedItem('ruling', `${this.stats.botName(rec)}: dispute settled by agreement (${p.kind})`, null)
    this.d.save(rec)
  }

  /** Mediator questions (not used by the negotiation mediator, kept for jobs that already have one). */
  answer(rec: JobRecord, role: 'buyer' | 'seller', question_id: string, answer: string) {
    const m = rec.mediation
    const q = m?.questions.find((x) => x.id === question_id)
    if (!m || !q) throw new OpError('not_found', `No open mediator question ${question_id}.`, 'The negotiation mediator works through proposals: use get_mediation and respond_to_proposal.')
    if (q.to !== role) throw new OpError('forbidden', 'That question is addressed to the other party.', 'Answer only questions addressed to you.')
    if (q.answer !== null) throw new OpError('invalid_state', 'This question was already answered.', 'Add more context with add_statement.')
    q.answer = answer
  }

  private escalate(rec: JobRecord, reason: string) {
    const m = rec.mediation
    if (m) {
      m.state.status = 'no_agreement'
      m.state.deadline = null
      m.closed_at ??= this.d.nowIso()
    }
    rec.deadlines.appeal_until = null
    this.d.setState(rec, 'APPEALED', `escalated to a human arbiter: ${reason}`, { escalation_reason: reason })
    this.d.save(rec)
  }

  /** Remedy amounts as cents: release to the seller (total, including anything already released). */
  remedyRelease(rec: JobRecord, remedy: Remedy): number {
    if (remedy.type === 'release_full') return rec.escrow.authorized
    if (remedy.type === 'refund_full') return rec.escrow.seller_release
    return toCents(remedy.release_to_seller.value)
  }

  /** null when the remedy can be executed as written; otherwise why a human must look at it. */
  validateRemedy(rec: JobRecord, remedy: Remedy): string | null {
    let release: number
    try {
      release = this.remedyRelease(rec, remedy)
    } catch {
      return 'the remedy amount is not a valid amount'
    }
    if (remedy.type === 'redo') return remedy.redo_deadline ? null : 'a redo remedy needs a redo_deadline'
    if (release > rec.escrow.authorized) return `release $${toAmount(release)} is more than the $${toAmount(rec.escrow.authorized)} held`
    if (release < rec.escrow.seller_release) return `release $${toAmount(release)} is less than the $${toAmount(rec.escrow.seller_release)} already released (cannot be taken back)`
    if (remedy.type === 'split') {
      const refund = toCents(remedy.refund_to_buyer.value)
      if (Math.abs(release + refund - rec.escrow.authorized) > 1) return `release + refund ($${toAmount(release + refund)}) does not add up to the $${toAmount(rec.escrow.authorized)} held`
    }
    return null
  }

  applyRuling(rec: JobRecord, r: Omit<Ruling, 'id' | 'created_at' | 'appealable_until'>) {
    const now = this.d.nowMs()
    const appealUntil = new Date(now + this.d.dur(rec.timers.appeal_window)).toISOString()
    const parsed = Ruling.safeParse({ ...r, id: newId('rul'), job_id: rec.id, contract_hash: rec.agreed_hash ?? rec.contract_hash, created_at: new Date(now).toISOString(), appealable_until: appealUntil })
    if (!parsed.success) return this.escalate(rec, `the mediator's ruling was malformed (${parsed.error.issues[0]?.message ?? 'invalid'})`)
    const ruling = parsed.data
    const problem = this.validateRemedy(rec, ruling.remedy)
    if (problem && !ruling.escalated) {
      ruling.escalated = true
      ruling.escalation_reason = `Remedy cannot be executed as written: ${problem}.`
    }
    rec.ruling = ruling
    rec.ruling_accepted_by = []
    if (rec.mediation) rec.mediation.closed_at ??= this.d.nowIso()
    this.d.post(rec, MEDIATOR, 'ruling', ruling.reasoning.slice(0, 2000), { ruling_id: ruling.id, remedy: ruling.remedy, confidence: ruling.confidence, escalated: ruling.escalated })
    this.d.bus.publish('ruling', rec.id, this.d.audience(rec, { arbiter: true }), `Ruling: ${ruling.remedy.type}, $${ruling.remedy.release_to_seller.value} to the seller`, { ruling_id: ruling.id, escalated: ruling.escalated })
    this.stats.feedItem('ruling', `${this.stats.botName(rec)}: dispute ruled (${ruling.remedy.type.replace('_', ' ')})`, null)
    if (ruling.escalated) {
      ruling.appealable_until = null
      return this.escalate(rec, ruling.escalation_reason ?? 'the mediator escalated the case')
    }
    rec.deadlines.appeal_until = appealUntil
    this.d.setState(rec, 'RULED', `ruling ${ruling.id}: ${ruling.remedy.type}; either side may appeal until ${appealUntil}`)
    this.d.save(rec)
  }

  /** Mediation fee from the contract, split by each side's faults (nobody at fault: half each, odd cent to the buyer). */
  mediationFees(rec: JobRecord): { buyer: number; seller: number } {
    const flat = toCents(rec.fees.mediation_flat)
    const r = rec.ruling
    return mediationFeeByFaults(flat, r?.seller_fault.length ?? 0, r?.buyer_fault.length ?? 0)
  }

  async executeRuling(rec: JobRecord, why: string) {
    const ruling = rec.ruling
    if (!ruling) throw new OpError('invalid_state', 'There is no ruling to execute.', 'Wait for the mediator.')
    const remedy = ruling.remedy
    if (remedy.type === 'redo') {
      const due = remedy.redo_deadline && Date.parse(remedy.redo_deadline) > this.d.nowMs() ? remedy.redo_deadline : new Date(this.d.nowMs() + this.d.dur(rec.timers.cure_window)).toISOString()
      rec.deadlines.cure_until = due
      rec.deadlines.appeal_until = null
      rec.review = { accepted: false, accepted_at: null, rejections: rec.review.rejections }
      this.d.setState(rec, 'CURE', `${why}: the seller must redo the work by ${due}`)
      this.d.save(rec)
      return
    }
    const problem = this.validateRemedy(rec, remedy)
    if (problem) throw new OpError('invalid_state', `The remedy cannot be executed: ${problem}.`, 'A human arbiter must override the remedy.')
    const release = this.remedyRelease(rec, remedy)
    await this.escrow.release(rec, release, true, `${why} (${remedy.type})`, this.mediationFees(rec))
    this.finish(rec, `${why}: ${remedy.type}, $${toAmount(release)} released to the seller`)
  }

  appeal(rec: JobRecord, role: 'buyer' | 'seller', grounds: string) {
    rec.appeal = { by: role, grounds, bond_cents: toCents(this.d.cfg.appealBond), bond_status: 'held', at: this.d.nowIso() }
    rec.deadlines.appeal_until = null
    this.d.setState(rec, 'APPEALED', `the ${role} appealed to a human arbiter (appeal bond $${this.d.cfg.appealBond} recorded)`)
    this.d.save(rec)
  }

  async arbiterDecide(rec: JobRecord, actor: Actor, decision: 'confirm' | 'override', releaseAmount: string | undefined, note: string) {
    const base = rec.ruling
    const userTag = `arbiter:${actor.user_id ?? actor.agent_id}`
    let before: number | null = null
    try {
      before = base ? this.remedyRelease(rec, base.remedy) : null
    } catch {
      before = null
    }
    if (decision === 'confirm') {
      if (!base) throw new OpError('invalid_state', 'There is no AI ruling to confirm.', 'Override with release_to_seller instead.')
      if (this.validateRemedy(rec, base.remedy)) throw new OpError('invalid_input', `The AI remedy cannot be executed: ${this.validateRemedy(rec, base.remedy)}.`, 'Override with a release_to_seller amount.')
      rec.ruling = { ...base, tier: 'T3', escalated: false, decided_by: userTag, reasoning: `${base.reasoning}\n\nArbiter confirmed: ${note}`.slice(0, 4000) }
    } else {
      if (!releaseAmount) throw new OpError('invalid_input', 'An override needs release_to_seller.', 'Give the total amount the seller should receive, e.g. "40.00".')
      const release = toCents(releaseAmount)
      const e = rec.escrow
      if (release > e.authorized || release < e.seller_release)
        throw new OpError('invalid_input', `release_to_seller must be between $${toAmount(e.seller_release)} (already released) and $${toAmount(e.authorized)} (held).`, 'Pick an amount inside that range.')
      const remedy: Remedy = {
        type: release === e.authorized ? 'release_full' : release === e.seller_release ? 'refund_full' : 'split',
        release_to_seller: usd(release),
        refund_to_buyer: usd(e.authorized - release),
        fees: base?.remedy.fees ?? { platform: usd(0), mediation: { value: rec.fees.mediation_flat, currency: 'USD' } },
        redo_deadline: null,
      }
      rec.ruling = {
        ...(base ?? {
          id: newId('rul'),
          job_id: rec.id,
          contract_hash: rec.agreed_hash ?? rec.contract_hash!,
          findings: [],
          buyer_fault: [],
          seller_fault: [],
          confidence: 1,
          jury: [],
          integrity_flags: [],
          escalation_reason: null,
          appealable_until: null,
          created_at: this.d.nowIso(),
        }),
        tier: 'T3',
        remedy,
        escalated: false,
        decided_by: userTag,
        reasoning: `Arbiter override: ${note}`.slice(0, 4000),
      }
    }
    if (rec.appeal) {
      const after = this.remedyRelease(rec, rec.ruling!.remedy)
      const won = before !== null && (rec.appeal.by === 'seller' ? after > before : after < before)
      rec.appeal.bond_status = won ? 'refunded' : 'forfeited'
      this.d.system(rec, `Appeal bond of $${toAmount(rec.appeal.bond_cents)} ${won ? 'refunded to' : 'kept from'} the ${rec.appeal.by} (ledger entry).`)
    }
    if (rec.mediation) rec.mediation.closed_at ??= this.d.nowIso()
    this.d.save(rec)
    await this.executeRuling(rec, `arbiter decision (${decision})`)
  }

  // ---------- timers ----------
  async tickJob(job_id: string) {
    await this.d.withLock(job_id, async () => {
      const rec = this.d.tryLoad(job_id)
      if (!rec) return
      const now = this.d.nowMs()
      const past = (t: string | null) => !!t && now >= Date.parse(t)
      try {
        switch (rec.state) {
          case 'AGREED':
            if (past(rec.deadlines.fund_by)) {
              this.d.setState(rec, 'EXPIRED', 'not funded before fund_by; nothing was charged')
              this.d.save(rec)
            }
            return
          case 'AWAITING_APPROVAL':
            if (past(rec.deadlines.fund_by)) {
              await this.escrow.returnAll(rec, 'approval not completed before fund_by')
              this.d.setState(rec, 'EXPIRED', 'the PayPal approval was not completed before fund_by; nothing was charged')
              this.d.save(rec)
            }
            return
          case 'DELIVERED':
            await this.escrow.reauthorizeIfDue(rec)
            if (!rec.review.accepted && past(rec.deadlines.review_until)) {
              if (rec.held_pending_cents > 0) await this.checks.run(rec, 'pending')
              await this.settleEarned(rec, 'review window ended: auto-release of what passed')
            } else if (rec.review.accepted && past(rec.deadlines.verify_until)) {
              await this.checks.run(rec, 'pending')
              await this.settleEarned(rec, 'verify window ended: delayed checks re-run, final settlement')
            }
            return
          case 'CURE':
            await this.escrow.reauthorizeIfDue(rec)
            if (past(rec.deadlines.cure_until)) await this.settleEarned(rec, rec.agreement ? 'the agreed redo window ended' : 'cure window ended without a redelivery: rejected units are not paid', { excludeRejected: true })
            return
          case 'IN_PROGRESS':
          case 'BLOCKED':
          case 'APPEALED':
            await this.escrow.reauthorizeIfDue(rec)
            return
          case 'DISPUTED': {
            await this.escrow.reauthorizeIfDue(rec)
            const ms = rec.mediation?.state
            if (!ms) return
            // Resume after a restart, execute an acceptance whose PayPal call failed, or end a round whose time is up.
            if (ms.status === 'investigating' || ms.status === 'proposing') this.scheduleStep(rec.id)
            else if (ms.status === 'negotiating' && (findAgreement(ms.proposals) || roundComplete(ms.proposals, ms.round) || past(ms.deadline))) this.scheduleStep(rec.id)
            return
          }
          case 'RULED':
            if (past(rec.deadlines.appeal_until)) await this.executeRuling(rec, 'appeal window ended: the ruling is final')
            return
        }
      } catch (e) {
        // A failing PayPal call must not stop the scheduler; it retries next tick.
        console.error(`[tick] ${job_id}:`, e instanceof Error ? e.message : e)
      }
    })
  }
}
