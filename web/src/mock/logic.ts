// Mock server logic shared by read and write handlers: who is calling, what role they have, what they can do next.
import type { Job, JobSummary, NextAction, Role } from '../api/types'
import type { Db, MockUser } from './db'
import { IDS } from './db'
import { amt, cents, usd } from './util'

export interface Caller {
  user: MockUser | null
  agent_id: string | null
}

export class MockError extends Error {
  status: number
  code: string
  hint: string
  next_actions: NextAction[]
  constructor(status: number, code: string, message: string, hint = '', next_actions: NextAction[] = []) {
    super(message)
    this.status = status
    this.code = code
    this.hint = hint
    this.next_actions = next_actions
  }
}
export const fail = (status: number, code: string, message: string, hint = '', next_actions: NextAction[] = []): never => {
  throw new MockError(status, code, message, hint, next_actions)
}

export function roleOf(job: Job, c: Caller): Role | null {
  if (c.agent_id && c.agent_id === job.buyer_agent_id) return 'buyer'
  if (c.agent_id && c.agent_id === job.seller_agent_id) return 'seller'
  if (c.user?.role === 'arbiter') return 'arbiter'
  return null
}

export function requireUser(c: Caller): MockUser {
  return c.user ?? fail(401, 'unauthenticated', 'Sign in or send an API key.', 'Use POST /api/session/demo for the demo, or register_agent for an API key.')
}

export function requireJob(db: Db, id: string, c: Caller): { job: Job; role: Role } {
  const job = db.jobs[id] ?? fail(404, 'not_found', `No job ${id}.`, 'Call list_jobs to see your jobs.')
  requireUser(c)
  const role = roleOf(job, c) ?? fail(403, 'forbidden', 'You are not a party to this job.', 'Only the buyer, the seller and arbiters can read a job.')
  return { job, role }
}

export function pendingQuestions(db: Db, jobId: string): { id: string; to: 'buyer' | 'seller'; question: string }[] {
  const msgs = db.messages[jobId] ?? []
  const answered = new Set(msgs.filter((m) => m.type === 'mediator_answer').map((m) => String((m.body as { question_id?: string }).question_id)))
  return msgs
    .filter((m) => m.type === 'mediator_question')
    .map((m) => m.body as { question_id: string; to: 'buyer' | 'seller'; question: string })
    .filter((q) => !answered.has(q.question_id))
    .map((q) => ({ id: q.question_id, to: q.to, question: q.question }))
}

/** The operations this role can take now. Mirrors the server's next_actions semantics. */
export function nextActions(db: Db, job: Job, role: Role): NextAction[] {
  const a: NextAction[] = []
  const id = job.id
  const act = (op: string, why: string, args: Record<string, unknown> = {}) => a.push({ op, why, args: { job_id: id, ...args } })
  const msgs = db.messages[id] ?? []
  const hash = job.contract_hash
  const acceptedBy = (r: Role) => job.accepted_by.some((x) => x.role === r && x.contract_hash === hash)
  const hasType = (t: string) => msgs.some((m) => m.type === t)
  if (role === 'arbiter') {
    if (job.state === 'APPEALED') act('arbiter_decide', 'Confirm the AI ruling or override the remedy.', { decision: 'confirm' })
    return a
  }
  switch (job.state) {
    case 'NEGOTIATING': {
      if (role === 'buyer') {
        const unanswered = (job.contract?.requirements.questions ?? []).filter((q) => !(job.contract?.answers ?? {})[q.id])
        if (unanswered.length) act('provide_inputs', `The seller asked ${unanswered.length} question${unanswered.length > 1 ? 's' : ''}. Answer them and fill the inputs.`, { answers: Object.fromEntries(unanswered.map((q) => [q.id, ''])) })
        if (hasType('quote') && !acceptedBy('buyer')) act('accept_contract', 'Sign the contract once the answers are in.', { contract_hash: hash })
        act('revise_spec', 'Change the spec (resets acceptances).')
      } else {
        if (!hasType('requirements')) act('submit_requirements', 'State what you need to start.')
        if (!hasType('quote')) act('send_quote', 'Price each deliverable.')
        if (hasType('quote') && !acceptedBy('seller')) act('accept_contract', 'Sign the contract.', { contract_hash: hash })
      }
      act('send_message', 'Ask or answer something in the room.', { type: role === 'buyer' ? 'clarify' : 'note' })
      act('decline_job', 'Walk away before funding.')
      break
    }
    case 'AGREED':
      if (role === 'buyer') act('fund_job', 'Put the money in escrow. It is authorized on PayPal, not taken.', { idempotency_key: `fund-${id}` })
      act('decline_job', 'Cancel before funding.')
      break
    case 'AWAITING_APPROVAL':
      if (role === 'buyer') act('get_escrow', 'Open the PayPal approval link on the escrow ledger, then come back.')
      act('decline_job', 'Cancel before funding.')
      break
    case 'IN_PROGRESS':
    case 'BLOCKED':
      if (role === 'seller') {
        act('submit_delivery', 'Deliver every unit with its URL and evidence.')
        act('send_message', 'Post progress or a blocker.', { type: 'progress' })
      } else {
        act('send_message', 'Message the seller.', { type: 'note' })
        if (job.state === 'BLOCKED') act('send_message', 'Unblock the seller once you have provided what they need.', { type: 'unblock' })
        act('share_secret', 'Seal a credential for the seller (released only once funded).')
      }
      act('open_dispute', 'Only if the deadline was missed or the seller stopped responding.')
      break
    case 'DELIVERED':
      act('run_checks', 'Re-run the checks, useful for delayed ones.')
      if (role === 'buyer') {
        act('review_delivery', 'Accept to pay every unit that passed, or reject with reasons.', { decision: 'accept' })
      }
      act('open_dispute', 'Dispute the result. Escrow freezes and the mediator starts.')
      break
    case 'CURE':
      if (role === 'seller') act('submit_delivery', 'Redo the rejected units within the cure window.')
      act('open_dispute', 'Dispute instead of waiting.')
      break
    case 'DISPUTED': {
      const med = job.mediation
      if (med?.status === 'negotiating' && (role === 'buyer' || role === 'seller')) {
        // one entry per open proposal this side can still answer (not its own counter, not already answered)
        for (const p of med.proposals) {
          if (p.status !== 'open' || p.by === role || p.responses[role]) continue
          const from = p.by === 'mediator' ? 'The mediator proposed' : `The ${p.by} counter-proposed`
          act('respond_to_proposal', `${from} terms (round ${p.round} of 3). Accept, reject with a reason, or counter.`, { proposal_id: p.id })
        }
      }
      const q = pendingQuestions(db, id).filter((x) => x.to === role)
      for (const x of q) act('answer_mediator', x.question, { question_id: x.id })
      act('add_statement', 'Add your account with evidence.')
      break
    }
    case 'RULED':
      act('get_ruling', 'Read the ruling.')
      act('accept_ruling', 'Accept. When both accept, or the appeal window ends, the remedy executes.')
      act('appeal_ruling', 'Appeal to a human arbiter.')
      break
    default:
      act('get_escrow', 'See the final ledger.')
  }
  return a
}

export function summary(db: Db, job: Job, role: Role): JobSummary {
  const held = cents(job.escrow.authorized.value) - cents(job.escrow.captured.value) - cents(job.escrow.voided.value) - cents(job.escrow.refunded.value)
  const dl = [job.deadlines.fund_by, job.deadlines.deliver_by, job.deadlines.review_until, job.deadlines.cure_until, job.deadlines.appeal_until].filter(Boolean) as string[]
  const upcoming = dl.filter((d) => new Date(d).getTime() > Date.now()).sort()[0] ?? null
  void db
  return { id: job.id, state: job.state, title: job.title, seller_bot_id: job.seller_bot_id, buyer_agent_id: job.buyer_agent_id, updated_at: job.updated_at, your_role: role, held: usd(Math.max(held, 0)), money: { authorized: job.escrow.authorized, captured: job.escrow.captured, voided: job.escrow.voided, refunded: job.escrow.refunded, paid_out: job.escrow.paid_out, payout_pending: usd(0) }, next_deadline: upcoming } as JobSummary
}

export function needsAction(db: Db, job: Job, role: Role): boolean {
  const acts = nextActions(db, job, role).filter((x) => !['get_escrow', 'get_ruling', 'send_message', 'run_checks', 'decline_job', 'revise_spec', 'open_dispute', 'share_secret', 'add_statement'].includes(x.op))
  return acts.length > 0
}

export const money = (c: number) => ({ value: amt(c), currency: 'USD' as const })
export { IDS }
