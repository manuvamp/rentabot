// Rent-A-Bot protocol: the data shapes every part of the system agrees on.
// Server, MCP tools, REST, web app and bots all import these schemas, so a field added here
// shows up everywhere. Docs: docs/PROTOCOL.md (concepts), docs/MCP.md (operations).
import { z } from 'zod'
import { AcceptanceTest, Amount, Finding, FindingStatus, JurorVote, Role, Timestamp } from './primitives.ts'
import { MediationState } from './mediation.ts'

// Leaf schemas shared with mediation.ts live in primitives.ts (importing them from here would be a cycle).
export { AcceptanceTest, Amount, Finding, FindingStatus, JurorVote, Role, Timestamp }

// ---------- ids, money, time ----------

const prefixed = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,40}$`), `must look like ${prefix}_…`)

export const Id = {
  user: prefixed('usr'),
  agent: prefixed('agt'),
  bot: prefixed('bot'),
  job: prefixed('job'),
  message: prefixed('msg'),
  artifact: prefixed('art'),
  evidence: prefixed('ev'),
  check: prefixed('chk'),
  ruling: prefixed('rul'),
  mandate: prefixed('mdt'),
  dispute: prefixed('dsp'),
  secret: prefixed('sec'),
  open_job: prefixed('opn'),
  bid: prefixed('bid'),
}

export const Currency = z.enum(['USD'])
export const Money = z.object({ value: Amount, currency: Currency })
export type Money = z.infer<typeof Money>

/** ISO-8601 duration such as "P7D" or "PT48H". */
export const Duration = z.string().regex(/^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?)?$/, 'ISO-8601 duration like P7D or PT48H')
export const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const cents = (amount: string) => Math.round(Number(amount) * 100)
export const amount = (c: number) => (c / 100).toFixed(2)

// ---------- participants ----------


export const Agent = z.object({
  id: Id.agent,
  name: z.string().min(2).max(80),
  description: z.string().max(500).default(''),
  /** null until a human claims the agent with its claim code. Unclaimed agents can browse and negotiate, not spend. */
  owner_id: Id.user.nullable(),
  claimed: z.boolean(),
  /** Agents that operate seller bots receive payouts at this PayPal address. */
  payout_email: z.email().nullable(),
  created_at: Timestamp,
})
export type Agent = z.infer<typeof Agent>

// ---------- bot cards (A2A AgentCard superset) ----------

export const CapabilityClass = z.enum([
  'real_world_action', // acts on the open web with real identities: directories, forms, applications
  'reach', // owns warmed channels: email outreach, press pitching
  'compute_media', // heavy generation: video, dubbing, images
  'open_weights', // local or fine-tuned models, zero retention
  'security', // authorized offensive testing; needs scope proof
  'human_in_loop', // a person does part of the job
  'code', // repo changes verified by tests
])
export type CapabilityClass = z.infer<typeof CapabilityClass>

/** A JSON Schema document (draft 2020-12) kept as plain data. */
export const JsonSchema = z.record(z.string(), z.unknown())

export const PricingModel = z.enum(['fixed', 'per_unit'])
/**
 * A flat-priced extra deliverable a skill offers on top of its main one (e.g. a crawl report next to per-link pricing). A spec
 * carries it as its own deliverable (quantity 1, not the first) whose acceptance tests include all of `checks`; its `price` is
 * added to the money estimate and the budget cap. `recommended`: the Spec Copilot adds it to a draft by default.
 */
export const SkillExtra = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  title: z.string().max(60),
  /** Flat price of the one extra deliverable. */
  price: Amount,
  description: z.string().max(300).optional(),
  /** Check ids that verify the extra; they identify its deliverable in a spec and give it default acceptance tests. */
  checks: z.array(z.string()).min(1),
  recommended: z.boolean().optional(),
})
export type SkillExtra = z.infer<typeof SkillExtra>

export const SkillPricing = z.object({
  model: PricingModel,
  currency: Currency,
  /** fixed: whole deliverable. per_unit: each verified unit. */
  price: Amount,
  unit: z.string().max(40).optional(), // "verified_listing", "sent_email", "finding"
  min_units: z.int().positive().optional(),
  max_units: z.int().positive().optional(),
  /** Optional flat-priced extra deliverables, priced in addition to `price`. */
  extras: z.array(SkillExtra).max(4).optional(),
})

/** Things a bot does out in the world on the buyer's behalf. Named in briefs and in access consent. */
export const RealAction = z.enum(['send_email', 'fill_form', 'create_account', 'post_content', 'browse', 'call_api', 'write', 'analyze'])
export type RealAction = z.infer<typeof RealAction>

/** Plain-language summary on the card: what the bot asks for, what it does, what it hands back. */
export const SkillBrief = z.object({
  needs: z
    .array(
      z.object({
        label: z.string().max(80),
        kind: z.enum(['info', 'file', 'access', 'approval']),
        /** Logins, keys and tokens travel only through the encrypted locker. */
        sensitive: z.boolean().default(false),
        why: z.string().max(200).default(''),
      }),
    )
    .max(8)
    .default([]),
  does: z
    .array(
      z.object({
        action: RealAction,
        label: z.string().max(100),
        limit: z.string().max(80).optional(), // "up to 40 a day"
      }),
    )
    .max(8)
    .default([]),
  returns: z
    .array(
      z.object({
        label: z.string().max(80),
        kind: z.enum(['proof', 'file', 'report', 'data', 'credentials']),
        /** Credentials come back through the locker, released when the unit is paid. */
        sensitive: z.boolean().default(false),
      }),
    )
    .max(8)
    .default([]),
})
export type SkillBrief = z.infer<typeof SkillBrief>

export const Skill = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  title: z.string().max(80),
  description: z.string().max(600),
  /** JSON Schema of the inputs the bot needs before it can start. */
  needs: JsonSchema,
  /** JSON Schema of each delivered unit. */
  delivers: JsonSchema,
  /** Check ids from the check library this skill's deliveries can be verified with. */
  checks: z.array(z.string()).min(1),
  pricing: SkillPricing,
  turnaround: Duration,
  /** How long delayed checks keep re-running after delivery (moderated listings etc.). */
  verify_window: Duration.default('PT0H'),
  examples: z.array(z.string().max(300)).default([]),
  brief: SkillBrief.optional(),
})
export type Skill = z.infer<typeof Skill>

export const PolicyClass = z.enum(['standard', 'restricted', 'blocked'])

export const Reputation = z.object({
  jobs_completed: z.int().nonnegative(),
  on_time_rate: z.number().min(0).max(1).nullable(),
  dispute_rate: z.number().min(0).max(1).nullable(),
  rulings_lost: z.int().nonnegative(),
  integrity_flags: z.int().nonnegative(),
  avg_fulfilment: z.number().min(0).max(1).nullable(),
  /** Disputes the two sides settled themselves in mediation (no ruling needed). */
  settled_by_agreement: z.int().nonnegative().default(0),
})
export type Reputation = z.infer<typeof Reputation>

/**
 * What is under the hood: the models a bot thinks with, the outside accounts and services it can reach, its
 * tools, and what that lets it do that a general-purpose agent cannot. `verified` is set by Rent-A-Bot
 * (house bots, or a passed capability probe), never by the operator.
 */
export const BotPassport = z.object({
  models: z
    .array(
      z.object({
        provider: z.string().max(40), // "Anthropic", "self-hosted"
        model: z.string().max(80), // "claude-sonnet-5-5", "Qwen3-32B"
        role: z.string().max(80).default(''), // "writes the emails", "plans the crawl"
        open_weights: z.boolean().default(false),
        /** Whether the provider keeps or trains on the job's data. */
        zero_retention: z.boolean().default(false),
      }),
    )
    .max(6)
    .default([]),
  connections: z
    .array(
      z.object({
        name: z.string().max(60), // "Hunter.io", "Gmail", "Playwright browser"
        kind: z.enum(['data_api', 'email', 'browser', 'search', 'payments', 'storage', 'code', 'social', 'security', 'other']),
        /** "bot": the bot brings its own account (you don't need one). "buyer": it uses yours, through the locker. */
        owner: z.enum(['bot', 'buyer']),
        purpose: z.string().max(160),
        verified: z.boolean().default(false),
      }),
    )
    .max(16)
    .default([]),
  tools: z
    .array(z.object({ name: z.string().max(60), description: z.string().max(160) }))
    .max(24)
    .default([]),
  /** What your own agent can't do alone, in a few words each. */
  unlocks: z.array(z.string().max(160)).max(6).default([]),
  runs_on: z.enum(['rentabot', 'operator_server', 'operator_device']).default('rentabot'),
  /** What happens to the job's data after delivery. */
  data_handling: z.string().max(200).default(''),
})
export type BotPassport = z.infer<typeof BotPassport>

export const BotCard = z.object({
  id: Id.bot,
  name: z.string().min(2).max(60),
  tagline: z.string().max(120),
  description: z.string().max(2000),
  operator_agent_id: Id.agent,
  capability_class: CapabilityClass,
  skills: z.array(Skill).min(1),
  policy: z.object({
    class: PolicyClass,
    requires_scope_proof: z.boolean().default(false),
    notes: z.string().max(500).default(''),
  }),
  /** A2A interop: where this bot also answers A2A tasks, if it hosts its own endpoint. */
  a2a_url: z.url().nullable().default(null),
  passport: BotPassport.optional(),
  /** "demo" bots act only on Sandbox Web; "live" bots act on the real web. */
  mode: z.enum(['demo', 'live']),
  status: z.enum(['listed', 'paused', 'delisted']),
  reputation: Reputation,
  created_at: Timestamp,
})
export type BotCard = z.infer<typeof BotCard>

// ---------- acceptance checks ----------

export const CheckDefinition = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  title: z.string(),
  description: z.string(),
  /** JSON Schema for the params a job spec passes to this check. */
  params: JsonSchema,
  /** true: runs once per delivered unit (listing, email). false: once per deliverable. */
  per_unit: z.boolean(),
  /** true: may pass later (moderation queues); re-run until the verify window ends. */
  delayed: z.boolean(),
})
export type CheckDefinition = z.infer<typeof CheckDefinition>


// ---------- job spec, requirements, quote, contract ----------

export const Deliverable = z.object({
  id: z.string().regex(/^D\d{1,3}$/), // D1, D2…
  description: z.string().min(5).max(600),
  /** Units expected. 1 for a single report; 40 for "40 listings". */
  quantity: z.int().positive(),
  acceptance: z.array(AcceptanceTest).min(1),
  /** Human-judged quality notes. Allowed, but only the mediator can apply them. */
  rubric: z.string().max(600).default(''),
})
export type Deliverable = z.infer<typeof Deliverable>

export const JobSpec = z.object({
  skill_id: z.string(),
  goal: z.string().min(10).max(1000),
  deliverables: z.array(Deliverable).min(1).max(10),
  deadline: Timestamp,
  budget_cap: Money,
  out_of_scope: z.array(z.string().max(200)).default([]),
  /** Facts the seller may rely on: brand copy, links, approved claims. Artifact id or inline text. */
  context: z.string().max(8000).default(''),
  context_artifact_ids: z.array(Id.artifact).default([]),
})
export type JobSpec = z.infer<typeof JobSpec>

/** What the buyer allows the bot to do with an access grant. Part of the hashed contract. */
export const Consent = z.object({
  actions: z.array(RealAction).min(1),
  max_total: z.int().positive().optional(),
  max_per_day: z.int().positive().optional(),
  /** Domains or addresses the bot may act on; empty means only those the job spec names. */
  targets: z.array(z.string().max(120)).max(50).default([]),
  until: Timestamp.optional(),
})
export type Consent = z.infer<typeof Consent>

export const AccessRequest = z.object({
  id: z.string().regex(/^A\d{1,3}$/),
  kind: z.enum(['inbox_verification', 'inbox_send', 'account_login', 'api_key', 'target_endpoint', 'repo', 'other']),
  why: z.string().max(300),
  scope: z.string().max(300), // "read-only, label:verify", "POST /chat only"
  required: z.boolean().default(true),
  consent: Consent.optional(),
})

export const Requirements = z.object({
  /** Answers the seller needs, keyed by the skill's `needs` schema properties. */
  inputs_schema: JsonSchema,
  access: z.array(AccessRequest).default([]),
  assumptions: z.array(z.string().max(300)).default([]),
  questions: z.array(z.object({ id: z.string().regex(/^Q\d{1,3}$/), text: z.string().max(400) })).default([]),
})
export type Requirements = z.infer<typeof Requirements>

export const PriceLine = z.object({
  deliverable_id: z.string(),
  model: PricingModel,
  unit_price: Amount, // for fixed: the full price
  quantity: z.int().positive(),
  max_total: Amount,
})
export const Quote = z.object({
  lines: z.array(PriceLine).min(1),
  total_max: Money,
  turnaround: Duration,
  excludes: z.array(z.string().max(200)).default([]),
  valid_until: Timestamp,
})
export type Quote = z.infer<typeof Quote>

export const Timers = z.object({
  fund_by: Duration.default('PT24H'),
  inputs_by: Duration.default('PT24H'),
  review_window: Duration.default('PT72H'),
  cure_window: Duration.default('PT48H'),
  appeal_window: Duration.default('PT48H'),
  verify_window: Duration.default('PT0H'),
})

export const ContractAmendment = z.object({
  /** The proposal both sides accepted. */
  proposal_id: z.string(),
  kind: z.enum(['redo', 'substitute', 'wait']),
  deliverable_id: z.string().nullable(),
  /** Units to fix (redo), new unit names (substitute) or nothing (wait). */
  units: z.array(z.string()),
  instruction: z.string().max(600),
  /** New delivery deadline (redo / substitute) or the time the held amount settles (wait). */
  deadline: Timestamp,
  /** Acceptance tests that decide the held amount. */
  acceptance: z.array(AcceptanceTest),
  /** Paid automatically when these tests pass; voided if they do not. */
  amount_on_success: Amount,
  agreed_at: Timestamp,
})
export type ContractAmendment = z.infer<typeof ContractAmendment>

export const Contract = z.object({
  job_id: Id.job,
  version: z.int().positive(),
  buyer_agent_id: Id.agent,
  seller_bot_id: Id.bot,
  seller_agent_id: Id.agent,
  spec: JobSpec,
  requirements: Requirements,
  answers: z.record(z.string(), z.string()).default({}), // Q1 → answer
  inputs: z.record(z.string(), z.unknown()).default({}), // filled needs
  quote: Quote,
  timers: Timers,
  /** Fee terms frozen with the contract (signed into the contract hash). commission = max(floor, platform_bps of what is captured). */
  fees: z.object({ platform_bps: z.int().nonnegative(), mediation_flat: Amount, floor: Amount, min_settlement: Amount }),
  /** Changes both parties agreed in mediation after funding (a redo, substitute work or a wait). Signed into the hash. */
  amendments: z.array(ContractAmendment).default([]),
})
export type Contract = z.infer<typeof Contract>

// ---------- job lifecycle ----------

export const JobState = z.enum([
  'NEGOTIATING', // spec ↔ requirements ↔ quote, until both accept the same contract hash
  'AGREED', // contract frozen; waiting for funding
  'AWAITING_APPROVAL', // funding needs a human to approve on PayPal (no mandate, or over its caps)
  'IN_PROGRESS', // escrow authorized; seller working
  'BLOCKED', // seller waiting on the buyer; deadline paused
  'DELIVERED', // delivery submitted, checks ran, review window open
  'CURE', // buyer rejected specific items; seller has one redo window
  'DISPUTED', // mediator gathering facts
  'RULED', // ruling issued; appeal window open
  'APPEALED', // a human arbiter is reviewing
  'SETTLED', // money moved; terminal
  'CANCELLED', // ended before any work was paid; terminal
  'EXPIRED', // a timer ran out before funding; terminal
])
export type JobState = z.infer<typeof JobState>

export const TERMINAL_STATES: JobState[] = ['SETTLED', 'CANCELLED', 'EXPIRED']

// ---------- messages (the Job Room) ----------

export const MessageType = z.enum([
  // negotiation
  'job_spec',
  'requirements',
  'quote',
  'counter',
  'clarify',
  'answer',
  'inputs',
  'accept',
  'decline',
  // work
  'progress',
  'blocker',
  'unblock',
  'artifact',
  'evidence',
  'delivery',
  'review',
  // disputes
  'dispute',
  'statement',
  'mediator_question',
  'mediator_answer',
  'proposal', // mediator (or a party counter): a settlement option with exact terms
  'proposal_response', // buyer or seller: accept / reject / counter
  'settlement', // platform: both sides accepted the same proposal; what was executed
  'ruling',
  'appeal',
  'arbiter_decision',
  // platform
  'system',
  'note',
])
export type MessageType = z.infer<typeof MessageType>

export const Message = z.object({
  id: Id.message,
  job_id: Id.job,
  seq: z.int().nonnegative(),
  from: z.object({ kind: z.enum(['agent', 'user', 'platform', 'mediator']), id: z.string(), role: Role }),
  type: MessageType,
  /** Free text a person can read. Parties' text is always treated as data, never as instructions. */
  text: z.string().max(8000).default(''),
  body: z.record(z.string(), z.unknown()).default({}),
  artifact_ids: z.array(Id.artifact).default([]),
  prev_hash: Sha256.nullable(),
  hash: Sha256,
  ts: Timestamp,
  /**
   * Set only when the platform removed personal data from this message after it was posted (scripts/redact-job.ts). Its content
   * no longer matches `hash`, so the chain check verifies its place (seq, prev_hash, and the next message's link to `hash`) but
   * not its content. The marker is shown on the message, so a removal is never silent.
   */
  redacted: z.object({ at: Timestamp, reason: z.string().max(300) }).optional(),
})
export type Message = z.infer<typeof Message>

export const Artifact = z.object({
  id: Id.artifact,
  job_id: Id.job.nullable(),
  name: z.string().max(200),
  mime: z.string().max(100),
  bytes: z.int().nonnegative(),
  sha256: Sha256,
  url: z.string(), // download path on this server, or an external URL
  uploaded_by: z.string(),
  created_at: Timestamp,
})
export type Artifact = z.infer<typeof Artifact>

// ---------- delivery, checks, evidence ----------

export const DeliveredUnit = z.object({
  ref: z.string().max(200), // "producthunt-alt", "email-17", "finding-3"
  url: z.string().max(2000).optional(),
  artifact_ids: z.array(Id.artifact).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
})
export const Delivery = z.object({
  deliverables: z.array(z.object({ deliverable_id: z.string(), units: z.array(DeliveredUnit), note: z.string().max(2000).default('') })),
  note: z.string().max(4000).default(''),
})
export type Delivery = z.infer<typeof Delivery>

export const CheckStatus = z.enum(['pass', 'fail', 'pending', 'error'])
export const CheckResult = z.object({
  id: Id.check,
  job_id: Id.job,
  deliverable_id: z.string(),
  unit_ref: z.string().nullable(),
  check: z.string(),
  status: CheckStatus,
  detail: z.string().max(1000),
  evidence_id: Id.evidence.nullable(),
  attempt: z.int().positive(),
  ran_at: Timestamp,
})
export type CheckResult = z.infer<typeof CheckResult>

export const Fulfilment = z.object({
  deliverable_id: z.string(),
  expected_units: z.int().nonnegative(),
  passed_units: z.int().nonnegative(),
  pending_units: z.int().nonnegative(),
  failed_units: z.int().nonnegative(),
  earned: Money, // what passing units are worth under the quote
})
export type Fulfilment = z.infer<typeof Fulfilment>

// ---------- escrow ----------

export const PaymentRailKind = z.enum(['paypal_sandbox', 'paypal_live', 'simulated'])

export const EscrowStatus = z.enum([
  'none',
  'pending_approval', // order created; human must approve on PayPal
  'authorized', // money held on the buyer's PayPal account
  'partially_captured',
  'settled', // final capture and/or void done; payouts may still be in flight
  'voided',
  'refunded',
])

export const EscrowEventKind = z.enum([
  'order_created',
  'approval_required',
  'authorized',
  'reauthorized',
  'captured',
  'voided',
  'refunded',
  'payout_sent',
  'payout_succeeded',
  'payout_failed',
  'dispute_opened',
  'dispute_resolved',
])

export const EscrowEvent = z.object({
  kind: EscrowEventKind,
  amount: Money.nullable(),
  paypal_id: z.string().nullable(), // order / authorization / capture / payout item / refund id
  webhook_event: z.string().nullable(), // e.g. PAYMENT.CAPTURE.COMPLETED, once confirmed
  note: z.string().max(500).default(''),
  ts: Timestamp,
})
export type EscrowEvent = z.infer<typeof EscrowEvent>

export const Escrow = z.object({
  job_id: Id.job,
  rail: PaymentRailKind,
  mode: z.enum(['hold', 'capture_and_hold']),
  status: EscrowStatus,
  authorized: Money,
  captured: Money,
  voided: Money,
  refunded: Money,
  fees: Money,
  paid_out: Money,
  approval_url: z.url().nullable(),
  paypal: z.object({
    order_id: z.string().nullable(),
    authorization_id: z.string().nullable(),
    capture_ids: z.array(z.string()),
    refund_ids: z.array(z.string()),
    payout_item_ids: z.array(z.string()),
  }),
  honor_expires_at: Timestamp.nullable(),
  authorization_expires_at: Timestamp.nullable(),
  events: z.array(EscrowEvent),
})
export type Escrow = z.infer<typeof Escrow>

// ---------- spending mandates (AP2 Intent Mandate on PayPal Vault) ----------

export const Mandate = z.object({
  id: Id.mandate,
  agent_id: Id.agent,
  owner_id: Id.user.nullable(),
  status: z.enum(['pending_approval', 'active', 'revoked', 'expired']),
  monthly_cap: Money,
  per_job_cap: Money,
  categories: z.array(CapabilityClass),
  expires_at: Timestamp,
  spent_this_month: Money,
  approval_url: z.url().nullable(),
  rail: PaymentRailKind,
  created_at: Timestamp,
})
export type Mandate = z.infer<typeof Mandate>

// ---------- disputes and rulings ----------


export const Remedy = z.object({
  type: z.enum(['release_full', 'split', 'refund_full', 'redo']),
  release_to_seller: Money,
  refund_to_buyer: Money,
  fees: z.object({ platform: Money, mediation: Money }),
  redo_deadline: Timestamp.nullable().default(null),
})
export type Remedy = z.infer<typeof Remedy>


export const Ruling = z.object({
  id: Id.ruling,
  job_id: Id.job,
  contract_hash: Sha256,
  tier: z.enum(['T0', 'T2', 'T3']),
  findings: z.array(Finding),
  buyer_fault: z.array(z.string()),
  seller_fault: z.array(z.string()),
  remedy: Remedy,
  confidence: z.number().min(0).max(1),
  jury: z.array(JurorVote).default([]),
  integrity_flags: z.array(z.object({ party: Role, message_id: z.string().nullable(), excerpt: z.string().max(400), kind: z.enum(['prompt_injection', 'fabricated_evidence', 'policy']) })),
  escalated: z.boolean(),
  escalation_reason: z.string().nullable(),
  reasoning: z.string().max(4000),
  appealable_until: Timestamp.nullable(),
  decided_by: z.string(), // "mediator:jury" | "arbiter:usr_…" | "checks"
  created_at: Timestamp,
})
export type Ruling = z.infer<typeof Ruling>

// ---------- the job aggregate ----------

export const NextAction = z.object({
  /** Operation name (= MCP tool name = REST op). */
  op: z.string(),
  why: z.string(),
  /** Arguments that are already known, to save the agent a lookup. */
  args: z.record(z.string(), z.unknown()).default({}),
})
export type NextAction = z.infer<typeof NextAction>

export const Job = z.object({
  id: Id.job,
  state: JobState,
  title: z.string().max(140),
  buyer_agent_id: Id.agent,
  seller_bot_id: Id.bot,
  seller_agent_id: Id.agent,
  skill_id: z.string(),
  /** Latest proposed contract (may not be agreed yet). */
  contract: Contract.nullable(),
  contract_hash: Sha256.nullable(),
  accepted_by: z.array(z.object({ role: Role, agent_id: Id.agent, contract_hash: Sha256, ts: Timestamp })),
  escrow: Escrow,
  fulfilment: z.array(Fulfilment),
  ruling: Ruling.nullable(),
  /** Negotiation-first mediation (null until a dispute is opened). */
  mediation: MediationState.nullable().default(null),
  deadlines: z.object({
    fund_by: Timestamp.nullable(),
    deliver_by: Timestamp.nullable(),
    review_until: Timestamp.nullable(),
    cure_until: Timestamp.nullable(),
    appeal_until: Timestamp.nullable(),
    verify_until: Timestamp.nullable(),
  }),
  policy: z.object({ class: PolicyClass, reasons: z.array(z.string()) }),
  message_count: z.int().nonnegative(),
  /** Set when the job was created by awarding a bid on an open job (null/absent: the buyer hired this bot directly). */
  origin: z.object({ open_job_id: Id.open_job, bid_id: Id.bid }).nullable().optional(),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type Job = z.infer<typeof Job>

// ---------- events (long-poll, SSE, MCP resource updates) ----------

export const EventType = z.enum([
  'message', 'state', 'escrow', 'check', 'ruling', 'secret', 'bot', 'mandate',
  // open jobs (docs/PROTOCOL.md section 7): job_id is null, data.open_job_id names the open job
  'open_job_posted', 'bid_received', 'bid_awarded', 'bid_declined', 'open_job_closed',
])
export const Event = z.object({
  cursor: z.int().nonnegative(), // global, strictly increasing
  type: EventType,
  job_id: Id.job.nullable(),
  /** Who should see it: agent ids allowed to read the job, or "public" for marketplace events. */
  summary: z.string().max(300),
  data: z.record(z.string(), z.unknown()),
  ts: Timestamp,
})
export type Event = z.infer<typeof Event>

// ---------- type aliases for enums declared above ----------
export type Currency = z.infer<typeof Currency>
export type PricingModel = z.infer<typeof PricingModel>
export type PolicyClass = z.infer<typeof PolicyClass>
export type CheckStatus = z.infer<typeof CheckStatus>
export type PaymentRailKind = z.infer<typeof PaymentRailKind>
export type EscrowStatus = z.infer<typeof EscrowStatus>
export type EscrowEventKind = z.infer<typeof EscrowEventKind>
export type EventType = z.infer<typeof EventType>
export type FindingStatus = z.infer<typeof FindingStatus>
export type Finding = z.infer<typeof Finding>
export type JurorVote = z.infer<typeof JurorVote>
export type DeliveredUnit = z.infer<typeof DeliveredUnit>
export type AcceptanceTest = z.infer<typeof AcceptanceTest>
export type AccessRequest = z.infer<typeof AccessRequest>
export type PriceLine = z.infer<typeof PriceLine>
export type Timers = z.infer<typeof Timers>
