// Internal records. The public `Job` (shared/protocol.ts) is rendered from a JobRecord;
// money is integer cents here and becomes Amount strings only when rendered.
import type { FeePolicy } from './fees.ts'
import type {
  AcceptanceTest,
  CapabilityClass,
  ContractAmendment,
  Delivery,
  EscrowEvent,
  EscrowStatus,
  Fulfilment,
  JobSpec,
  JobState,
  MediationState,
  PaymentRailKind,
  PolicyClass,
  Quote,
  Requirements,
  Role,
  Ruling,
  Timers,
} from '@rentabot/shared'

export interface PayoutItem {
  sender_item_id: string
  batch_id: string | null
  item_id: string | null
  cents: number
  status: 'sent' | 'succeeded' | 'failed'
  /** When the payout was requested (the reconciler looks it up on PayPal if no webhook confirmed it by then). */
  at?: string
}

export interface EscrowState {
  rail: PaymentRailKind
  mode: 'hold' | 'capture_and_hold'
  status: EscrowStatus
  authorized: number
  /** Captures PayPal reported COMPLETED. */
  captured: number
  voided: number
  refunded: number
  /** Platform fee on the seller's gross release (always recomputed on the cumulative release). */
  platform_fee: number
  /** Buyer-side mediation fee captured for the platform. */
  platform_extra: number
  /** Seller-side mediation fee withheld from the payout (applied amount). */
  seller_fee: number
  /** Capture-and-hold: PayPal's non-returned fee kept from refunds (fees.ts refundKeptFee). Absent on older records. */
  refund_fee?: number
  /** Capture-and-hold: seller release tranches that were paid out (the settlement count; hold mode counts captures). */
  tranches?: number
  /** Seller-side mediation fee the ruling assigned; applied when the payout is computed. */
  seller_fee_target: number
  /** Cumulative gross amount released to the seller (target; captures may still be pending). */
  seller_release: number
  payout_requested: number
  /** Payouts PayPal confirmed (PAYMENT.PAYOUTS-ITEM.SUCCEEDED). */
  paid_out: number
  pending_captures: { capture_id: string; cents: number; fee_part: number; at?: string }[]
  /** Fee part per capture id, applied once it completes. */
  capture_fee_parts: Record<string, number>
  approval_url: string | null
  order_id: string | null
  authorization_id: string | null
  capture_ids: string[]
  refund_ids: string[]
  payouts: PayoutItem[]
  honor_expires_at: string | null
  authorization_expires_at: string | null
  reauthorized: boolean
  /** Actual PayPal fees reported by PayPal (capture seller_receivable_breakdown.paypal_fee, payout_item_fee). */
  paypal_fees: { capture: number; payout: number; by_id: Record<string, number> }
  /** Final capture or void done: nothing more can be captured. */
  finalized: boolean
  mandate_id: string | null
  funded_at: string | null
  events: EscrowEvent[]
}

export interface MediationQuestion {
  id: string
  to: 'buyer' | 'seller'
  text: string
  round: number
  answer: string | null
  message_id: string
}

/** Internal mediation record; `state` is the public part rendered as job.mediation. */
export interface MediationRecord {
  opened_by: 'buyer' | 'seller'
  reason: string
  claims: string[]
  opened_at: string
  /** When the case ended (agreement executed or ruling issued); null while open. */
  closed_at: string | null
  /**
   * The seller's gross already released when the dispute opened. Frozen: the negotiated money is authorized − this, and an
   * agreement is computed from it even when a first execution attempt failed halfway (the escrow's own figure may have moved).
   */
  released_cents: number
  state: MediationState
  /** Questions the mediator may still ask (the negotiation mediator works through proposals and normally asks none). */
  questions: MediationQuestion[]
  answer_until: string | null
}

/**
 * What both parties agreed in mediation when money is still held: a redo / substitute delivery or a wait.
 * The seller's final gross = secured + min(held, gain), where gain = what the checks now earn beyond base_earned.
 */
export interface AgreementRecord {
  proposal_id: string
  kind: 'redo' | 'substitute' | 'wait'
  deliverable_id: string | null
  /** Redo unit refs to fix, or the placeholder names of the substitute units. */
  units: string[]
  /** Substitute: the failed units the new ones replace in the delivery. */
  replaces: string[]
  instruction: string
  acceptance: AcceptanceTest[]
  /** Delivery deadline (redo / substitute) or when the wait ends (wait), in this server's (demo-scaled) time. */
  deadline: string
  /** Seller gross locked in at agreement: already released + release_now (captured now, or deferred below the minimum settlement). */
  secured_cents: number
  /** Authorized money kept for the redo / wait; paid when the checks pass, voided otherwise. */
  held_cents: number
  /** Check-earned total (rec.earned_cents) when the agreement was made. */
  base_earned_cents: number
  agreed_at: string
}

export interface Rejection {
  deliverable_id: string
  unit_refs: string[]
  check?: string
  reason: string
}

export interface JobRecord {
  id: string
  state: JobState
  title: string
  buyer_agent_id: string
  seller_bot_id: string
  seller_agent_id: string
  skill_id: string
  capability_class: CapabilityClass
  requires_scope_proof: boolean
  // contract parts (job.contract is built from these once a quote exists)
  spec: JobSpec
  requirements: Requirements | null
  quote: Quote | null
  answers: Record<string, string>
  inputs: Record<string, unknown>
  timers: Timers
  /** Fee terms frozen when the job opened and signed into the contract hash. Use Domain.feePolicy(rec) for the fee math. */
  fees: { platform_bps: number; mediation_flat: string; floor: string; min_settlement: string }
  /** Legacy (before the floor moved into the contract); only read when migrating an old record. */
  fee_policy?: FeePolicy
  /** Changes agreed in mediation after funding; part of the contract. */
  amendments: ContractAmendment[]
  /** Active settlement agreement (redo / substitute / wait) the checks are executing, if any. */
  agreement: AgreementRecord | null
  version: number
  contract_hash: string | null
  accepted_by: { role: Role; agent_id: string; contract_hash: string; ts: string }[]
  /** Contract hash frozen at AGREED. */
  agreed_hash: string | null
  escrow: EscrowState
  delivery: Delivery | null
  delivered_at: string | null
  delivery_count: number
  fulfilment: Fulfilment[]
  earned_cents: number
  held_pending_cents: number
  review: { accepted: boolean; accepted_at: string | null; rejections: Rejection[] }
  ruling: Ruling | null
  ruling_accepted_by: Role[]
  mediation: MediationRecord | null
  appeal: { by: 'buyer' | 'seller'; grounds: string; bond_cents: number; bond_status: 'held' | 'refunded' | 'forfeited'; at: string } | null
  deadlines: {
    fund_by: string | null
    deliver_by: string | null
    review_until: string | null
    cure_until: string | null
    appeal_until: string | null
    verify_until: string | null
  }
  blocked_since: string | null
  policy: { class: PolicyClass; reasons: string[] }
  /** PayPal-Request-Id counters per transition (`<job>:<transition>:<n>`). */
  req: Record<string, number>
  on_time: boolean | null
  settled_at: string | null
  /** Set when an open-job award created this job. */
  origin?: { open_job_id: string; bid_id: string } | null
  created_at: string
  updated_at: string
}

export const emptyRequirements = (): Requirements => ({ inputs_schema: {}, access: [], assumptions: [], questions: [] })

export function newEscrow(rail: PaymentRailKind): EscrowState {
  return {
    rail,
    mode: 'hold',
    status: 'none',
    authorized: 0,
    captured: 0,
    voided: 0,
    refunded: 0,
    platform_fee: 0,
    platform_extra: 0,
    seller_fee: 0,
    refund_fee: 0,
    tranches: 0,
    seller_fee_target: 0,
    seller_release: 0,
    payout_requested: 0,
    paid_out: 0,
    pending_captures: [],
    capture_fee_parts: {},
    approval_url: null,
    order_id: null,
    authorization_id: null,
    capture_ids: [],
    refund_ids: [],
    payouts: [],
    honor_expires_at: null,
    authorization_expires_at: null,
    reauthorized: false,
    paypal_fees: { capture: 0, payout: 0, by_id: {} },
    finalized: false,
    mandate_id: null,
    funded_at: null,
    events: [],
  }
}

/** Money still held for the buyer: authorized minus captured, voided (hold) or captured minus refunded and released (capture_and_hold). */
export function heldCents(e: EscrowState): number {
  if (e.status === 'none' || e.status === 'pending_approval' || e.finalized) return 0
  if (e.mode === 'hold') return Math.max(0, e.authorized - e.captured - e.voided - pendingCents(e))
  return Math.max(0, e.captured - e.refunded - (e.refund_fee ?? 0) - e.seller_release)
}
export const pendingCents = (e: EscrowState) => e.pending_captures.reduce((s, p) => s + p.cents, 0)
