// Negotiation-first mediation (docs/MEDIATION.md): the mediator investigates, assesses, then proposes; the two bots answer
// accept / reject / counter for up to 3 rounds; a counter becomes a proposal the other side can accept; when both accept
// the same proposal it executes. State lives on `job.mediation` (the same place the real server puts it).
import { MAX_HOLD_DAYS, MAX_ROUNDS } from '@rentabot/shared'
import type { Assessment, CheckResult, CounterTerms, Delivery, Job, MediationState, Proposal, ProposalKind, ProposalTerms, Redo, SettlementPreview } from '../api/types'
import { emit } from './bus'
import type { Db } from './db'
import { append, captureUpTo, earnedTotal, feeFor, heldCents, later, makeArtifact, setState, system } from './engine'
import { fail, nextActions, requireJob } from './logic'
import { register } from './registry'
import { executeGross, findInjection, issueRuling, makeRuling } from './story'
import { DAY, HOUR, amt, cents, fakeHash, iso, rid, usd } from './util'

type Side = 'buyer' | 'seller'
const other = (r: Side): Side => (r === 'buyer' ? 'seller' : 'buyer')
const ROUND_MS = 1 * HOUR

export const SUBSTITUTE_DIRS = ['launchbase', 'toolnest', 'aibazaar', 'shipfast-dir', 'startupfuel', 'maker-index', 'promptpad', 'agenthub-list', 'saastrail', 'devtoolbox', 'newaiwave', 'stacklist']

export const getMed = (db: Db, jobId: string): MediationState | undefined => db.jobs[jobId]?.mediation ?? undefined
export const isHuman = (db: Db, jobId: string, role: Side) => ((db.scratch[`human:${jobId}`] as string[] | undefined) ?? []).includes(role)
export function markHuman(db: Db, jobId: string, role: string) {
  const list = (db.scratch[`human:${jobId}`] ??= []) as string[]
  if (!list.includes(role)) list.push(role)
}
export const openProposals = (med: MediationState | null | undefined) => (med?.proposals ?? []).filter((p) => p.status === 'open')
/** Who still has to answer this proposal. A party's own counter counts as its acceptance. */
export const awaiting = (p: Proposal): Side[] => (['buyer', 'seller'] as const).filter((r) => p.by !== r && !p.responses[r])
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

const dollars = (c: number) => `$${amt(c)}`

// ---------------------------------------------------------------- terms, ranges, previews
/** The fair range is on the seller's TOTAL (anything already captured counts): [what the checks verified, most the evidence supports]. */
export function fairRange(job: Job): [number, number] {
  const auth = cents(job.escrow.authorized.value)
  const verified = Math.min(earnedTotal(job), auth)
  const unverified = Math.max(auth - verified, 0)
  return [verified, verified + Math.round((unverified * 4) / 9)]
}

const capturedC = (job: Job) => cents(job.escrow.captured.value)
const mkTerms = (t: Partial<ProposalTerms> & Pick<ProposalTerms, 'release_now' | 'refund_now'>): ProposalTerms => ({ redo: null, wait_until: null, cancel: false, note: '', ...t })

/** What is held after the terms run: the redo amount, or whatever remains under a wait. */
function heldOf(job: Job, t: ProposalTerms): number {
  if (t.redo) return cents(t.redo.amount_on_success)
  if (t.wait_until) return Math.max(heldCents(job) - cents(t.release_now) - cents(t.refund_now), 0)
  return 0
}

function previewOf(job: Job, t: ProposalTerms): SettlementPreview {
  const c = capturedC(job)
  const rel = cents(t.release_now)
  const held = heldOf(job, t)
  const commission = Math.min(Math.max(feeFor(c + rel) - feeFor(c), 0), rel)
  const heldCommission = Math.min(Math.max(feeFor(c + rel + held) - feeFor(c + rel), 0), held)
  return {
    capture_now: amt(rel),
    void_now: t.refund_now,
    held: amt(held),
    platform_commission: amt(commission),
    seller_payout_now: amt(rel - commission),
    held_commission: amt(heldCommission),
    held_seller_payout: amt(held - heldCommission),
  }
}

function flagsFor(job: Job, t: ProposalTerms): string[] {
  const [lo, hi] = fairRange(job)
  const total = capturedC(job) + cents(t.release_now)
  return total > hi ? ['outside_fair_range_high'] : total < lo ? ['outside_fair_range_low'] : []
}

/** The mediator's opening proposal, computed from what the checks verified. */
function baseProposal(db: Db, job: Job): { terms: ProposalTerms; kind: ProposalKind } {
  const auth = cents(job.escrow.authorized.value)
  const earned = Math.min(earnedTotal(job), auth)
  const U = heldCents(job)
  const release = Math.min(Math.max(earned - capturedC(job), 0), U)
  const rest = U - release
  const failed = job.fulfilment.reduce((a, f) => a + f.failed_units, 0)
  const d = job.contract?.spec.deliverables[0]
  const bot = db.bots[job.seller_bot_id]
  const substitute = bot?.id === 'bot_DirectoryBlaster'
  if (rest > 0 && failed > 0 && d) {
    const units = Array.from({ length: failed }, (_, i) => (substitute ? (SUBSTITUTE_DIRS[i] ?? `substitute-${i + 1}`) : `redo-${i + 1}`))
    const redo: Redo = {
      deliverable_id: d.id,
      units,
      instruction: substitute ? `Resubmit to ${failed} other directories from the catalog` : `Redo the ${failed} failing units`,
      deadline: iso(Date.now() + 48 * HOUR),
      amount_on_success: amt(rest),
      acceptance: d.acceptance,
    }
    return { terms: mkTerms({ release_now: amt(release), refund_now: '0.00', redo }), kind: substitute ? 'substitute' : 'redo' }
  }
  if (earned === 0 && rest > 0) return { terms: mkTerms({ release_now: '0.00', refund_now: amt(rest), cancel: true }), kind: 'cancel' }
  return { terms: mkTerms({ release_now: amt(release), refund_now: amt(rest) }), kind: 'split' }
}

function describe(t: ProposalTerms): string {
  if (t.cancel) return `Cancel the job and return ${dollars(cents(t.refund_now))} to the buyer; no fees apply to money that is never captured.`
  const rel = cents(t.release_now)
  const parts = [rel > 0 ? `Release ${dollars(rel)} to the seller now` : 'Release nothing more now']
  if (cents(t.refund_now) > 0) parts.push(`return ${dollars(cents(t.refund_now))} to the buyer`)
  if (t.redo) parts.push(`hold ${dollars(cents(t.redo.amount_on_success))} for ${t.redo.units.length} unit${t.redo.units.length === 1 ? '' : 's'} (${t.redo.instruction.charAt(0).toLowerCase()}${t.redo.instruction.slice(1)}) due ${t.redo.deadline.slice(0, 16).replace('T', ' ')} UTC, then the checks settle the held amount automatically`)
  else if (t.wait_until) parts.push(`hold the rest until ${t.wait_until.slice(0, 16).replace('T', ' ')} UTC, then settle by the checks`)
  return `${parts.join(', ')}.`
}

function newProposal(job: Job, round: number, by: Proposal['by'], kind: ProposalKind, terms: ProposalTerms, rationale: string, counters: string | null): Proposal {
  const now = new Date().toISOString()
  return {
    id: rid('prp'),
    round,
    by,
    kind,
    status: 'open',
    terms,
    rationale,
    flags: by === 'mediator' ? [] : flagsFor(job, terms),
    preview: previewOf(job, terms),
    counters,
    // a party's own counter-proposal is its implicit acceptance
    responses: by === 'mediator' ? {} : { [by]: { answer: 'accept', reason: '', terms: null, message_id: null, ts: now } },
    created_at: now,
  }
}

function postProposal(db: Db, job: Job, p: Proposal, assessment?: Assessment) {
  const med = job.mediation!
  const text = p.by === 'mediator' ? `Proposal, round ${p.round}. ${p.rationale}` : `Counter-proposal from the ${p.by}. ${p.rationale}`
  const m = append(db, job, p.by, 'proposal', text, { proposal: clone(p), ...(assessment ? { assessment } : {}), round: p.round, round_deadline: med.deadline })
  emit('message', job.id, p.by === 'mediator' ? `Mediator posted a proposal (round ${p.round})` : `The ${p.by} counter-proposed`, { proposal_id: p.id })
  return m
}

// ---------------------------------------------------------------- opening
export function startMediation(db: Db, job: Job) {
  job.mediation = { status: 'investigating', round: 0, deadline: iso(Date.now() + 2 * HOUR), assessment: null, proposals: [], agreed_proposal_id: null }
  later(1500, () => {
    const j = db.jobs[job.id]
    if (!j || j.state !== 'DISPUTED') return
    const flag = findInjection(db, j)
    system(db, j, `Mediator re-ran every check itself. Results are identical to the first run.${flag ? ' A party message contains an instruction addressed to the mediator. It is treated as data and flagged.' : ''}`, { event: flag ? 'integrity_flag' : 'rechecked', flag: Boolean(flag) })
    j.mediation!.status = 'proposing'
    later(1000, () => postFirstProposal(db, j))
  })
}

function postFirstProposal(db: Db, j: Job) {
  const med = j.mediation
  if (!med || j.state !== 'DISPUTED') return
  const rec = makeRuling(db, j)
  const [lo, hi] = fairRange(j)
  const auth = cents(j.escrow.authorized.value)
  const passed = j.fulfilment.reduce((a, f) => a + f.passed_units, 0)
  const expected = j.fulfilment.reduce((a, f) => a + f.expected_units, 0)
  const assessment: Assessment = {
    verified_value: amt(lo),
    claimed_value: amt(auth),
    fair_range: [amt(lo), amt(hi)],
    findings: rec.findings,
    integrity_flags: rec.integrity_flags.map((f) => ({ ...f, round: 0 })),
    jury: rec.jury,
    faults: { buyer: rec.buyer_fault, seller: rec.seller_fault },
    summary: `${passed} of ${expected} units verified by the checks, worth ${dollars(lo)}. The most the evidence could support is ${dollars(hi)}. The seller claims ${dollars(auth)}; the claim that moderation lag caused the failures is not supported by the evidence in the room.`,
    confidence: rec.confidence,
    basis: 'jury',
    escalation_reasons: rec.escalation_reason ? [rec.escalation_reason] : [],
  }
  med.assessment = assessment
  const { terms, kind } = baseProposal(db, j)
  med.round = 1
  med.status = 'negotiating'
  med.deadline = iso(Date.now() + ROUND_MS)
  const p = newProposal(j, 1, 'mediator', kind, terms, describe(terms), null)
  med.proposals.push(p)
  postProposal(db, j, p, assessment)
  botsRespond(db, j, p)
}

// ---------------------------------------------------------------- the bots answer
function botsRespond(db: Db, job: Job, p: Proposal) {
  const roles: Side[] = p.by === 'mediator' ? ['seller', 'buyer'] : [other(p.by as Side)]
  for (const role of roles) {
    if (isHuman(db, job.id, role)) continue
    later(p.by === 'mediator' ? (role === 'seller' ? 3000 : 3600) : 2500, () => {
      const j = db.jobs[job.id]
      const cur = j?.mediation?.proposals.find((x) => x.id === p.id)
      if (!j || j.state !== 'DISPUTED' || j.mediation?.status !== 'negotiating' || !cur || cur.status !== 'open' || cur.responses[role]) return
      if (cur.by !== 'mediator') {
        if (cur.flags.length) answer(db, j, role, cur, 'reject', cur.flags.includes('outside_fair_range_high') ? 'That puts the seller above what the checks verified, and the evidence does not support more.' : 'That is below what the checks verified.')
        else answer(db, j, role, cur, 'accept')
        return
      }
      if (role === 'buyer') return void answer(db, j, role, cur, 'accept')
      const U = heldCents(j)
      if (cur.round === 1 && cents(cur.terms.release_now) < U) {
        answer(db, j, role, cur, 'counter', 'The failing listings were live when I submitted; the directories moderate slowly. Release the full amount now.', { release_now: amt(U), refund_now: '0.00', redo: null })
      } else answer(db, j, role, cur, 'accept')
    })
  }
}

// ---------------------------------------------------------------- counters: fill in, check, explain
const bad = (message: string, hint = 'Fix the terms and send the counter again.'): never => fail(400, 'invalid_input', message, hint)

function checkDate(label: string, ts: string) {
  const t = new Date(ts).getTime()
  if (Number.isNaN(t)) bad(`${label} is not a valid date.`)
  if (t <= Date.now()) bad(`${label} must be in the future.`)
  if (t > Date.now() + MAX_HOLD_DAYS * DAY) bad(`${label} is more than ${MAX_HOLD_DAYS} days out.`, `Redo and wait deadlines may be at most ${MAX_HOLD_DAYS} days from now.`)
}

export function normalizeCounter(db: Db, job: Job, base: Proposal, ct: CounterTerms): { terms: ProposalTerms; kind: ProposalKind; notes: string[] } {
  const U = heldCents(job)
  const bt = base.terms
  const notes: string[] = []
  const cancel = ct.cancel ?? bt.cancel
  let redo: Redo | null = null
  let wait: string | null = null
  if (!cancel) {
    if (ct.redo === undefined) redo = bt.redo
    else if (ct.redo === null) redo = null
    else {
      const merged = { ...(bt.redo ?? {}), ...Object.fromEntries(Object.entries(ct.redo).filter(([, v]) => v !== undefined)) } as Partial<Redo>
      const d = job.contract?.spec.deliverables.find((x) => x.id === merged.deliverable_id) ?? job.contract?.spec.deliverables[0]
      if (!merged.units?.length) bad('A redo needs at least one unit.', 'Name the units to redo or the new units to deliver.')
      if (!merged.deadline) bad('A redo needs a deadline.')
      if (merged.amount_on_success === undefined) bad('A redo needs amount_on_success: how much stays held for it.')
      redo = { deliverable_id: merged.deliverable_id ?? d?.id ?? 'D1', units: merged.units!, instruction: merged.instruction ?? '', deadline: merged.deadline!, amount_on_success: merged.amount_on_success!, acceptance: merged.acceptance?.length ? merged.acceptance : (d?.acceptance ?? []) }
    }
    wait = ct.wait_until === undefined ? bt.wait_until : ct.wait_until
    if (redo && redo.deadline !== bt.redo?.deadline) checkDate('The redo deadline', redo.deadline)
    if (wait && wait !== bt.wait_until) checkDate('wait_until', wait)
    if (redo && wait) bad('Use either a redo or a wait, not both.', 'A redo already holds the money until the checks settle it.')
  }
  const waiting = !redo && Boolean(wait)
  const heldFixed = redo ? cents(redo.amount_on_success) : 0
  if (heldFixed > U) bad(`amount_on_success ${dollars(heldFixed)} is more than the ${dollars(U)} that is still uncaptured.`)
  let rel = ct.release_now !== undefined ? cents(ct.release_now) : undefined
  let ref = ct.refund_now !== undefined ? cents(ct.refund_now) : undefined
  if (cancel) {
    if (rel) bad('A cancel releases nothing.', 'Remove release_now, or untick cancel.')
    rel = 0
    ref = U
    notes.push(`Cancel returns the whole uncaptured ${dollars(U)} to the buyer.`)
  } else if (rel !== undefined && ref !== undefined) {
    const held = waiting ? U - rel - ref : heldFixed
    if (rel + ref + held !== U) bad(`release_now ${dollars(rel)} + refund_now ${dollars(ref)} + held ${dollars(held)} must equal the ${dollars(U)} that is still uncaptured.`, 'Leave one amount out and the server fills it in.')
  } else if (rel !== undefined) {
    ref = waiting ? 0 : U - rel - heldFixed
    notes.push(`I filled in refund_now as ${dollars(Math.max(ref, 0))}, so release + refund + held equals the ${dollars(U)} still uncaptured.`)
  } else if (ref !== undefined) {
    rel = waiting ? 0 : U - ref - heldFixed
    notes.push(`I filled in release_now as ${dollars(Math.max(rel, 0))}, so release + refund + held equals the ${dollars(U)} still uncaptured.`)
  } else {
    rel = cents(bt.release_now)
    ref = waiting ? 0 : U - rel - heldFixed
    if (cents(bt.refund_now) !== ref) notes.push(`I kept release_now at ${dollars(rel)} and set refund_now to ${dollars(Math.max(ref, 0))} so the amounts add up to ${dollars(U)}.`)
  }
  if ((rel ?? 0) < 0 || (ref ?? 0) < 0) bad(`Those amounts do not fit in the ${dollars(U)} that is still uncaptured: release + refund + held would be more than that.`, 'Lower the amounts, or shrink the redo amount.')
  const terms = mkTerms({ release_now: amt(rel!), refund_now: amt(ref!), redo, wait_until: wait, cancel, note: ct.note ?? bt.note })
  const kind: ProposalKind = cancel ? 'cancel' : redo ? (base.kind === 'substitute' ? 'substitute' : 'redo') : wait ? 'wait' : 'split'

  const [lo, hi] = fairRange(job)
  const total = capturedC(job) + rel!
  const inside = total >= lo && total <= hi
  notes.push(`Your terms put the seller's total at ${dollars(total)} (${dollars(capturedC(job))} already captured plus ${dollars(rel!)} now). The fair range is ${dollars(lo)} to ${dollars(hi)}: ${inside ? 'inside' : total > hi ? 'above it' : 'below it'}.`)
  notes.push(inside ? 'It becomes a proposal the other side can accept directly, and the mediator can carry it into the next round.' : 'It becomes a proposal the other side can accept directly, but the mediator will not carry out-of-range amounts into the next round.')
  return { terms, kind, notes }
}

// ---------------------------------------------------------------- answers
/** One answer to one proposal: records it, posts it in the room, turns a counter into a proposal, then advances the negotiation. Returns the explanation. */
export function answer(db: Db, job: Job, role: Side, p: Proposal, ans: 'accept' | 'reject' | 'counter', reason = '', counter?: CounterTerms): string {
  const med = job.mediation!
  let explanation: string
  let norm: ReturnType<typeof normalizeCounter> | null = null
  if (ans === 'counter') {
    norm = normalizeCounter(db, job, p, counter ?? {})
    explanation = norm.notes.join(' ')
  } else if (ans === 'accept') {
    const other_ = p.responses[other(role)]?.answer === 'accept' || p.by === other(role)
    explanation = other_ ? 'Recorded. Both sides have accepted this proposal, so it executes now.' : `Recorded. It executes as soon as the ${other(role)} accepts the same proposal; the round ends ${med.deadline ? new Date(med.deadline).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'when everyone has answered'}.`
  } else {
    explanation = med.round >= MAX_ROUNDS ? 'Recorded. This was the last round: without agreement the mediator\'s last fair proposal becomes a recommended ruling.' : 'Recorded. The mediator reads your reason and posts a revised proposal when the round ends. You can still counter the other side\'s proposals.'
  }
  const cp = norm ? newProposal(job, p.round, role, norm.kind, norm.terms, describe(norm.terms), p.id) : null
  const body: Record<string, unknown> = { proposal_id: p.id, by: role, answer: ans, reason, ...(norm ? { terms: norm.terms, counter_proposal_id: cp!.id } : {}), explanation }
  const msg = append(db, job, role, 'proposal_response', ans === 'accept' ? 'Accepted.' : ans === 'reject' ? `Rejected: ${reason}` : `Counter${reason ? `: ${reason}` : '.'}`, body)
  p.responses[role] = { answer: ans, reason, terms: ans === 'counter' ? (counter ?? {}) : null, message_id: msg.id, ts: msg.ts }
  if (cp) {
    med.proposals.push(cp)
    postProposal(db, job, cp)
    botsRespond(db, job, cp)
  }
  advance(db, job)
  return explanation
}

function advance(db: Db, job: Job) {
  const med = job.mediation
  if (!med || med.status !== 'negotiating' || job.state !== 'DISPUTED') return
  const open = openProposals(med)
  const done = open.find((p) => p.responses.buyer?.answer === 'accept' && p.responses.seller?.answer === 'accept')
  if (done) return void execute(db, job, done)
  const round = open.filter((p) => p.round === med.round)
  if (!round.length || round.some((p) => awaiting(p).length)) return
  // every proposal of the round is answered and nobody agreed
  for (const p of round) p.status = med.round >= MAX_ROUNDS ? 'rejected' : 'superseded'
  if (med.round >= MAX_ROUNDS) {
    med.status = 'no_agreement'
    system(db, job, 'No agreement after 3 rounds. The mediator issues its last fair proposal as a recommended ruling.', { event: 'no_agreement' })
    later(1500, () => issueRuling(db, db.jobs[job.id]))
    return
  }
  later(2000, () => postNext(db, db.jobs[job.id]))
}

function postNext(db: Db, j: Job) {
  const med = j?.mediation
  if (!med || med.status !== 'negotiating' || j.state !== 'DISPUTED') return
  const prev = med.proposals.filter((p) => p.round === med.round)
  const base = prev.find((p) => p.by === 'mediator')
  if (!base) return
  const [lo, hi] = fairRange(j)
  const notes: string[] = []
  let terms = base.terms
  let kind = base.kind
  for (const role of ['seller', 'buyer'] as const) {
    const who = role === 'seller' ? 'The seller' : 'The buyer'
    const cp = prev.find((p) => p.by === role)
    const r = base.responses[role]
    if (cp) {
      const total = capturedC(j) + cents(cp.terms.release_now)
      if (total >= lo && total <= hi) {
        terms = cp.terms
        kind = cp.kind
        notes.push(`${who}'s counter (seller total ${dollars(total)}) is inside the fair range, so it is carried forward.`)
      } else notes.push(`${who}'s counter (seller total ${dollars(total)}) is outside the fair range (${dollars(lo)} to ${dollars(hi)}): the checks verified ${dollars(lo)} and the evidence does not support more, so it is not carried forward. The terms stay the same.`)
    } else if (r?.answer === 'reject') notes.push(`${who} rejected: "${r.reason || 'no reason given'}". The terms sit inside the fair range, so they stay the same.`)
    else if (r?.answer === 'accept') notes.push(`${who} accepted the last round.`)
  }
  const round = med.round + 1
  const final = round >= MAX_ROUNDS ? ' Final round: without agreement this becomes a recommended ruling.' : ''
  med.round = round
  med.deadline = iso(Date.now() + ROUND_MS)
  const p = newProposal(j, round, 'mediator', kind, terms, `${notes.join(' ')}${final}`.trim() || describe(terms), null)
  med.proposals.push(p)
  postProposal(db, j, p)
  botsRespond(db, j, p)
}

// ---------------------------------------------------------------- execution
function execute(db: Db, job: Job, p: Proposal) {
  const med = job.mediation!
  const t = p.terms
  const release = cents(t.release_now)
  p.status = 'accepted'
  for (const o of med.proposals) if (o.status === 'open' && o.id !== p.id) o.status = 'superseded'
  med.status = 'agreed'
  med.agreed_proposal_id = p.id
  const bot = db.bots[job.seller_bot_id]
  if (bot) bot.reputation = { ...bot.reputation, settled_by_agreement: bot.reputation.settled_by_agreement + 1 }
  system(db, job, `Both sides accepted proposal round ${p.round}. Executing the agreed terms.`, { event: 'agreed', proposal_id: p.id })
  const keepOpen = Boolean(t.redo || t.wait_until)
  if (!keepOpen) {
    executeGross(db, job, capturedC(job) + release, 'mediated settlement')
    return void postSettlement(db, job, p, null)
  }
  if (release > 0) captureUpTo(db, job, capturedC(job) + release, 'Mediated settlement: released now.')
  const c = job.contract!
  const held = heldOf(job, t)
  const deadline = t.redo ? t.redo.deadline : t.wait_until!
  const kind: 'redo' | 'substitute' | 'wait' = t.redo ? (p.kind === 'substitute' ? 'substitute' : 'redo') : 'wait'
  job.contract = {
    ...c,
    version: c.version + 1,
    amendments: [
      ...c.amendments,
      { proposal_id: p.id, kind, deliverable_id: t.redo?.deliverable_id ?? null, units: t.redo?.units ?? [], instruction: t.redo?.instruction ?? t.note, deadline, acceptance: t.redo?.acceptance ?? [], amount_on_success: amt(held), agreed_at: new Date().toISOString() },
    ],
  }
  // the amendment is signed by both sides (it was their agreement), so the signatures follow the new hash
  job.contract_hash = fakeHash(JSON.stringify(job.contract)) as Job['contract_hash']
  job.accepted_by = job.accepted_by.map((a) => ({ ...a, contract_hash: job.contract_hash!, ts: new Date().toISOString() }))
  job.deadlines = { ...job.deadlines, deliver_by: deadline, appeal_until: null, review_until: null, cure_until: null }
  setState(job, 'IN_PROGRESS', t.redo ? 'mediated settlement: seller redoes the failing units' : 'mediated settlement: waiting, then settle by the checks')
  if (t.redo) {
    db.scratch[`amend:${job.id}`] = { units: t.redo.units, deadline: t.redo.deadline, deliverable_id: t.redo.deliverable_id }
    system(db, job, `CONTRACT AMENDED (v${job.contract.version}). The seller delivers ${t.redo.units.length} unit${t.redo.units.length > 1 ? 's' : ''} by ${t.redo.deadline.slice(0, 16).replace('T', ' ')} UTC. ${dollars(held)} stays held until the checks settle it.`, { event: 'amended', units: t.redo.units })
    postSettlement(db, job, p, { units: t.redo.units, deadline: t.redo.deadline, note: t.redo.instruction, version: job.contract.version, deliverable_id: t.redo.deliverable_id })
    if (!isHuman(db, job.id, 'seller')) later(6000, () => processSubstitute(db, db.jobs[job.id], null))
  } else {
    system(db, job, `CONTRACT AMENDED (v${job.contract.version}). ${dollars(held)} stays held until ${t.wait_until!.slice(0, 16).replace('T', ' ')} UTC, then the checks decide.`, { event: 'amended', units: [] })
    postSettlement(db, job, p, { units: [], deadline: t.wait_until!, note: t.note || 'Held until the wait ends.', version: job.contract.version, deliverable_id: null })
    later(8000, () => {
      const j = db.jobs[job.id]
      if (!j || j.state !== 'IN_PROGRESS') return
      system(db, j, 'The wait ended. The mediator re-ran the checks: nothing changed, so the held amount is voided.', { event: 'checks' })
      executeGross(db, j, capturedC(j), 'wait ended, checks unchanged')
    })
  }
}

function postSettlement(db: Db, job: Job, p: Proposal, amendment: { units: string[]; deadline: string; note: string; version: number; deliverable_id: string | null } | null) {
  const e = job.escrow
  const body = {
    proposal_id: p.id,
    round: p.round,
    kind: p.kind,
    terms: p.terms,
    executed: { captured: e.captured.value, platform_fee: e.fees.value, seller_payout: e.paid_out.value, refunded: amt(cents(e.refunded.value) + cents(e.voided.value)), still_held: amt(heldCents(job)) },
    amendment,
  }
  append(db, job, 'platform', 'settlement', `Settlement agreed in round ${p.round}.`, body)
}

/** Seller delivers the substitute units from a mediated redo. All pass; the held money is captured and the job settles. */
export function processSubstitute(db: Db, job: Job, delivery: Delivery | null): CheckResult[] {
  const am = db.scratch[`amend:${job.id}`] as { units: string[]; deadline: string; deliverable_id: string } | undefined
  if (!am || !job.contract || job.state !== 'IN_PROGRESS') return []
  const d = job.contract.spec.deliverables.find((x) => x.id === am.deliverable_id) ?? job.contract.spec.deliverables[0]
  const units = delivery?.deliverables.find((x) => x.deliverable_id === d.id)?.units.map((u) => ({ ...u })) ?? am.units.map((ref) => ({ ref, url: `https://${ref}.sandbox.rentabot.test/orano`, artifact_ids: [makeArtifact(db, job.id, `${ref}-listing.png`, 'image/png', job.seller_agent_id).id], meta: {} }))
  const per = d.acceptance.filter((a) => db.checks.find((c) => c.id === a.check)?.per_unit ?? true)
  const checks: CheckResult[] = units.flatMap((u) =>
    per.map((a) => ({ id: rid('chk'), job_id: job.id, deliverable_id: d.id, unit_ref: u.ref, check: a.check, status: 'pass' as const, detail: 'verified on the substitute unit', evidence_id: rid('ev'), attempt: 1, ran_at: new Date().toISOString() })),
  )
  const body: Delivery = { deliverables: [{ deliverable_id: d.id, units: units.map((u) => ({ ...u, artifact_ids: u.artifact_ids ?? [], meta: u.meta ?? {} })), note: `${units.length} substitute units, as agreed in the mediated settlement.` }], note: 'Substitute delivery under the mediated amendment.' }
  append(db, job, 'seller', 'delivery', `Substitute delivery: ${units.length} units.`, { delivery: body, checks })
  emit('check', job.id, `${checks.length} of ${checks.length} substitute checks passed`, {})
  job.fulfilment = job.fulfilment.map((f) => {
    if (f.deliverable_id !== d.id) return f
    const line = job.contract!.quote.lines.find((l) => l.deliverable_id === d.id)
    const passed = f.passed_units + units.length
    const earned = line?.model === 'per_unit' ? Math.min(passed * cents(line.unit_price), cents(line.max_total)) : cents(f.earned.value)
    return { ...f, passed_units: passed, failed_units: Math.max(f.failed_units - units.length, 0), earned: usd(earned) }
  })
  delete db.scratch[`amend:${job.id}`]
  system(db, job, `All ${units.length} substitute units verified. The held amount is now earned.`, { event: 'checks' })
  executeGross(db, job, earnedTotal(job), 'substitute units verified')
  return checks
}

// ---------------------------------------------------------------- ops
export function registerMediationOps() {
  register('get_mediation', ({ job_id }, { db, caller }) => {
    const { job, role } = requireJob(db, job_id, caller)
    return { mediation: job.mediation ?? null, your_role: role, next_actions: nextActions(db, job, role) }
  })

  register('respond_to_proposal', ({ job_id, proposal_id, answer: ans, reason, terms }, { db, caller }) => {
    const { job, role } = requireJob(db, job_id, caller)
    if (role !== 'buyer' && role !== 'seller') fail(403, 'forbidden', 'Only the buyer and the seller answer proposals.', 'Arbiters act through arbiter_decide.')
    const me = role as Side
    if (job.state !== 'DISPUTED') fail(409, 'invalid_state', `This job is ${job.state}, not DISPUTED.`, 'Proposals exist only while a dispute is being mediated. Call get_mediation.')
    const med = job.mediation
    if (!med || med.status !== 'negotiating') fail(409, 'invalid_state', `The mediation is ${med?.status ?? 'not started'}, not negotiating.`, 'Wait for the mediator to post a proposal, then call get_mediation.', [{ op: 'get_mediation', why: 'See where the mediation stands.', args: { job_id } }])
    const p = med!.proposals.find((x) => x.id === proposal_id) ?? fail(404, 'not_found', `No proposal ${proposal_id}.`, 'Call get_mediation for the open proposal ids.')
    if (p.status !== 'open') fail(409, 'invalid_state', `Proposal ${proposal_id} is ${p.status}, not open.`, 'It was superseded. Answer the newest open proposal from get_mediation.', [{ op: 'get_mediation', why: 'Find the open proposal.', args: { job_id } }])
    if (p.by === me) fail(409, 'invalid_state', 'This is your own counter-proposal; it already counts as your acceptance.', 'Wait for the other side to answer it.')
    if (p.responses[me]) fail(409, 'invalid_state', `You already answered this proposal (${p.responses[me]!.answer}).`, 'Each proposal can be answered once. Wait for the next round, or answer another open proposal.')
    if (!['accept', 'reject', 'counter'].includes(ans)) fail(400, 'invalid_input', 'answer must be accept, reject or counter.', 'Pick one of the three.')
    if (ans === 'reject' && !String(reason ?? '').trim()) fail(400, 'invalid_input', 'A rejection needs a reason.', 'Say which term you cannot accept and why. The mediator reads it as data.')
    if (ans === 'counter' && !terms) fail(400, 'invalid_input', 'A counter needs terms.', 'Pass terms with only the fields you change, e.g. { "release_now": "5.00" }.')
    markHuman(db, job.id, me)
    const explanation = answer(db, job, me, p, ans, String(reason ?? '').trim(), terms)
    return { job, your_role: role, next_actions: nextActions(db, job, role), explanation }
  })
}
