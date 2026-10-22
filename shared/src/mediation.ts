// Negotiation-first mediation (docs/MEDIATION.md v2): the shapes of `job.mediation`, proposals and responses.
// Amounts are Amount strings ("46.50") on the wire; the server does all math in integer cents
// (server/src/intelligence/negotiation/terms.ts). Server, web app and agents import these from '@rentabot/shared'.
import { z } from 'zod'
import { AcceptanceTest, Amount, Finding, JurorVote, Role, Timestamp } from './primitives.ts'

export const MAX_ROUNDS = 3
/** Redo / wait deadlines may be at most this far out. */
export const MAX_HOLD_DAYS = 14

export const Party = z.enum(['buyer', 'seller'])
export type Party = z.infer<typeof Party>

export const Redo = z.object({
  deliverable_id: z.string(),
  /** Unit refs to fix (e.g. "dir-32"), or new unit names for substitute work. */
  units: z.array(z.string().min(1).max(200)).min(1).max(500),
  instruction: z.string().max(600),
  deadline: Timestamp,
  /** Held now; captured automatically when the acceptance checks pass on the redo units, voided otherwise. */
  amount_on_success: Amount,
  /** Check ids must come from the contract deliverable's acceptance tests. */
  acceptance: z.array(AcceptanceTest).min(1),
})
export type Redo = z.infer<typeof Redo>

export const ProposalTerms = z.object({
  release_now: Amount,
  refund_now: Amount,
  redo: Redo.nullable().default(null),
  /** Hold the remainder until then, then settle by the checks. */
  wait_until: Timestamp.nullable().default(null),
  cancel: z.boolean().default(false),
  note: z.string().max(600).default(''),
})
export type ProposalTerms = z.infer<typeof ProposalTerms>

/** What a party may send as a counter: any subset; omitted amounts are derived, omitted structure copied from the proposal it counters. */
export const CounterTerms = z.object({
  release_now: Amount.optional(),
  refund_now: Amount.optional(),
  redo: Redo.partial().nullable().optional(),
  wait_until: Timestamp.nullable().optional(),
  cancel: z.boolean().optional(),
  note: z.string().max(600).optional(),
})
export type CounterTerms = z.infer<typeof CounterTerms>

export const ProposalKind = z.enum(['split', 'redo', 'substitute', 'wait', 'cancel', 'custom'])
export type ProposalKind = z.infer<typeof ProposalKind>

export const ResponseAnswer = z.enum(['accept', 'reject', 'counter'])
export type ResponseAnswer = z.infer<typeof ResponseAnswer>
export const ProposalResponse = z.object({
  answer: ResponseAnswer,
  reason: z.string().max(2000).default(''),
  /** Only for counter. */
  terms: CounterTerms.nullable().default(null),
  message_id: z.string().nullable().default(null),
  ts: Timestamp.optional(),
})
export type ProposalResponse = z.infer<typeof ProposalResponse>

export const ProposalStatus = z.enum(['open', 'accepted', 'rejected', 'superseded', 'expired'])
export type ProposalStatus = z.infer<typeof ProposalStatus>

export const SettlementPreview = z.object({
  capture_now: Amount,
  void_now: Amount,
  held: Amount,
  platform_commission: Amount,
  seller_payout_now: Amount,
  /** If the held money is released later (redo passes / wait settles in the seller's favour). */
  held_commission: Amount,
  held_seller_payout: Amount,
  /** Redo / wait: release_now is only secured now and paid with the job's single final capture (one capture per job). */
  secured: Amount.optional(),
})
export type SettlementPreview = z.infer<typeof SettlementPreview>

export const Proposal = z.object({
  id: z.string().regex(/^prp_[A-Za-z0-9]{6,40}$/),
  round: z.int().min(1),
  by: z.enum(['mediator', 'buyer', 'seller']),
  kind: ProposalKind.default('custom'),
  status: ProposalStatus,
  terms: ProposalTerms,
  rationale: z.string().max(2000),
  /** Validation flags, e.g. outside_fair_range_high (only ever on party counters). */
  flags: z.array(z.string()).default([]),
  preview: SettlementPreview.optional(),
  /** For party counters: the proposal it counters. */
  counters: z.string().nullable().default(null),
  responses: z.object({ buyer: ProposalResponse.optional(), seller: ProposalResponse.optional() }).default({}),
  created_at: Timestamp.optional(),
})
export type Proposal = z.infer<typeof Proposal>

export const IntegrityFlag = z.object({
  party: Role,
  message_id: z.string().nullable(),
  excerpt: z.string().max(400),
  kind: z.enum(['prompt_injection', 'fabricated_evidence', 'policy']),
  /** Round the flag was raised in (0 = during assessment). */
  round: z.int().min(0).default(0),
})
export type IntegrityFlag = z.infer<typeof IntegrityFlag>

export const Assessment = z.object({
  /** What the checks verified (seller's total, incl. anything already captured). Lower bound of the fair range. */
  verified_value: Amount,
  /** What the seller's delivery claims (capped at authorized). */
  claimed_value: Amount,
  /** Fair total for the seller: [checks-verified, most the evidence supports]. */
  fair_range: z.tuple([Amount, Amount]),
  findings: z.array(Finding),
  integrity_flags: z.array(IntegrityFlag),
  jury: z.array(JurorVote),
  faults: z.object({ buyer: z.array(z.string()), seller: z.array(z.string()) }),
  summary: z.string().max(3000),
  confidence: z.number().min(0).max(1),
  basis: z.enum(['jury', 'checks']),
  escalation_reasons: z.array(z.string()).default([]),
})
export type Assessment = z.infer<typeof Assessment>

export const MediationStatus = z.enum(['investigating', 'proposing', 'negotiating', 'agreed', 'no_agreement'])
export type MediationStatus = z.infer<typeof MediationStatus>

export const MediationState = z.object({
  status: MediationStatus,
  round: z.int().min(0),
  /** When the current round ends; unanswered proposals are then treated as no answer and the next round starts. */
  deadline: Timestamp.nullable(),
  assessment: Assessment.nullable(),
  proposals: z.array(Proposal),
  /** Proposal both sides accepted, once agreed. */
  agreed_proposal_id: z.string().nullable().default(null),
})
export type MediationState = z.infer<typeof MediationState>
