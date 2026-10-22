// The seam between the domain core and the AI/verification layer.
// The core (state machine, escrow, store) calls these; it never calls a model directly.
// Models propose; only the core moves money.
import type { AiClient } from './ai/provider.ts'
import type { Negotiator } from './negotiation/negotiator.ts'
import type {
  AcceptanceTest,
  Artifact,
  BotCard,
  CheckDefinition,
  CheckResult,
  Contract,
  Delivery,
  Fulfilment,
  JobSpec,
  Message,
  Money,
  PolicyClass,
  Ruling,
  Skill,
} from '@rentabot/shared'

// ---------- checks ----------

export interface CheckContext {
  job_id: string
  contract: Contract
  deliverable_id: string
  /** Present for per-unit checks. */
  unit: Delivery['deliverables'][number]['units'][number] | null
  test: AcceptanceTest
  attempt: number
  /** Look up an artifact's metadata and bytes (screenshots, reports). */
  artifact(id: string): Promise<{ meta: Artifact; bytes: Uint8Array } | null>
  /** Store evidence (an HTTP transcript, a page excerpt, a replay log) and get its id. */
  saveEvidence(kind: string, summary: string, payload: unknown): Promise<string>
}

export interface CheckOutcome {
  status: CheckResult['status']
  detail: string
  evidence_id: string | null
}

export interface CheckImpl {
  def: CheckDefinition
  run(ctx: CheckContext): Promise<CheckOutcome>
}

export interface CheckLibrary {
  list(): CheckDefinition[]
  get(id: string): CheckImpl | undefined
  /** Let later modules (Sandbox Web, bots) add checks at boot. */
  register(impl: CheckImpl): void
}

// ---------- policy gate ----------

export interface PolicyVerdict {
  class: PolicyClass // standard | restricted (security: scope proof; otherwise never mandate-funded, the owner approves on PayPal) | blocked
  reasons: string[]
}

export interface PolicyGate {
  reviewSpec(spec: JobSpec, bot: BotCard): Promise<PolicyVerdict>
  reviewBot(bot: Pick<BotCard, 'name' | 'tagline' | 'description' | 'capability_class' | 'skills'>): Promise<PolicyVerdict>
}

// ---------- spec copilot ----------

export interface SpecDraftRequest {
  bot: BotCard
  skill: Skill
  goal: string
  quantity?: number
  deadline?: string
  budget_cap?: string
  context?: string
  checks: CheckDefinition[]
}

export interface SpecDraft {
  spec: JobSpec
  estimate: Money
  warnings: string[]
}

export interface SpecCopilot {
  draft(req: SpecDraftRequest): Promise<SpecDraft>
}

// ---------- mediator ----------

export interface MediationBundle {
  job_id: string
  contract: Contract
  contract_hash: string
  messages: Message[] // the whole room, in order
  delivery: Delivery | null
  checks: CheckResult[] // freshly re-run by the core before mediation
  fulfilment: Fulfilment[]
  /** Facts the core already knows: deadline missed by, blockers left unanswered, rejections given. */
  timeline: { late_by_minutes: number; unanswered_blockers: number; vague_rejections: number }
  dispute: { opened_by: 'buyer' | 'seller'; reason: string; claims: string[] }
  amounts: {
    authorized: Money
    /** What the seller already got (captured and paid, or released and pending). Negotiated money is authorized − already_captured. */
    already_captured: Money
    platform_fee_bps: number
    /** Commission floor (contract fees.floor) in cents; omitted: no floor. */
    platform_fee_floor_cents?: number
    mediation_flat: Money
  }
  /** Answers to earlier mediator questions, if any. */
  answers: { question_id: string; to: 'buyer' | 'seller'; question: string; answer: string | null }[]
}

export type MediatorStep =
  | { kind: 'ask'; questions: { id: string; to: 'buyer' | 'seller'; text: string }[] }
  | { kind: 'rule'; ruling: Omit<Ruling, 'id' | 'created_at' | 'appealable_until'> }

export interface Mediator {
  /** One mediation step: either questions for the parties (max 2 rounds) or a ruling. Pure: no side effects. */
  step(bundle: MediationBundle, round: number): Promise<MediatorStep>
}

// ---------- AI provider ----------

export interface AiInfo {
  provider: 'openai' | 'anthropic' | 'none'
  models: { fast: string; main: string; mediator: string; jury: string[] }
}

export interface Intelligence {
  ai: AiInfo
  /** The shared AI client behind every model call (monthly spend cap). The in-process house bots wrap it (bots/src/server-ai.ts). */
  aiClient: AiClient
  checks: CheckLibrary
  policy: PolicyGate
  copilot: SpecCopilot
  /** Kept for the mediator's own tests; the core negotiates through `negotiator` (which builds on a mediator). */
  mediator: Mediator
  /** Negotiation-first mediation: assess, propose, evaluate counters, recommend a ruling. */
  negotiator: Negotiator
}
