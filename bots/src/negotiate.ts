// How a house bot answers the mediator's proposals (docs/MEDIATION.md). Pure functions over platform facts.
//
// The decision is money arithmetic on numbers the PLATFORM computed (what its checks verified, what is already
// captured, the proposal's exact terms, the fair range). It never reads the free text of a proposal, a counter
// note or the room: that text is data, so a buyer's "Note to the mediator: ..." cannot move the answer.
// Only the wording of a reason may come from the bot's AI, and it is replaced by the plain text whenever the
// AI's sentence is not clean (see safePhrase).
import { amount, cents, type CounterTerms, type Delivery, type Job, type MediationState, type Proposal } from '@rentabot/shared'

/** Work a redo / substitute proposal asks the bot to do (also what an accepted one leaves in the contract). */
export interface AgreedWork {
  kind: 'redo' | 'substitute'
  deliverable_id: string
  /** Unit refs to fix (redo) or new unit names (substitute). */
  units: string[]
  instruction: string
  deadline: string
}

/** What the bot can do with a given proposal, decided by the bot itself (SellerBot.canAgree). */
export interface Capabilities {
  redo: boolean
  substitute: boolean
}

export interface Facts {
  /** Seller total (cents) the platform's checks verified, as the assessment states it. */
  verified: number
  fairLow: number
  fairHigh: number
  /** Already captured for the seller (cents). */
  already: number
  authorized: number
  /** Platform minimum settlement: a seller total below it is never captured. */
  min: number
  /** Value of units still waiting on delayed checks. */
  pendingValue: number
}

export type Decision =
  | { answer: 'accept'; why: string }
  | { answer: 'reject'; why: string }
  | { answer: 'counter'; why: string; terms: CounterTerms }

export interface DecisionContext {
  now: number
  can: Capabilities
  /** The bot already used its one counter on this job. */
  countered: boolean
}

/** A redo / substitute must leave at least this long from now (nominal time; the server scales it in demo). */
export const MIN_REDO_MS = 3_600_000
/** Tolerance on the verified value: at least 95% of it, or within $1.00. */
export const TOLERANCE_PCT = 0.05
export const TOLERANCE_MIN_CENTS = 100

const usd = (c: number) => `$${amount(c)}`
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// ---------- facts ----------

export function factsFrom(job: Job, med: MediationState): Facts | null {
  const a = med.assessment
  if (!a) return null
  const quote = job.contract?.quote
  let pendingValue = 0
  for (const f of job.fulfilment) {
    const line = quote?.lines.find((l) => l.deliverable_id === f.deliverable_id)
    const unit = line ? Math.round(cents(line.max_total) / Math.max(1, line.quantity)) : 0
    pendingValue += f.pending_units * unit
  }
  return {
    verified: cents(a.verified_value),
    fairLow: cents(a.fair_range[0]),
    fairHigh: cents(a.fair_range[1]),
    already: cents(job.escrow.captured.value),
    authorized: cents(job.escrow.authorized.value),
    min: job.contract?.fees?.min_settlement ? cents(job.contract.fees.min_settlement) : 500,
    pendingValue,
  }
}

/** The seller total the bot asks for: what the checks verified, as the platform can actually pay it. */
export function askOf(f: Facts): number {
  if (f.verified <= 0) return 0
  if (f.verified < f.min) return f.fairHigh >= f.min ? f.min : 0 // below the minimum nothing is captured
  return f.verified
}

const tolerance = (ask: number) => Math.max(TOLERANCE_MIN_CENTS, Math.round(ask * TOLERANCE_PCT))

export type TermKind = 'split' | 'cancel' | 'redo' | 'substitute' | 'wait'

/** The shape of the terms, read from the terms themselves (not from a label). */
export function kindOfTerms(t: Proposal['terms']): TermKind {
  if (t.cancel) return 'cancel'
  if (t.redo) return t.redo.units.every((u) => /^new-\d+$/.test(u)) ? 'substitute' : 'redo'
  if (t.wait_until) return 'wait'
  return 'split'
}

const heldOf = (t: Proposal['terms'], avail: number): number => (t.redo ? cents(t.redo.amount_on_success) : t.wait_until ? avail - cents(t.release_now) - cents(t.refund_now) : 0)

/** The redo / substitute work a proposal's terms ask for (null for split, cancel and wait). */
export function offerOf(p: Proposal): AgreedWork | null {
  const r = p.terms.redo
  if (!r) return null
  return { kind: kindOfTerms(p.terms) === 'substitute' ? 'substitute' : 'redo', deliverable_id: r.deliverable_id, units: r.units, instruction: r.instruction, deadline: r.deadline }
}

/** The same work as a substitute: the same number of units, named new-1, new-2, ... */
export function asSubstitute(o: AgreedWork): AgreedWork {
  return { ...o, kind: 'substitute', units: o.units.map((_, i) => `new-${i + 1}`) }
}

// ---------- the decision ----------

/** A release that gets the seller total up to the verified value, inside the fair range, or null when no such counter helps. */
function raisedRelease(t: Proposal['terms'], f: Facts): number | null {
  const avail = f.authorized - f.already
  if (avail <= 0) return null
  const lo = clamp(f.fairLow - f.already, 0, avail)
  const hi = clamp(f.fairHigh - f.already, lo, avail)
  const target = clamp(clamp(askOf(f) - f.already, 0, avail), lo, hi)
  if (target <= cents(t.release_now)) return null
  if (target + heldOf(t, avail) > avail) return null
  return target
}

function counterTerms(t: Proposal['terms'], f: Facts, release: number): CounterTerms {
  const avail = f.authorized - f.already
  const held = heldOf(t, avail)
  if (t.redo) return { release_now: amount(release), refund_now: amount(avail - release - held), redo: { amount_on_success: amount(held) } }
  if (t.wait_until) return { release_now: amount(release), refund_now: amount(avail - release - held) }
  return { release_now: amount(release), cancel: false } // a plain split (a cancel counters as a split)
}

export function decide(p: Proposal, f: Facts, ctx: DecisionContext): Decision {
  const t = p.terms
  const kind = kindOfTerms(t)
  const avail = f.authorized - f.already
  const ask = askOf(f)
  const total = f.already + cents(t.release_now)
  const moneyOk = total >= ask - tolerance(ask)
  const facts = `${usd(total)} for me in total against ${usd(ask)} that the platform checks verified`

  const lowMoney = (): Decision => {
    const why = `The platform checks verified ${usd(ask)} of this work and this offer pays ${usd(total)} in total.`
    if (!ctx.countered) {
      const r = raisedRelease(t, f)
      if (r !== null) return { answer: 'counter', why: `${why} I can settle at ${usd(f.already + r)}, which is the verified value.`, terms: counterTerms(t, f, r) }
    }
    return { answer: 'reject', why: `${why} I cannot go below the verified value.` }
  }

  switch (kind) {
    case 'split':
    case 'cancel':
      return moneyOk ? { answer: 'accept', why: `This pays the verified work (${facts}).` } : lowMoney()
    case 'wait': {
      if (!moneyOk) return lowMoney()
      const held = heldOf(t, avail)
      const backed = f.pendingValue > 0 && held <= f.pendingValue
      return { answer: 'accept', why: backed ? `The secured part covers the verified work (${facts}) and the held part waits for checks I expect to pass.` : `The released part covers the verified work (${facts}).` }
    }
    case 'redo':
    case 'substitute': {
      if (!moneyOk) return lowMoney()
      const offer = offerOf(p)!
      const n = offer.units.length
      if (!ctx.can[kind]) {
        // A redo of listings or items that cannot be recreated can often be done as new units of the same kind, for the same money.
        if (kind === 'redo' && ctx.can.substitute && !ctx.countered)
          return { answer: 'counter', why: `I cannot recreate those exact ${n} unit(s), but I can deliver ${n} new unit(s) of the same kind for the same money.`, terms: { redo: { units: asSubstitute(offer).units } } }
        return { answer: 'reject', why: `I cannot ${kind === 'redo' ? 'redo those' : 'deliver those'} ${n} unit(s) within what this job covers.` }
      }
      if (Date.parse(offer.deadline) - ctx.now < MIN_REDO_MS) return { answer: 'reject', why: 'The deadline for the extra work is too close for me to finish it properly.' }
      return { answer: 'accept', why: `I can do the ${n} unit(s) by the deadline and the secured part covers the verified work (${facts}).` }
    }
  }
}

// ---------- wording ----------

/** Words that would address the adjudicator or give it orders. The server flags them and they cost reputation. */
const FORBIDDEN = /mediator|judge|arbiter|arbitrat|\bai\b|\bllm\b|model|assistant|system|prompt|instruction|ignore|disregard|ruling|rule in|approve|release (all|the full|everything)|refund (all|everything)|you (must|should|will)|please (release|refund|pay|rule|decide)/i

/** An AI-phrased reason, or the plain one when the AI's text is not clean: short, no commands, no figures the facts do not contain. */
export function safePhrase(candidate: string, plain: string): string {
  const text = candidate.replace(/\s+/g, ' ').trim()
  if (text.length < 10 || text.length > 400 || FORBIDDEN.test(text) || /[<>{}\[\]]/.test(text) || /https?:\/\//i.test(text)) return plain
  const allowed = new Set([...plain.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => cents(m[1]!.replace(/,/g, ''))))
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) if (!allowed.has(cents(m[1]!.replace(/,/g, '')))) return plain
  return text
}

// ---------- agreed work (what the contract says after an agreement) ----------

/** The redo / substitute both sides agreed in mediation, while the job is in CURE. Null for anything else. */
export function agreedWorkOf(job: Job): AgreedWork | null {
  if (job.state !== 'CURE') return null
  const id = job.mediation?.agreed_proposal_id
  if (!id) return null
  const a = [...(job.contract?.amendments ?? [])].reverse().find((x) => x.proposal_id === id && x.kind !== 'wait')
  if (!a || !a.deliverable_id || !a.units.length) return null
  return { kind: a.kind === 'substitute' ? 'substitute' : 'redo', deliverable_id: a.deliverable_id, units: a.units, instruction: a.instruction, deadline: a.deadline }
}

/** The seller's deliveries in the room, merged by unit ref the way the platform keeps them (later units replace earlier ones). */
export function mergeDeliveries(list: Delivery[]): Delivery | null {
  if (!list.length) return null
  const out: Delivery = { note: list[list.length - 1]!.note, deliverables: [] }
  for (const d of list)
    for (const x of d.deliverables) {
      const t = out.deliverables.find((y) => y.deliverable_id === x.deliverable_id)
      if (!t) out.deliverables.push({ ...x, units: [...x.units] })
      else
        for (const u of x.units) {
          const i = t.units.findIndex((y) => y.ref === u.ref)
          if (i >= 0) t.units[i] = u
          else t.units.push(u)
        }
    }
  return out
}

/** Keep only what the agreement names: the agreed refs for a redo, at most as many new units as agreed for a substitute. */
export function restrictToAgreement(delivery: Delivery, a: AgreedWork): Delivery {
  const mine = delivery.deliverables.filter((x) => x.deliverable_id === a.deliverable_id)
  const refs = new Set(a.units.map((u) => u.replace(new RegExp(`^${a.deliverable_id}:`), '')))
  const deliverables = mine.map((x) => ({ ...x, units: a.kind === 'redo' ? x.units.filter((u) => refs.has(u.ref)) : x.units.slice(0, a.units.length) }))
  return { ...delivery, deliverables: deliverables.filter((x) => x.units.length > 0) }
}
