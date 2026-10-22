// Conventions for Message.body, per message type. The shared schema leaves `body` as a free record,
// so these are the shapes the web app reads (and the mock server writes). Renderers must stay tolerant:
// every accessor returns undefined instead of throwing, and unknown types fall back to a JSON view.
import type {
  AcceptanceTest, Assessment, CheckResult, CounterTerms, Delivery, IntegrityFlag, JobSpec, MediationState, Message, Party, Proposal, ProposalKind, ProposalResponse, ProposalStatus, ProposalTerms,
  Quote, Redo, Requirements, ResponseAnswer, Ruling, SettlementPreview,
} from './types'

export interface JobSpecBody { spec: JobSpec }
export interface RequirementsBody { requirements: Requirements }
export interface QuoteBody { quote: Quote }
export interface AnswerBody { answers?: Record<string, string>; inputs?: Record<string, unknown> }
export interface AcceptBody { contract_hash: string; frozen?: boolean }
export interface ProgressBody { percent?: number; units_done?: number; units_total?: number }
export interface ArtifactBody { title?: string; kind?: 'screenshot' | 'file' | 'transcript' | 'link' | string }
export interface EvidenceBody { title?: string; checks?: CheckResult[] }
/** `checks` carries the T0 results the platform ran right after the delivery. */
export interface DeliveryBody { delivery: Delivery; checks: CheckResult[] }
export interface ReviewBody { decision: 'accept' | 'reject'; rejections?: { deliverable_id: string; unit_refs: string[]; check?: string; reason: string }[] }
export interface DisputeBody { reason: string; claims: string[] }
export interface MediatorQuestionBody { question_id: string; to: 'buyer' | 'seller'; question: string; expires_at?: string }
export interface MediatorAnswerBody { question_id: string }
export interface RulingBody { ruling: Ruling }
export interface AppealBody { grounds: string }
export interface ArbiterDecisionBody { decision: 'confirm' | 'override'; note: string; release_to_seller?: string }
export interface SystemBody { event?: string; amount?: string; paypal_id?: string; webhook?: string; flag?: boolean }

export function bodyOf<T>(m: Message): Partial<T> {
  return (m.body ?? {}) as Partial<T>
}

export type { AcceptanceTest }

// ---- Negotiation-first mediation (shared/src/mediation.ts, docs/MEDIATION.md). The proposal shapes are the shared ones;
// the bodies below are the room messages the server posts around them. The LIVE state of a proposal is job.mediation.proposals:
// the message body is only a snapshot taken when the message was posted.
export type {
  Assessment, CounterTerms, IntegrityFlag, MediationState, Party, Proposal, ProposalKind, ProposalResponse, ProposalStatus, ProposalTerms, Redo, ResponseAnswer, SettlementPreview,
}

/** type 'proposal': from the mediator, or from a party for a counter-proposal. The assessment rides on the first proposal of round 1 only. */
export interface ProposalBody { proposal: Proposal; assessment?: Assessment; round: number; round_deadline: string | null }
/** type 'proposal_response': from buyer or seller. `terms` are the normalized full terms (counters only). */
export interface ProposalResponseBody { proposal_id: string; by: 'buyer' | 'seller'; answer: ResponseAnswer; reason: string; terms?: ProposalTerms; counter_proposal_id?: string; explanation?: string }
/** type 'settlement': posted by the platform when both sides accepted the same proposal. `executed` holds the escrow totals after execution. */
export interface SettlementBody {
  proposal_id: string
  round: number
  kind: ProposalKind
  terms: ProposalTerms
  executed: { captured: string; platform_fee: string; seller_payout: string; refunded: string; still_held: string }
  amendment: { units: string[]; deadline: string; note: string; version: number; deliverable_id: string | null } | null
}
