// The job state machine as data.
// RULES: which (op × state × role) is allowed, with an optional guard and whether to suggest it.
// TRANSITIONS: every state change the core may make (setState refuses anything else).
// nextActions(view, role) turns the same table into the "what can I do now" list agents rely on.
import type { Job, JobState, MediationStatus, NextAction, Role } from '@rentabot/shared'
import { TERMINAL_STATES } from '@rentabot/shared'

export const TRANSITIONS: Record<JobState, JobState[]> = {
  NEGOTIATING: ['AGREED', 'CANCELLED'],
  AGREED: ['AWAITING_APPROVAL', 'IN_PROGRESS', 'CANCELLED', 'EXPIRED'],
  AWAITING_APPROVAL: ['IN_PROGRESS', 'AGREED', 'CANCELLED', 'EXPIRED'],
  IN_PROGRESS: ['BLOCKED', 'DELIVERED', 'DISPUTED', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'DISPUTED', 'CANCELLED'],
  DELIVERED: ['SETTLED', 'CURE', 'DISPUTED'],
  CURE: ['DELIVERED', 'DISPUTED', 'SETTLED'],
  // Agreement in mediation settles (split, cancel), reopens work (redo, substitute: CURE) or waits for pending checks (DELIVERED);
  // no agreement after 3 rounds becomes a recommended ruling (RULED), or goes straight to a human (APPEALED).
  DISPUTED: ['RULED', 'APPEALED', 'SETTLED', 'CURE', 'DELIVERED'],
  RULED: ['SETTLED', 'APPEALED', 'CURE'],
  APPEALED: ['SETTLED', 'CURE'],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
}

export const canTransition = (from: JobState, to: JobState) => TRANSITIONS[from].includes(to)

/** Facts the guards need, computed by the job store from the internal record. */
export interface MachineView {
  job: Job
  now: number
  has_quote: boolean
  has_requirements: boolean
  /** Roles that accepted the CURRENT contract hash. */
  accepted_roles: Role[]
  open_questions: string[]
  missing_inputs: string[]
  /** Required access requests the buyer has not answered with share_secret yet. */
  missing_access: string[]
  has_delivery: boolean
  /** Buyer already accepted the delivery (delayed units may still be pending). */
  delivery_accepted: boolean
  deliver_by_passed: boolean
  ruling_accepted_by: Role[]
  mediator_questions: { id: string; to: 'buyer' | 'seller' }[]
  /** Mediation progress (null until a dispute is opened). */
  mediation: { status: MediationStatus; round: number; deadline: string | null } | null
  /** Proposals as the state table needs them: who still has to answer which. */
  proposals: { id: string; round: number; status: string; kind: string; by: string; answered: Role[]; summary: string }[]
  /** A settlement agreement (redo / substitute / wait) is running: the agreed checks decide the held money. */
  agreement_active: boolean
  secret_ids: string[]
  cursor: number
}

export type JobOp =
  | 'submit_requirements'
  | 'send_quote'
  | 'revise_spec'
  | 'provide_inputs'
  | 'accept_contract'
  | 'decline_job'
  | 'send_message'
  | 'fund_job'
  | 'get_escrow'
  | 'share_secret'
  | 'get_secret'
  | 'put_locker_item'
  | 'list_locker_items'
  | 'open_locker_item'
  | 'shred_locker_item'
  | 'log_action'
  | 'submit_delivery'
  | 'run_checks'
  | 'review_delivery'
  | 'open_dispute'
  | 'add_statement'
  | 'get_mediation'
  | 'respond_to_proposal'
  | 'answer_mediator'
  | 'get_ruling'
  | 'accept_ruling'
  | 'appeal_ruling'
  | 'arbiter_decide'
  | 'get_job'
  | 'get_messages'

interface Rule {
  op: JobOp
  states: JobState[] | 'any' | 'open'
  roles: Role[]
  /** Return a reason string when the op is NOT allowed right now. */
  guard?: (v: MachineView, role: Role) => string | null
  /** Show in next_actions? Read-only and optional ops are allowed but not suggested. */
  suggest?: (v: MachineView, role: Role) => boolean
  why: (v: MachineView, role: Role) => string
  args?: (v: MachineView, role: Role) => Record<string, unknown>
  /** One next_action per entry (e.g. one per open proposal); `why` and `args` are then ignored. */
  expand?: (v: MachineView, role: Role) => { why: string; args: Record<string, unknown> }[]
}

/** Open proposals this role has not answered yet. */
const unanswered = (v: MachineView, role: Role) => v.proposals.filter((p) => p.status === 'open' && !p.answered.includes(role))

const OPEN: JobState[] = ['NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'CURE', 'DISPUTED', 'RULED', 'APPEALED']
const FUNDED_OPEN: JobState[] = ['IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'CURE', 'DISPUTED', 'RULED', 'APPEALED']
const PARTIES: Role[] = ['buyer', 'seller']
const READERS: Role[] = ['buyer', 'seller', 'arbiter']
const never = () => false

export const RULES: Rule[] = [
  // ----- negotiation -----
  {
    op: 'submit_requirements',
    states: ['NEGOTIATING'],
    roles: ['seller'],
    suggest: (v) => !v.has_requirements,
    why: () => 'Say which inputs, access and assumptions you need, and ask your questions.',
  },
  {
    op: 'send_quote',
    states: ['NEGOTIATING'],
    roles: ['seller'],
    suggest: (v) => !v.has_quote,
    why: (v) => (v.has_quote ? 'Re-quote (resets acceptances).' : 'Price each deliverable; the quote total is what escrow will hold.'),
  },
  {
    op: 'revise_spec',
    states: ['NEGOTIATING'],
    roles: ['buyer'],
    suggest: never,
    why: () => 'Counter-offer: replace the job spec (resets acceptances).',
  },
  {
    op: 'provide_inputs',
    states: ['NEGOTIATING', 'IN_PROGRESS', 'BLOCKED'],
    roles: ['buyer'],
    suggest: (v) => v.open_questions.length > 0 || v.missing_inputs.length > 0,
    why: (v) =>
      `Answer the seller's questions${v.open_questions.length ? ` (${v.open_questions.join(', ')})` : ''} and fill the inputs${v.missing_inputs.length ? ` (${v.missing_inputs.join(', ')})` : ''} it asked for.`,
  },
  {
    op: 'accept_contract',
    states: ['NEGOTIATING'],
    roles: PARTIES,
    guard: (v) => (v.has_quote ? null : 'There is no quote yet, so there is no contract to accept.'),
    suggest: (v, role) => !v.accepted_roles.includes(role) && (role === 'seller' || (v.open_questions.length === 0 && v.missing_inputs.length === 0)),
    why: (v, role) =>
      v.accepted_roles.length ? `The ${v.accepted_roles.includes('buyer') ? 'buyer' : 'seller'} accepted; sign the same hash to freeze the contract.` : role === 'buyer' ? 'Sign the contract if the requirements and quote work for you.' : 'Sign the contract once your requirements and quote are final.',
    args: (v) => ({ contract_hash: v.job.contract_hash }),
  },
  {
    op: 'decline_job',
    states: ['NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED'],
    roles: PARTIES,
    guard: (v, role) =>
      (v.job.state === 'IN_PROGRESS' || v.job.state === 'BLOCKED') && role === 'buyer' && !v.deliver_by_passed
        ? 'After funding the buyer can only cancel once the delivery deadline has passed (or open a dispute).'
        : null,
    suggest: (v, role) => role === 'buyer' && v.deliver_by_passed && (v.job.state === 'IN_PROGRESS' || v.job.state === 'BLOCKED'),
    why: (v) => (v.deliver_by_passed ? 'The seller missed the deadline: cancel and void the held money.' : 'Walk away; nothing is charged.'),
  },
  { op: 'send_message', states: 'open', roles: PARTIES, suggest: never, why: () => 'Post in the Job Room.' },

  // ----- escrow -----
  {
    op: 'fund_job',
    states: ['AGREED', 'AWAITING_APPROVAL'],
    roles: ['buyer'],
    suggest: (v) => v.job.state === 'AGREED',
    why: (v) =>
      v.job.state === 'AGREED'
        ? `Put ${v.job.contract?.quote.total_max.value ?? ''} USD in escrow (authorized, not captured) before ${v.job.deadlines.fund_by ?? 'the deadline'}.`
        : 'Get the PayPal approval link again.',
    args: (v) => ({ idempotency_key: `fund-${v.job.id}-v${v.job.contract?.version ?? 0}` }),
  },
  { op: 'get_escrow', states: 'any', roles: READERS, suggest: never, why: () => 'Read the escrow ledger.' },

  // ----- work -----
  {
    op: 'share_secret',
    states: ['NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'CURE'],
    roles: ['buyer'],
    suggest: (v) => v.missing_access.length > 0 && v.job.state !== 'NEGOTIATING',
    why: (v) => `Seal the access the seller asked for (${v.missing_access.join(', ')}); it unseals only after funding.`,
    args: (v) => ({ access_id: v.missing_access[0] }),
  },
  {
    op: 'get_secret',
    states: FUNDED_OPEN,
    roles: ['seller'],
    guard: (v) => (v.secret_ids.length ? null : 'The buyer has not shared any secrets for this job.'),
    suggest: never,
    why: () => 'Read a secret the buyer sealed for this job (the read is logged).',
    args: (v) => ({ secret_id: v.secret_ids[0] }),
  },
  // ----- locker (core/locker.ts enforces who may open what, and when) -----
  {
    op: 'put_locker_item',
    states: ['NEGOTIATING', 'AGREED', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'CURE'],
    roles: ['buyer'],
    suggest: never,
    why: () => 'Answer an access request through the locker (end-to-end when the seller has a key).',
  },
  {
    op: 'put_locker_item',
    states: ['IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'CURE', 'DISPUTED'],
    roles: ['seller'],
    suggest: never,
    why: () => 'Hand over credentials your bot created for a delivered unit; the buyer opens them once the unit is paid.',
  },
  { op: 'list_locker_items', states: 'any', roles: READERS, suggest: never, why: () => 'Locker metadata, consent, action receipts and the audit log.' },
  { op: 'open_locker_item', states: 'any', roles: PARTIES, suggest: never, why: () => 'Open a locker item you are allowed to open now (every open is audited).' },
  { op: 'shred_locker_item', states: 'any', roles: PARTIES, suggest: never, why: () => 'Shred a locker item, or acknowledge a handover you took over.' },
  {
    op: 'log_action',
    states: FUNDED_OPEN,
    roles: ['seller'],
    guard: (v) => (v.job.contract?.requirements.access.some((a) => a.consent) ? null : 'No access request in the contract carries consent for real actions.'),
    suggest: never,
    why: () => 'Report each real-world action you take with the buyer’s access; it counts against their consent.',
  },
  {
    op: 'submit_delivery',
    states: ['IN_PROGRESS', 'CURE'],
    roles: ['seller'],
    why: (v) => (v.job.state === 'CURE' ? 'Fix the rejected items and deliver again before the cure window ends.' : `Deliver the work before ${v.job.deadlines.deliver_by ?? 'the deadline'}; checks run at once.`),
  },

  // ----- review -----
  {
    op: 'run_checks',
    states: ['DELIVERED', 'CURE', 'DISPUTED', 'RULED', 'APPEALED'],
    roles: PARTIES,
    guard: (v) => (v.has_delivery ? null : 'Nothing has been delivered yet.'),
    suggest: never,
    why: () => 'Re-run the acceptance checks on the current delivery.',
  },
  {
    op: 'review_delivery',
    states: ['DELIVERED'],
    roles: ['buyer'],
    guard: (v) => (v.delivery_accepted ? 'You already accepted this delivery.' : null),
    why: (v) => `Accept (pays what passed the checks) or reject specific items before ${v.job.deadlines.review_until ?? 'the review window ends'}; silence auto-releases what passed.`,
  },

  // ----- dispute -----
  {
    op: 'open_dispute',
    states: ['DELIVERED', 'CURE', 'IN_PROGRESS', 'BLOCKED'],
    roles: PARTIES,
    guard: (v, role) => {
      const s = v.job.state
      if ((s === 'IN_PROGRESS' || s === 'BLOCKED') && !v.deliver_by_passed && !(role === 'seller' && s === 'BLOCKED'))
        return 'Before delivery a dispute is only possible once the deadline has passed (or, for the seller, while blocked on the buyer).'
      if (s === 'DELIVERED' && v.delivery_accepted && role === 'buyer') return 'You accepted this delivery.'
      if (v.agreement_active) return 'A settlement agreed in mediation is running; the agreed checks decide the held money.'
      return null
    },
    suggest: never,
    why: () => 'Freeze the escrow and start mediation: the mediator proposes settlements for both sides to accept, reject or counter.',
  },
  {
    op: 'add_statement',
    states: ['DISPUTED', 'APPEALED'],
    roles: PARTIES,
    suggest: (v) => v.job.state === 'DISPUTED' && v.mediation?.status === 'investigating',
    why: () => 'Give the mediator your account with evidence while it assesses the case.',
  },
  { op: 'get_mediation', states: 'any', roles: READERS, suggest: never, why: () => 'Read the mediation: assessment, proposals and answers.' },
  {
    op: 'respond_to_proposal',
    states: ['DISPUTED'],
    roles: PARTIES,
    guard: (v, role) => {
      const m = v.mediation
      if (!m || m.status === 'investigating' || m.status === 'proposing') return 'The mediator is still preparing proposals; wait for the proposal message.'
      if (m.status !== 'negotiating') return `Negotiation is over (${m.status.replace('_', ' ')}).`
      return unanswered(v, role).length ? null : 'You have answered every open proposal.'
    },
    why: () => 'Answer an open settlement proposal: accept, reject (with a reason) or counter.',
    expand: (v, role) =>
      unanswered(v, role).map((p) => ({
        why: `Answer proposal ${p.id} (round ${p.round}${p.by !== 'mediator' ? `, countered by the ${p.by}` : ''}): ${p.summary}. accept, reject (reason required) or counter (terms required).`,
        args: { proposal_id: p.id },
      })),
  },
  {
    op: 'answer_mediator',
    states: ['DISPUTED'],
    roles: PARTIES,
    guard: (v, role) => (v.mediator_questions.some((q) => q.to === role) ? null : 'The mediator has no open question for you; it works through proposals: use get_mediation and respond_to_proposal.'),
    why: () => 'The mediator asked you a question; unanswered questions expire.',
    args: (v, role) => ({ question_id: v.mediator_questions.find((q) => q.to === role)?.id }),
  },
  { op: 'get_ruling', states: 'any', roles: READERS, suggest: never, why: () => 'Read the ruling.' },
  {
    op: 'accept_ruling',
    states: ['RULED'],
    roles: PARTIES,
    guard: (v, role) => (v.ruling_accepted_by.includes(role) ? 'You already accepted the ruling.' : null),
    why: () => 'Accept the ruling; when both sides accept (or the appeal window ends) it executes on PayPal.',
  },
  {
    op: 'appeal_ruling',
    states: ['RULED'],
    roles: PARTIES,
    guard: (v) => (v.job.deadlines.appeal_until && v.now > Date.parse(v.job.deadlines.appeal_until) ? 'The appeal window has closed.' : null),
    why: (v) => `Disagree? Appeal to a human arbiter before ${v.job.deadlines.appeal_until ?? 'the window closes'} (appeal bond applies).`,
  },
  { op: 'arbiter_decide', states: ['APPEALED'], roles: ['arbiter'], why: () => 'Confirm the AI ruling or override the remedy; your decision is final.' },

  // ----- reads -----
  { op: 'get_job', states: 'any', roles: READERS, suggest: never, why: () => 'Read the job.' },
  { op: 'get_messages', states: 'any', roles: READERS, suggest: never, why: () => 'Read the Job Room.' },
]

const RULES_BY_OP = new Map<JobOp, Rule[]>()
for (const r of RULES) RULES_BY_OP.set(r.op, [...(RULES_BY_OP.get(r.op) ?? []), r])

const stateMatches = (r: Rule, s: JobState) => (r.states === 'any' ? true : r.states === 'open' ? OPEN.includes(s) : r.states.includes(s))

export type Verdict = { ok: true } | { ok: false; code: 'forbidden' | 'invalid_state'; reason: string }

/** May `role` run `op` on this job right now? */
export function check(op: JobOp, v: MachineView, role: Role): Verdict {
  const rules = RULES_BY_OP.get(op) ?? []
  const forRole = rules.filter((r) => r.roles.includes(role))
  if (!forRole.length) return { ok: false, code: 'forbidden', reason: `${op} is not available to the ${role}.` }
  const inState = forRole.filter((r) => stateMatches(r, v.job.state))
  if (!inState.length) return { ok: false, code: 'invalid_state', reason: `${op} is not allowed while the job is ${v.job.state}.` }
  for (const r of inState) {
    const reason = r.guard?.(v, role)
    if (!reason) return { ok: true }
    if (r === inState[inState.length - 1]) return { ok: false, code: 'invalid_state', reason }
  }
  return { ok: false, code: 'invalid_state', reason: `${op} is not allowed now.` }
}

/** The operations `role` can usefully take now, with the arguments already known. */
export function nextActions(v: MachineView, role: Role): NextAction[] {
  const s = v.job.state
  if (TERMINAL_STATES.includes(s)) return []
  const out: NextAction[] = []
  for (const r of RULES) {
    if (!r.roles.includes(role) || !stateMatches(r, s)) continue
    if (r.guard?.(v, role)) continue
    if (r.suggest && !r.suggest(v, role)) continue
    if (r.expand) {
      for (const e of r.expand(v, role)) out.push({ op: r.op, why: e.why, args: { job_id: v.job.id, ...e.args } })
      continue
    }
    out.push({ op: r.op, why: r.why(v, role), args: { job_id: v.job.id, ...(r.args?.(v, role) ?? {}) } })
  }
  if (!out.length) out.push({ op: 'wait_for_events', why: waitWhy(v, role), args: { job_id: v.job.id, after_cursor: v.cursor } })
  return out
}

function waitWhy(v: MachineView, role: Role): string {
  switch (v.job.state) {
    case 'NEGOTIATING':
      return role === 'buyer' ? 'Waiting for the seller’s requirements, quote or signature.' : 'Waiting for the buyer.'
    case 'AGREED':
      return 'Waiting for the buyer to fund the escrow.'
    case 'AWAITING_APPROVAL':
      return 'Waiting for a human to approve the payment on PayPal.'
    case 'IN_PROGRESS':
      return 'The seller is working; wait for progress or the delivery.'
    case 'BLOCKED':
      return 'The seller is waiting on the buyer.'
    case 'DELIVERED':
      return v.delivery_accepted ? 'Delayed checks are still running; the rest settles when the verify window ends.' : 'Waiting for the buyer’s review.'
    case 'CURE':
      return 'Waiting for the seller to fix and redeliver.'
    case 'DISPUTED':
      if (v.mediation?.status === 'negotiating') return 'Your answers are in; waiting for the other side or the end of the round (' + (v.mediation.deadline ?? 'soon') + ').'
      return 'The mediator is assessing the case and preparing proposals.'
    case 'RULED':
      return 'Waiting for the other side to accept or appeal the ruling.'
    case 'APPEALED':
      return 'A human arbiter is reviewing the case.'
    default:
      return 'Wait for the next event.'
  }
}

/** True when the role has something to do (for list_jobs needs_action). */
export const needsAction = (v: MachineView, role: Role) => nextActions(v, role).some((a) => a.op !== 'wait_for_events')
