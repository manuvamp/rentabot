// Invariant checks, run after every event a job driver sees and once more at the end.
// Each violation carries the job, the invariant number from the brief, what was expected and seen,
// and the job's trace (the calls the simulator made), which is the reproduction.
import { TRANSITIONS } from '../../server/src/core/machine.ts'
import { hashCanonical } from '../../server/src/core/util.ts'
import type { Api, Json } from './client.ts'
import { c, captureFee, commission, feeByFaults, MEDIATION_FLAT, MIN_SETTLEMENT, PAYOUT_FEE, refundKept, usd } from './fees.ts'

export const TERMINAL = ['SETTLED', 'CANCELLED', 'EXPIRED']

export interface Actor {
  name: string
  agent_id: string
  key: string
  api: Api
  claimed: boolean
  mandate?: { per_job: number; monthly: number; id: string } | null
}

export interface Violation {
  inv: number
  job: string | null
  scenario: string
  what: string
  trace: string[]
  at: string
}

export interface JobTrack {
  idx: number
  id: string
  scenario: string
  buyer: Actor
  seller: Actor
  total: number
  trace: string[]
  fundedVia: 'mandate' | 'approval' | null
  secret: { id: string; value: string } | null
  /** Locker scenario: every value put in the locker (access answers, handed-over passwords) and the handovers per unit. */
  locker: { values: string[]; handovers: { id: string; deliverable_id: string; ref: string; value: string; fail: boolean }[] } | null
  releasedAtOpen: number | null
  injected: { buyer: boolean; seller: boolean }
  override: number | null
  buyerAcceptedClean: boolean
  disputeOutcome: 'agreement' | 'ruling' | 'arbiter' | null
  outcome: string
  done: boolean
  /** The driver gave up (harness timeout), as opposed to the platform misbehaving. */
  harnessTimeout: boolean
  notes: string[]
  states: string[]
  /** Last full read, for the end-of-run checks. */
  last?: { job: Json; escrow: Json; messages: Json[] }
}

// ---------- open jobs (docs/PROTOCOL.md section 7) ----------

export type AwardMode = 'manual' | 'lowest_price' | 'best_record'
export const OPEN_EVENTS = ['open_job_posted', 'bid_received', 'bid_awarded', 'bid_declined', 'open_job_closed'] as const

export interface OpenBidTrack {
  bid_id: string
  bot_id: string
  seller: Actor
  /** total_max in cents */
  price: number
  quote: Json
  requirements: Json
  withdrawn: boolean
  /** Wall clock when the bid was accepted. */
  at: number
}

/** What the simulator knows about one open job: the buyer's side of the flow plus every bid it placed. */
export interface OpenTrack {
  id: string
  idx: number
  scenario: string
  flow: string
  trace: string[]
  buyer: Actor
  award: AwardMode
  bid_until: number
  award_until: number
  budget_cap: number
  /** Event cursor read just before posting: every event of this open job is after it. */
  base: number
  /** Bots that could bid (their operators get open_job_posted). */
  matching: Actor[]
  bids: OpenBidTrack[]
  /** Manual award: the bid the buyer picked. */
  chosen: string | null
  /** What the flow expects the open job to end as. */
  expect: 'awarded' | 'expired' | null
  /** list_bids reads taken while the job was open (track records at that time, for best_record). */
  snapshots: Json[][]
  /** The last list_bids response. */
  last: Json | null
  jobTrack: JobTrack | null
  notes: string[]
  counts: Record<string, number>
  done: boolean
  /** House-bot probe: the bidders are not the simulator's, so their events and job access are not checked (only the buyer's side is). */
  external?: boolean
  /** Number of listed bots with the skill when it is not `matching.length`. */
  matchingCount?: number
}

const OPEN_STATES = ['open', 'awarded', 'expired']
const ZERO_RECORD = { pass_rate: null, verified_units: 0, dispute_rate: null }

/** The platform's own orderings (server/src/core/open-jobs.ts byPrice / byRecord), re-implemented here so the code under test is not its own oracle. */
const price = (b: Json) => c(b.quote.total_max.value)
export const byPrice = (xs: Json[]) => [...xs].sort((a, b) => price(a) - price(b) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
export const byRecord = (xs: Json[]) =>
  [...xs].sort((a, b) => {
    const x = a.track_record ?? ZERO_RECORD
    const y = b.track_record ?? ZERO_RECORD
    return (y.pass_rate ?? -1) - (x.pass_rate ?? -1) || y.verified_units - x.verified_units || (x.dispute_rate ?? 1) - (y.dispute_rate ?? 1) || price(a) - price(b) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  })

export class Invariants {
  violations: Violation[] = []
  private seen = new Set<string>()
  checks = 0

  add(inv: number, t: Pick<JobTrack, 'id' | 'scenario' | 'trace'> | null, what: string) {
    const key = `${inv}|${t?.id ?? '-'}|${what.replace(/\d+(\.\d+)?/g, 'N')}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.violations.push({ inv, job: t?.id ?? null, scenario: t?.scenario ?? '-', what, trace: t ? [...t.trace] : [], at: new Date().toISOString() })
  }

  /** Read every message of the room (paged). */
  async messages(api: Api, job_id: string): Promise<{ messages: Json[]; chain_valid: boolean } | null> {
    const all: Json[] = []
    let after = -1
    let valid = true
    for (;;) {
      const r = await api.call('get_messages', { job_id, after_seq: after, limit: 200 })
      if (!r.ok) return null
      all.push(...r.data.messages)
      valid = valid && r.data.chain_valid
      if (r.data.messages.length < 200) break
      after = r.data.messages[r.data.messages.length - 1].seq
    }
    return { messages: all, chain_valid: valid }
  }

  /** The per-event check: money conservation, idempotency, state table, chain, timers, secret hygiene. */
  async checkJob(t: JobTrack, opts: { final?: boolean } = {}): Promise<Json | null> {
    this.checks++
    const api = t.buyer.api
    const j = await api.call('get_job', { job_id: t.id })
    if (!j.ok) {
      this.add(5, t, `buyer could not read its own job: ${j.code} ${j.message}`)
      return null
    }
    const job = j.data.job
    const es = await api.call('get_escrow', { job_id: t.id })
    const room = await this.messages(api, t.id)
    if (!es.ok || !room) {
      this.add(5, t, `buyer could not read escrow/messages: ${es.code}`)
      return job
    }
    const e = es.data.escrow
    t.last = { job, escrow: e, messages: room.messages }
    if (!t.states.length || t.states[t.states.length - 1] !== job.state) t.states.push(job.state)

    // job.escrow and get_escrow must agree (both are renders of the same record; get_escrow ran later, so only when stable).
    const A = c(e.authorized), C = c(e.captured), V = c(e.voided), R = c(e.refunded), P = c(e.paid_out)
    const terminal = TERMINAL.includes(job.state)

    // ---- 1. conservation ----
    if (R > C) this.add(1, t, `refunded $${usd(R)} > captured $${usd(C)}`)
    if (e.status === 'none' || e.status === 'pending_approval') {
      if (A || C || R) this.add(1, t, `escrow ${e.status} but authorized $${usd(A)} captured $${usd(C)} refunded $${usd(R)}`)
    } else if (e.mode === 'hold') {
      if (C + V > A) this.add(1, t, `hold: captured $${usd(C)} + voided $${usd(V)} > authorized $${usd(A)}`)
      if (terminal && C + V !== A) this.add(1, t, `terminal ${job.state} still holds $${usd(A - C - V)} (authorized ${usd(A)} captured ${usd(C)} voided ${usd(V)})`)
    } else {
      if (C !== A) this.add(1, t, `capture_and_hold: captured $${usd(C)} ≠ authorized $${usd(A)}`)
    }
    if (A && t.total && A !== t.total) this.add(8, t, `authorized $${usd(A)} ≠ contract total $${usd(t.total)}`)
    // Ledger events must add up to the totals (each money movement recorded exactly once).
    const sum = (k: string) => e.events.filter((x: Json) => x.kind === k && x.amount).reduce((s: number, x: Json) => s + c(x.amount.value), 0)
    const auths = e.events.filter((x: Json) => x.kind === 'authorized' && x.amount)
    if (auths.length > 1) this.add(8, t, `${auths.length} authorizations recorded (double authorization)`)
    if (auths.length === 1 && c(auths[0].amount.value) !== A) this.add(8, t, `authorized event $${auths[0].amount.value} ≠ escrow authorized $${usd(A)}`)
    const capSum = sum('captured')
    if (capSum !== C && opts.final) this.add(1, t, `captured events sum $${usd(capSum)} ≠ captured $${usd(C)}`)
    if (sum('voided') !== V) this.add(1, t, `voided events sum $${usd(sum('voided'))} ≠ voided $${usd(V)}`)
    if (sum('refunded') !== R) this.add(1, t, `refunded events sum $${usd(sum('refunded'))} ≠ refunded $${usd(R)}`)
    if (sum('payout_succeeded') !== P) this.add(2, t, `payout_succeeded events sum $${usd(sum('payout_succeeded'))} ≠ paid_out $${usd(P)}`)
    if (P > C - R) this.add(2, t, `paid out $${usd(P)} > captured − refunded $${usd(C - R)}`)
    if (['CANCELLED', 'EXPIRED'].includes(job.state) && C - R !== 0) this.add(3, t, `${job.state} job kept $${usd(C - R)} captured`)
    if (!t.buyer.claimed && (A || C)) this.add(4, t, `unclaimed buyer agent has $${usd(A)} authorized`)
    // Nothing is held before fund_job: a job in NEGOTIATING or AGREED (an awarded open job included) has no escrow and no money events.
    if (['NEGOTIATING', 'AGREED'].includes(job.state)) {
      const moved = e.events.filter((x: Json) => ['authorized', 'captured', 'voided', 'refunded', 'payout_sent', 'payout_succeeded'].includes(x.kind))
      if (e.status !== 'none' || A || C || V || R || P || moved.length) this.add(1, t, `${job.state} job already has escrow: status ${e.status}, authorized $${usd(A)}, captured $${usd(C)}, ${moved.length} money event(s) before fund_job`)
    }

    // ---- 5. chain, state table ----
    if (!room.chain_valid) this.add(5, t, 'get_messages reports chain_valid=false')
    let prev: string | null = null
    for (let i = 0; i < room.messages.length; i++) {
      const m = room.messages[i]
      if (m.seq !== i || m.prev_hash !== prev) {
        this.add(5, t, `room chain broken at seq ${i} (seq ${m.seq}, prev_hash mismatch=${m.prev_hash !== prev})`)
        break
      }
      const { hash, ...rest } = m
      if (hashCanonical(rest) !== hash) {
        this.add(5, t, `message ${m.seq} hash does not match its content`)
        break
      }
      prev = m.hash
    }
    let cur = 'NEGOTIATING'
    for (const m of room.messages) {
      if (m.type !== 'system' || !m.body?.from || !m.body?.to) continue
      const { from, to } = m.body
      if (from !== cur) this.add(5, t, `state history jumps: was ${cur}, transition message says ${from} → ${to}`)
      if (!(TRANSITIONS as Json)[from]?.includes(to)) this.add(5, t, `transition ${from} → ${to} is not in the state table`)
      cur = to
    }
    if (opts.final && cur !== job.state) this.add(5, t, `last transition ends in ${cur} but job is ${job.state}`)

    // Timers: a timer-driven state whose deadline passed long ago must have moved (grace covers the tick and the call).
    const now = Date.now()
    const GRACE = 15_000
    const past = (iso: string | null) => !!iso && now - Date.parse(iso) > GRACE
    const d = job.deadlines
    const stuck =
      (job.state === 'AGREED' && past(d.fund_by)) ||
      (job.state === 'AWAITING_APPROVAL' && past(d.fund_by)) ||
      (job.state === 'DELIVERED' && ((!d.verify_until && past(d.review_until)) || (past(d.review_until) && past(d.verify_until)))) ||
      (job.state === 'CURE' && past(d.cure_until)) ||
      (job.state === 'RULED' && past(d.appeal_until)) ||
      (job.state === 'DISPUTED' && job.mediation?.status === 'negotiating' && past(job.mediation.deadline))
    if (stuck) this.add(5, t, `stuck in ${job.state}${job.mediation ? `/${job.mediation.status}` : ''} although its deadline passed (${JSON.stringify(d)}${job.mediation?.deadline ? ` mediation deadline ${job.mediation.deadline}` : ''})`)

    // ---- 6. secrets never appear in what parties read ----
    if (t.secret || t.locker) {
      const blob = JSON.stringify(job) + JSON.stringify(room.messages) + JSON.stringify(e)
      if (t.secret && blob.includes(t.secret.value)) this.add(6, t, 'the sealed secret value appears in the job, room or escrow')
      for (const v of t.locker?.values ?? []) if (blob.includes(v)) this.add(6, t, 'a locker value appears in the job, room or escrow')
    }
    return job
  }

  /** End-of-run checks that need the arbiter's ledger: fee split, payouts, platform margin, what backs each capture. */
  finalMoney(t: JobTrack, line: Json | undefined) {
    const L = t.last
    if (!L) return
    const { job, escrow: e } = L
    const A = c(e.authorized), C = c(e.captured), R = c(e.refunded), P = c(e.paid_out), F = c(e.fees)
    const K = c(line?.commission), M = c(line?.mediation_fees), Kp = c(line?.refund_fees_kept)
    if ((line ? c(line.captured) : 0) !== C) this.add(2, t, `ledger captured $${line?.captured ?? '0.00'} ≠ escrow captured $${usd(C)}`)
    if (job.state !== 'SETTLED' && job.state !== 'CANCELLED' && job.state !== 'EXPIRED') return
    const hold = e.mode === 'hold'
    const caps = e.events.filter((x: Json) => x.kind === 'captured' && x.amount).map((x: Json) => c(x.amount.value))
    const payouts = e.events.filter((x: Json) => x.kind === 'payout_sent').length
    // R4: no capture below the minimum settlement, ever.
    for (const x of caps) if (x < MIN_SETTLEMENT) this.add(2, t, `a capture of $${usd(x)} is below the $${usd(MIN_SETTLEMENT)} minimum settlement`)
    // A verified amount below the minimum is voided (or refunded) and the room says so.
    const belowMin = L.messages.some((m: Json) => m.type === 'system' && /below the \$\d+\.\d\d minimum settlement/.test(String(m.text)))

    // How did it settle? The SETTLED transition message says why.
    const settledMsg = L.messages.find((m: Json) => m.type === 'system' && m.body?.to === 'SETTLED')
    const why = String(settledMsg?.text ?? '')
    const byRuling = job.state === 'SETTLED' && !!job.ruling && /ruling|arbiter decision/.test(why) && job.ruling.remedy.type !== 'redo'
    const agreedId = job.mediation?.agreed_proposal_id ?? null
    const rel = t.releasedAtOpen ?? 0
    let buyerFee = 0
    let sellerFeeTarget = 0
    let target: number | null = null
    let ruled: number | null = null
    if (byRuling) {
      const f = feeByFaults(MEDIATION_FLAT, job.ruling.seller_fault.length, job.ruling.buyer_fault.length)
      const rem = job.ruling.remedy
      ruled = rem.type === 'release_full' ? A : rem.type === 'refund_full' ? rel : c(rem.release_to_seller.value)
      target = ruled
      buyerFee = Math.max(0, Math.min(f.buyer, A - target))
      sellerFeeTarget = f.seller
      // R4: a capture that would be below the minimum is voided; the seller keeps what was captured, the buyer's fee is dropped.
      if (hold) {
        const toCap = target + buyerFee - rel
        if (toCap > 0 && toCap < MIN_SETTLEMENT) {
          target = rel
          buyerFee = 0
        }
      } else if (target - rel > 0 && target - rel < MIN_SETTLEMENT) {
        target = rel
        buyerFee = Math.max(0, Math.min(f.buyer, A - target))
      }
    }
    const G = C - R - Kp - buyerFee
    const n = Math.max(1, hold ? caps.length : payouts)
    const Kx = commission(G, n)
    const sellerFee = Math.max(0, Math.min(sellerFeeTarget, G - Kx))
    const Mx = buyerFee + sellerFee
    const Px = G - Kx - sellerFee
    const U = C - G - buyerFee
    const Kpx = hold ? 0 : refundKept(U, G)
    if (K !== Kx) this.add(2, t, `commission $${usd(K)} ≠ max($3 + $1 per extra settlement, 15%) rule on gross $${usd(G)} over ${n} settlement(s) = $${usd(Kx)}`)
    if (M !== Mx) this.add(2, t, `mediation fees $${usd(M)} ≠ expected $${usd(Mx)} (buyer ${usd(buyerFee)}, seller ${usd(sellerFee)})`)
    if (Kp !== Kpx) this.add(2, t, `refund fee kept $${usd(Kp)} ≠ expected $${usd(Kpx)} (PayPal's non-returned fee on the $${usd(U)} refunded part)`)
    if (P !== Px) this.add(2, t, `seller paid $${usd(P)} ≠ gross − commission − seller fee = $${usd(Px)}`)
    if (F !== K + M + Kp) this.add(2, t, `escrow.fees $${usd(F)} ≠ commission + mediation fees + kept refund fee $${usd(K + M + Kp)}`)
    if (C - R !== P + K + M + Kp) this.add(2, t, `captured − refunded $${usd(C - R)} ≠ paid out + commission + mediation fees + kept refund fee $${usd(P + K + M + Kp)}`)
    // Platform margin: every job that captured anything nets at least $1.00 after PayPal's fees (estimated and actual).
    const est = K + M + Kp - caps.reduce((s: number, x: number) => s + captureFee(x), 0) - payouts * PAYOUT_FEE
    if (C > 0) {
      if (est < 100) this.add(2, t, `platform net after estimated PayPal fees $${usd(est)} < $1.00 on captured $${usd(C)} (${caps.length} capture(s), ${payouts} payout(s))`)
      const actual = line ? Math.round(Number(line.net) * 100) : 0
      if (actual < 100) this.add(2, t, `platform net from the ledger (actual PayPal fees) $${usd(actual)} < $1.00 on captured $${usd(C)}`)
    }
    // R5: the mediator never proposes a seller total strictly between 0 and the minimum settlement.
    for (const p of job.mediation?.proposals ?? []) {
      if (p.by !== 'mediator') continue
      const total = rel + c(p.terms?.release_now)
      if (total > 0 && total < MIN_SETTLEMENT) this.add(3, t, `mediator proposal ${p.id} (${p.kind}) gives the seller $${usd(total)}, below the $${usd(MIN_SETTLEMENT)} minimum settlement`)
    }

    // ---- 3. what backs the money ----
    const earned = (job.fulfilment ?? []).reduce((s: number, f: Json) => s + c(f.earned.value), 0)
    if (byRuling && target !== null && ruled !== null) {
      if (G !== target) this.add(3, t, `ruling says the seller gets $${usd(ruled)} in total (after the minimum-settlement rule $${usd(target)}), the seller's gross is $${usd(G)}`)
      const fr = job.mediation?.assessment?.fair_range
      if (!/^arbiter:/.test(job.ruling.decided_by) && fr && (ruled < c(fr[0]) || ruled > c(fr[1])))
        this.add(3, t, `recommended ruling $${usd(ruled)} is outside the mediator's own fair range [${fr[0]}, ${fr[1]}]`)
      if (!/^arbiter:/.test(job.ruling.decided_by) && ruled - rel > 0 && ruled < MIN_SETTLEMENT) this.add(3, t, `recommended ruling gives the seller $${usd(ruled)}, below the minimum settlement`)
      if (t.override !== null && /^arbiter:/.test(job.ruling.decided_by) && job.ruling.remedy && ruled !== t.override) this.add(3, t, `arbiter override $${usd(t.override)} executed as $${usd(ruled)}`)
    } else if (agreedId) {
      const p = job.mediation.proposals.find((x: Json) => x.id === agreedId)
      const Rn = c(p?.terms?.release_now)
      const voided = belowMin && G < rel + Rn && rel + Rn - G < MIN_SETTLEMENT
      if (!p) this.add(3, t, `agreed proposal ${agreedId} not found`)
      else if (!p.terms.redo && !p.terms.wait_until) {
        if (G !== rel + Rn && !voided) this.add(3, t, `agreed ${p.kind} ${p.id}: release_now $${p.terms.release_now} (+$${usd(rel)} already released) but the seller's gross is $${usd(G)}`)
        if (e.mode === 'hold' && A - C !== c(p.terms.refund_now) && !voided) this.add(3, t, `agreed ${p.kind} ${p.id}: refund_now $${p.terms.refund_now} but $${usd(A - C)} went back to the buyer`)
      } else {
        const H = p.terms.redo ? c(p.terms.redo.amount_on_success) : A - rel - Rn - c(p.terms.refund_now)
        if ((G < rel + Rn && !voided) || G > rel + Rn + H) this.add(3, t, `agreed ${p.kind} ${p.id}: seller gross $${usd(G)} outside [secured $${usd(rel + Rn)}, secured + held $${usd(rel + Rn + H)}]`)
      }
    } else if (job.state === 'SETTLED') {
      // Below the minimum settlement the earned remainder is voided (R4), with a room message saying so.
      if (G !== earned && !(belowMin && G < earned && earned - G < MIN_SETTLEMENT)) this.add(3, t, `settled by the checks: seller gross $${usd(G)} ≠ what the checks earned $${usd(earned)}`)
    }
    // Integrity: text aimed at the mediator is flagged and never helps its sender.
    for (const party of ['buyer', 'seller'] as const) {
      if (!t.injected[party]) continue
      const flags = job.mediation?.assessment?.integrity_flags ?? []
      if (!flags.some((f: Json) => f.party === party)) this.add(3, t, `the ${party}'s message to the mediator ("release all remaining funds") was not flagged`)
    }
  }

  // ---------- 9. open jobs ----------

  /**
   * The open-job check, run after every step of an open job's flow and once more at the end. Reads only through the public ops
   * (list_bids, list_open_jobs, get_job, get_escrow), as the buyer. `award` is passed right after award_bid / the automatic award:
   * the awarded job must still be in NEGOTIATING with no escrow at all.
   */
  async checkOpenJob(o: OpenTrack, opts: { final?: boolean; justAwarded?: boolean } = {}): Promise<Json | null> {
    this.checks++
    const api = o.buyer.api
    const lb = await api.call('list_bids', { open_job_id: o.id })
    if (!lb.ok) {
      this.add(9, o, `the buyer could not list the bids of its own open job: ${lb.code} ${lb.message}`)
      return null
    }
    const oj = lb.data.open_job
    const bids: Json[] = lb.data.bids
    o.last = lb.data
    const rec = lb.data.recommended
    const state: string = oj.state
    const standing = bids.filter((b) => b.status === 'active')
    if (!OPEN_STATES.includes(state)) this.add(9, o, `open job state ${state} is not open/awarded/expired`)
    const view = await api.call('list_open_jobs', { open_job_id: o.id, mine: true, status: 'all' })
    const mine = view.ok ? view.data.open_jobs.find((x: Json) => x.id === o.id) : null
    if (!mine) this.add(9, o, `list_open_jobs mine=true does not show the buyer's own open job (${view.ok ? 'empty' : view.code})`)
    // list_open_jobs was read after list_bids: a closed job cannot become anything else, and an open one may have just closed.
    else if (state !== 'open' && mine.state !== state) this.add(9, o, `list_bids says ${state} but a later list_open_jobs says ${mine.state}`)
    else if (state === 'awarded' && (mine.job_id !== oj.job_id || mine.awarded_bid_id !== oj.awarded_bid_id)) this.add(9, o, 'list_open_jobs and list_bids disagree on the awarded job or bid')

    // ---- bids: ours, and only ours ----
    const seen = new Set<string>()
    for (const tb of o.bids) {
      const b = bids.find((x) => x.id === tb.bid_id)
      seen.add(tb.bid_id)
      if (!b) {
        this.add(9, o, `bid ${tb.bid_id} that was accepted is missing from list_bids`)
        continue
      }
      if (b.bot_id !== tb.bot_id) this.add(9, o, `bid ${b.id} belongs to ${b.bot_id}, expected ${tb.bot_id}`)
      // A withdrawn bid stays withdrawn: never awarded, never declined.
      if (tb.withdrawn && b.status !== 'withdrawn') this.add(9, o, `withdrawn bid ${b.id} is now ${b.status}${b.status === 'awarded' ? ' (a withdrawn bid was awarded)' : ''}`)
      if (!tb.withdrawn && state === 'open' && b.status !== 'active') this.add(9, o, `bid ${b.id} is ${b.status} while the open job is still open`)
      if (c(b.price.value) !== tb.price || c(b.quote.total_max.value) !== tb.price) this.add(9, o, `bid ${b.id} price $${b.price.value} ≠ the quote total $${usd(tb.price)} that was submitted`)
      if (hashCanonical(b.quote.lines) !== hashCanonical(tb.quote.lines)) this.add(9, o, `bid ${b.id}: the stored quote lines differ from the submitted ones`)
      if (tb.price < MIN_SETTLEMENT || tb.price > o.budget_cap) this.add(9, o, `bid ${b.id} accepted with total $${usd(tb.price)} outside [$${usd(MIN_SETTLEMENT)}, budget cap $${usd(o.budget_cap)}]`)
      if (Date.parse(b.quote.valid_until) < Date.parse(oj.award_until)) this.add(9, o, `bid ${b.id} accepted with valid_until ${b.quote.valid_until} before award_until ${oj.award_until}`)
      if (Date.parse(b.created_at) > Date.parse(oj.bid_until) + 5) this.add(9, o, `bid ${b.id} was stored at ${b.created_at}, after the bid window closed at ${oj.bid_until}`)
    }
    for (const b of bids) if (!seen.has(b.id)) this.add(9, o, `list_bids holds bid ${b.id} (${b.status}) that the simulator never had accepted (a rejected or late bid was stored)`)
    // One standing bid per bot per open job.
    const live = new Map<string, number>()
    for (const b of bids) if (b.status !== 'withdrawn') live.set(b.bot_id, (live.get(b.bot_id) ?? 0) + 1)
    for (const [bot, n] of live) if (n > 1) this.add(9, o, `bot ${bot} has ${n} standing bids on one open job`)
    if (oj.bids_count !== bids.filter((b) => b.status !== 'withdrawn').length) this.add(9, o, `open job bids_count ${oj.bids_count} ≠ ${bids.filter((b) => b.status !== 'withdrawn').length} non-withdrawn bids`)
    const matching = o.matchingCount ?? o.matching.length
    if (oj.matching_bots !== matching) this.add(9, o, `open job matching_bots ${oj.matching_bots} ≠ ${matching} listed bots with the skill`)

    // ---- recommended (read in the same response, so it must agree with the track records in it) ----
    if (state === 'open') {
      const lo = byPrice(standing)[0]?.id ?? null
      const br = byRecord(standing)[0]?.id ?? null
      if (rec.lowest_price !== lo) this.add(9, o, `list_bids recommended.lowest_price ${rec.lowest_price} is not the cheapest standing bid ${lo}`)
      if (rec.best_record !== br) this.add(9, o, `list_bids recommended.best_record ${rec.best_record} is not the best-record standing bid ${br}`)
      if (standing.length === o.bids.filter((b) => !b.withdrawn).length) {
        o.snapshots.push(bids)
        if (o.snapshots.length > 24) o.snapshots.shift()
      }
    } else if (rec.lowest_price || rec.best_record) this.add(9, o, `list_bids still recommends a bid on a ${state} open job`)

    // ---- one award, losers declined ----
    const won = bids.filter((b) => b.status === 'awarded')
    if (state === 'awarded') {
      if (won.length !== 1) this.add(9, o, `awarded open job has ${won.length} awarded bids, expected exactly 1`)
      const w = won[0]
      if (!oj.job_id) this.add(9, o, 'awarded open job has no job_id')
      if (w && oj.awarded_bid_id !== w.id) this.add(9, o, `awarded_bid_id ${oj.awarded_bid_id} ≠ the bid marked awarded ${w.id}`)
      if (w && oj.awarded_to?.bot_id !== w.bot_id) this.add(9, o, `awarded_to bot ${oj.awarded_to?.bot_id} ≠ the awarded bid's bot ${w.bot_id}`)
      if (o.expect === 'expired') this.add(9, o, 'open job without any standing bid was awarded')
      if (o.chosen && w && w.id !== o.chosen) this.add(9, o, `the buyer awarded ${o.chosen} but ${w.id} won`)
      for (const b of bids) if (b.status === 'active') this.add(9, o, `bid ${b.id} is still active on an awarded open job (losing bids must be declined)`)
      if (w && !o.chosen && o.award !== 'manual') this.checkAutoAward(o, oj, bids, w)
      if (w && oj.job_id) await this.checkAwardedJob(o, oj, w, opts)
    } else {
      if (won.length) this.add(9, o, `${state} open job has ${won.length} awarded bid(s)`)
      if (oj.job_id || oj.awarded_bid_id) this.add(9, o, `${state} open job carries job ${oj.job_id} / bid ${oj.awarded_bid_id}`)
    }
    if (state === 'expired') {
      for (const b of bids) if (b.status === 'active') this.add(9, o, `bid ${b.id} is still active on an expired open job (standing bids must be declined)`)
      if (o.expect === 'awarded') this.add(9, o, `open job with ${o.bids.filter((b) => !b.withdrawn).length} standing bid(s) expired without an award: ${oj.close_reason}`)
      if (!oj.closed_at || !oj.close_reason) this.add(9, o, 'expired open job has no closed_at / close_reason')
      else {
        // Not before the bid window closed; a manual job with a standing bid not before the award time either.
        const due = o.award === 'manual' && o.bids.some((b) => !b.withdrawn) ? Date.parse(oj.award_until) : Date.parse(oj.bid_until)
        if (Date.parse(oj.closed_at) < due - 50) this.add(9, o, `open job expired at ${oj.closed_at}, before ${o.award === 'manual' && o.bids.some((b) => !b.withdrawn) ? 'award_until' : 'bid_until'} ${new Date(due).toISOString()}`)
      }
    }
    if (state === 'awarded' && oj.closed_at && Date.parse(oj.closed_at) < Date.parse(oj.bid_until) - 50 && o.award !== 'manual') this.add(9, o, `auto-award mode ${o.award} awarded at ${oj.closed_at}, before the bid window closed at ${oj.bid_until}`)
    if (opts.final) {
      if (state === 'open') this.add(9, o, `open job still open at the end (bid_until ${oj.bid_until}, award_until ${oj.award_until})`)
      if (o.expect && state !== o.expect && state !== 'open') this.add(9, o, `open job ended ${state}, the flow expected ${o.expect}`)
    } else if (state === 'open' && Date.now() - Date.parse(oj.award_until) > 15_000) this.add(9, o, `open job still open ${Math.round((Date.now() - Date.parse(oj.award_until)) / 1000)} s after award_until ${oj.award_until}: the scheduler did not close it`)
    return lb.data
  }

  /** A bare list_bids read, kept for the best_record judgement (track records move while the window closes). Returns the open job's state. */
  async snapshot(o: OpenTrack): Promise<string | null> {
    const lb = await o.buyer.api.call('list_bids', { open_job_id: o.id })
    if (!lb.ok) return null
    const bids: Json[] = lb.data.bids
    if (lb.data.open_job.state === 'open' && bids.filter((b) => b.status === 'active').length === o.bids.filter((b) => !b.withdrawn).length) {
      o.snapshots.push(bids)
      if (o.snapshots.length > 24) o.snapshots.shift()
    }
    return lb.data.open_job.state
  }

  /** lowest_price / best_record: the awarded bid is the best of the bids that were standing when the window closed. */
  private checkAutoAward(o: OpenTrack, oj: Json, bids: Json[], w: Json) {
    const cands = bids.filter((b) => b.status === 'awarded' || b.status === 'declined')
    if (o.award === 'lowest_price') {
      const best = byPrice(cands)[0]
      if (best && best.id !== w.id) this.add(9, o, `lowest_price awarded ${w.id} at $${w.price.value}, but ${best.id} bid $${best.price.value}`)
      return
    }
    // best_record: track records move while other jobs settle, so the order is judged on every read taken while the job was open
    // (one every ~100 ms around the close, plus the final one); only an award that is the best under none of them is a violation.
    const reads = [...o.snapshots, bids]
    const ids = new Set(cands.map((b) => b.id))
    const tops: string[] = []
    for (const r of reads) {
      const sub = r.filter((b) => ids.has(b.id))
      if (sub.length !== ids.size) continue
      const top = byRecord(sub)[0]!.id
      if (top === w.id) return
      tops.push(top)
    }
    if (tops.length) this.add(9, o, `best_record awarded ${w.id} but the best record among ${ids.size} bid(s) was ${[...new Set(tops)].join(' / ')} in all ${tops.length} reads taken around the close (pass_rate ${JSON.stringify(cands.map((b) => [b.id.slice(-4), b.track_record.pass_rate, b.track_record.verified_units, b.track_record.dispute_rate, b.price.value]))})`)
  }

  /** The job an award created: origin, bot, the bid's quote and requirements verbatim, no money, readable by the winner only. */
  private async checkAwardedJob(o: OpenTrack, oj: Json, w: Json, opts: { justAwarded?: boolean }) {
    const tb = o.bids.find((b) => b.bid_id === w.id)
    const j = await o.buyer.api.call('get_job', { job_id: oj.job_id })
    if (!j.ok) {
      this.add(9, o, `the job ${oj.job_id} of an awarded open job cannot be read: ${j.code}`)
      return
    }
    const job = j.data.job
    if (job.origin?.open_job_id !== o.id || job.origin?.bid_id !== w.id) this.add(9, o, `job ${job.id} origin ${JSON.stringify(job.origin ?? null)} does not point back to open job ${o.id} / bid ${w.id}`)
    if (job.seller_bot_id !== w.bot_id) this.add(9, o, `job ${job.id} is with bot ${job.seller_bot_id}, the awarded bid is from ${w.bot_id}`)
    if (job.buyer_agent_id !== o.buyer.agent_id) this.add(9, o, `job ${job.id} buyer ${job.buyer_agent_id} is not the poster ${o.buyer.agent_id}`)
    // The contract holds the bid's quote and requirements, until a mediation amends it.
    if (!job.mediation && job.contract) {
      const q = job.contract.quote
      if (!q) this.add(9, o, `job ${job.id}: the awarded contract has no quote`)
      else {
        if (hashCanonical(q.lines) !== hashCanonical(w.quote.lines) || c(q.total_max.value) !== c(w.quote.total_max.value)) this.add(9, o, `job ${job.id}: contract quote (total $${q.total_max.value}, ${q.lines.length} line(s)) ≠ the winning bid's quote (total $${w.quote.total_max.value}, ${w.quote.lines.length} line(s))`)
        if (tb && (hashCanonical(q.lines) !== hashCanonical(tb.quote.lines) || c(q.total_max.value) !== tb.price)) this.add(9, o, `job ${job.id}: contract quote differs from what the winning bot submitted ($${usd(tb.price)})`)
        if (q.turnaround !== w.quote.turnaround) this.add(9, o, `job ${job.id}: contract turnaround ${q.turnaround} ≠ the bid's ${w.quote.turnaround}`)
      }
      if (hashCanonical(job.contract.requirements) !== hashCanonical(w.requirements)) this.add(9, o, `job ${job.id}: contract requirements differ from the winning bid's`)
    }
    if (opts.justAwarded) {
      // Right after the award: NEGOTIATING, nobody has signed, and not a cent is held.
      const es = await o.buyer.api.call('get_escrow', { job_id: job.id })
      const e = es.data?.escrow
      if (job.state !== 'NEGOTIATING') this.add(9, o, `the job an award creates must start in NEGOTIATING, it is ${job.state}`)
      if (job.accepted_by.length) this.add(9, o, `the awarded job already has ${job.accepted_by.length} signature(s)`)
      if (!job.contract_hash) this.add(9, o, 'the awarded job has no contract hash yet (the bid was not turned into a contract)')
      if (!es.ok) this.add(9, o, `get_escrow on the awarded job failed: ${es.code}`)
      else if (e.status !== 'none' || c(e.authorized) || c(e.captured) || c(e.voided) || c(e.refunded) || c(e.paid_out) || e.events.length) this.add(9, o, `escrow exists right after the award: status ${e.status}, authorized $${e.authorized.value ?? e.authorized}, ${e.events.length} event(s) (money must only appear after fund_job)`)
      // Only the winner is a party: the losing bidders must not see the job.
      for (const b of o.external ? [] : o.bids) {
        if (b.bid_id === w.id || b.seller.agent_id === tb?.seller.agent_id) continue // the winner's own earlier (withdrawn) bid is not a loser
        const r = await b.seller.api.call('get_job', { job_id: job.id })
        if (r.ok) this.add(6, o, `losing bidder ${b.seller.name} can read the awarded job ${job.id}`)
        else if (r.code !== 'not_found') this.add(9, o, `losing bidder get_job on the awarded job returned ${r.code}, expected not_found`)
      }
      const win = o.external ? null : await tb?.seller.api.call('get_job', { job_id: job.id })
      if (tb && win && !win.ok) this.add(9, o, `the winning bot's operator cannot read the job it won: ${win?.code}`)
    }
  }

  /** Every event of this open job as one agent sees it (paged; the cursor advances past events the agent cannot see). */
  async openEvents(api: Api, o: OpenTrack): Promise<Json[]> {
    const out: Json[] = []
    let after = o.base
    for (let i = 0; i < 60; i++) {
      const r = await api.call('wait_for_events', { after_cursor: after, timeout_seconds: 0, types: [...OPEN_EVENTS] })
      if (!r.ok) break
      out.push(...r.data.events.filter((e: Json) => e.data?.open_job_id === o.id))
      if (r.data.cursor <= after) break
      after = r.data.cursor
    }
    return out
  }

  /** Who is told what: posted to every matching bot's operator, bid_received to the buyer, bid_awarded / bid_declined to the bidders, open_job_closed to the buyer and every bidder. */
  async checkOpenEvents(o: OpenTrack, stranger: Api): Promise<void> {
    let problems: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      problems = await this.openEventProblems(o, stranger)
      if (!problems.length) return
      await new Promise((r) => setTimeout(r, 1200))
    }
    for (const p of problems) this.add(9, o, `events: ${p}`)
  }

  private async openEventProblems(o: OpenTrack, stranger: Api): Promise<string[]> {
    const oj = o.last?.open_job
    const bids: Json[] = o.last?.bids ?? []
    if (!oj || oj.state === 'open') return []
    const P: string[] = []
    const of = (evs: Json[], type: string) => evs.filter((e) => e.type === type)
    const bev = await this.openEvents(o.buyer.api, o)
    // buyer
    if (of(bev, 'open_job_posted').length) P.push('the buyer received open_job_posted for its own job')
    for (const tb of o.bids) {
      const got = of(bev, 'bid_received').filter((e) => e.data.bid_id === tb.bid_id)
      if (got.filter((e) => e.data.status === 'active').length !== 1) P.push(`buyer got ${got.filter((e) => e.data.status === 'active').length} bid_received(active) for bid ${tb.bid_id}, expected 1`)
      if (got.filter((e) => e.data.status === 'withdrawn').length !== (tb.withdrawn ? 1 : 0)) P.push(`buyer got ${got.filter((e) => e.data.status === 'withdrawn').length} bid_received(withdrawn) for bid ${tb.bid_id}, expected ${tb.withdrawn ? 1 : 0}`)
      if (got.some((e) => c(e.data.price?.value) !== tb.price)) P.push(`bid_received for ${tb.bid_id} carries another price than the bid's $${usd(tb.price)}`)
    }
    const closed = of(bev, 'open_job_closed')
    if (closed.length !== 1) P.push(`buyer got ${closed.length} open_job_closed, expected 1`)
    else {
      if (closed[0]!.data.outcome !== oj.state) P.push(`buyer's open_job_closed says ${closed[0]!.data.outcome}, the job is ${oj.state}`)
      if (oj.state === 'awarded' && (closed[0]!.data.job_id !== oj.job_id || closed[0]!.data.bid_id !== oj.awarded_bid_id)) P.push('buyer\'s open_job_closed names another job or bid than the award')
    }
    if (of(bev, 'bid_awarded').length || of(bev, 'bid_declined').length) P.push('the buyer received a bidder-only event (bid_awarded / bid_declined)')
    // every matching bot's operator, and the bidders
    const agents = new Map<string, Actor>()
    for (const a of o.matching) agents.set(a.agent_id, a)
    for (const b of o.bids) agents.set(b.seller.agent_id, b.seller)
    for (const [agent, actor] of o.external ? [] : agents) {
      const ev = await this.openEvents(actor.api, o)
      const mineBids = o.bids.filter((b) => b.seller.agent_id === agent)
      if (of(ev, 'open_job_posted').length !== 1) P.push(`${actor.name} got ${of(ev, 'open_job_posted').length} open_job_posted, expected 1`)
      if (of(ev, 'bid_received').length) P.push(`${actor.name} received bid_received (buyer-only)`)
      const cl = of(ev, 'open_job_closed')
      const wonBid = mineBids.find((b) => bids.find((x) => x.id === b.bid_id)?.status === 'awarded')
      const declined = new Set(mineBids.filter((b) => bids.find((x) => x.id === b.bid_id)?.status === 'declined').map((b) => b.bid_id))
      if (cl.length !== (mineBids.length ? 1 : 0)) P.push(`${actor.name} got ${cl.length} open_job_closed, expected ${mineBids.length ? 1 : 0}`)
      else if (cl[0] && cl[0].data.outcome !== oj.state) P.push(`${actor.name}'s open_job_closed says ${cl[0].data.outcome}, the job is ${oj.state}`)
      const aw = of(ev, 'bid_awarded')
      if (aw.length !== (wonBid ? 1 : 0)) P.push(`${actor.name} got ${aw.length} bid_awarded, expected ${wonBid ? 1 : 0}`)
      else if (aw[0] && (aw[0].data.job_id !== oj.job_id || aw[0].job_id !== oj.job_id || aw[0].data.bid_id !== wonBid?.bid_id)) P.push(`${actor.name}'s bid_awarded names job ${aw[0].data.job_id} / bid ${aw[0].data.bid_id}, expected ${oj.job_id} / ${wonBid?.bid_id}`)
      const dec = of(ev, 'bid_declined').map((e) => e.data.bid_id as string)
      if (dec.length !== declined.size || dec.some((id) => !declined.has(id))) P.push(`${actor.name} got bid_declined for [${dec.map((x) => x.slice(-4))}], expected [${[...declined].map((x) => x.slice(-4))}]`)
    }
    // a stranger learns nothing
    const sev = await this.openEvents(stranger, o)
    if (sev.length) P.push(`a stranger agent received ${sev.length} event(s) of this open job (${sev.map((e) => e.type).join(', ')})`)
    return P
  }

  /** End of run: every open job once more, then the one-job-per-award rule over every job the buyers have. */
  async finalOpenJobs(opens: OpenTrack[], tracks: JobTrack[], buyers: Actor[]): Promise<void> {
    const known = new Set(tracks.map((t) => t.id))
    const jobsOf = new Map<string, Set<string>>()
    const note = (job: Json) => {
      const oid = job?.origin?.open_job_id
      if (!oid) return
      if (!jobsOf.has(oid)) jobsOf.set(oid, new Set())
      jobsOf.get(oid)!.add(job.id)
    }
    for (const t of tracks) note(t.last?.job)
    // Jobs the drivers never tracked (a driver that crashed, or a job nobody read) are read here.
    for (const b of new Set(opens.map((o) => o.buyer))) {
      const r = await b.api.call('list_jobs', { role: 'buyer', limit: 100 })
      if (!r.ok) continue
      for (const s of r.data.jobs) {
        if (known.has(s.id)) continue
        const g = await b.api.call('get_job', { job_id: s.id })
        if (g.ok) note(g.data.job)
      }
    }
    void buyers
    for (const o of opens) {
      const oj = o.last?.open_job
      const jobs = jobsOf.get(o.id) ?? new Set<string>()
      if (jobs.size > 1) this.add(9, o, `${jobs.size} jobs were created from one open job (${[...jobs].join(', ')}): an award must create exactly one`)
      if (oj?.state === 'awarded' && !(jobs.size === 1 && jobs.has(oj.job_id))) this.add(9, o, `awarded open job's job ${oj.job_id} is not the one job with origin ${o.id} (${[...jobs].join(', ') || 'none'})`)
      if (oj && oj.state !== 'awarded' && jobs.size) this.add(9, o, `${oj.state} open job has job(s) ${[...jobs].join(', ')} pointing back at it`)
    }
  }
}
