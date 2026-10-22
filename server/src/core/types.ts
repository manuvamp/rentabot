// The seam between the domain core (store, state machine, escrow, checks, mediator) and the
// adapters that expose it (MCP server, REST, SSE, discovery docs, web app).
// The core implements `Core`; adapters only ever talk to a `Core`. Tests can pass a stub.
import type { Agent, Event, EventType, OpErrorBody, OpInput, OpName, OpOutput, NextAction } from '@rentabot/shared'
import type { ChatRequest, ChatResult } from '../intelligence/ai/provider.ts'

// ---------- who is calling ----------

export type Principal =
  | { kind: 'agent'; agent_id: string; owner_id: string | null }
  /** A signed-in person. `act_as` is the agent they operate through (their personal web agent by default). */
  | { kind: 'user'; user_id: string; name: string; roles: ('owner' | 'arbiter')[]; act_as: string }
  | { kind: 'public' }

export interface OpContext {
  principal: Principal
  surface: 'mcp' | 'rest'
  request_id: string
}

// ---------- operations ----------

export type Handler<N extends OpName> = (ctx: OpContext, input: OpOutputInput<N>) => Promise<OpOutput<N>>
/** Handlers receive the input after zod parsing (defaults applied). */
export type OpOutputInput<N extends OpName> = import('zod').output<Extract<(typeof import('@rentabot/shared').OPS)[number], { name: N }>['input']>
export type Handlers = { [N in OpName]: Handler<N> }

/** Thrown by handlers; adapters turn it into an MCP tool error or an HTTP error with the same body. */
export class OpError extends Error {
  readonly code: OpErrorBody['error']['code']
  readonly hint: string
  readonly next_actions: NextAction[]
  readonly status: number
  constructor(code: OpErrorBody['error']['code'], message: string, hint: string, next_actions: NextAction[] = []) {
    super(message)
    this.code = code
    this.hint = hint
    this.next_actions = next_actions
    this.status = STATUS[code] ?? 500
  }
  toBody(): OpErrorBody {
    return { error: { code: this.code, message: this.message, hint: this.hint, next_actions: this.next_actions } }
  }
}

const STATUS: Record<OpErrorBody['error']['code'], number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  invalid_state: 409,
  stale_contract: 409,
  policy_blocked: 422,
  mandate_required: 402,
  mandate_exceeded: 402,
  payment_failed: 502,
  rate_limited: 429,
  internal: 500,
}

// ---------- the core ----------

export interface EventFilter {
  /** Only events visible to this principal (jobs they are party to, their bots' incoming jobs, public events). */
  principal: Principal
  after_cursor: number
  job_id?: string
  types?: EventType[]
}

export interface PublicStats {
  bots_listed: number
  jobs_total: number
  jobs_settled: number
  units_verified: number // sum of passed check units across all jobs
  held_now: string // USD decimal currently authorized in escrow
  released_total: string
  voided_total: string
  disputes_total: number
  median_dispute_minutes: number | null
  payment_rail: 'paypal_sandbox' | 'paypal_live' | 'simulated'
}

/** Anonymized activity for the landing page ticker. */
export interface FeedItem {
  ts: string
  kind: 'job_opened' | 'contract_signed' | 'escrow_authorized' | 'units_verified' | 'captured' | 'voided' | 'ruling' | 'bot_listed' | 'open_job'
  text: string // "Directory Blaster: 31/40 listings verified, $46.50 captured"
  amount: string | null
}

/** What the stand-in PayPal approval page shows (simulated rail only). */
export interface SimApprovalInfo {
  kind: 'order' | 'vault'
  id: string
  title: string
  amount: string
  currency: 'USD'
  job_id?: string
  lines: { label: string; value: string }[]
  return_to: string
}

/** GET /api/session: who is signed in and the agents they own. `user` is null for an API-key caller. */
export interface SessionInfo {
  user: { id: string; name: string; role: 'owner' | 'arbiter' | 'seller'; email?: string } | null
  agents: Agent[]
}

export interface Core {
  readonly handlers: Handlers
  readonly config: { publicUrl: string; paymentRail: PublicStats['payment_rail']; aiProvider: string; demoMode: boolean }

  auth: {
    /** Resolve a Bearer API key (agents). Returns null when unknown or revoked. */
    agentFromApiKey(apiKey: string): Promise<Extract<Principal, { kind: 'agent' }> | null>
    /** Resolve a session token (people). */
    userFromSession(token: string): Promise<Extract<Principal, { kind: 'user' }> | null>
    /** Demo sign-in for judges: returns a session token for a seeded persona. */
    demoSignIn(persona: 'owner' | 'arbiter' | 'seller'): Promise<{ token: string; principal: Extract<Principal, { kind: 'user' }> }>
    /** The caller as the web app wants it: the signed-in person (with their demo role) and the agents they own. */
    session(principal: Principal): Promise<SessionInfo>
  }

  /** People's accounts: Log in with PayPal, /account data, agent keys. Optional so stub cores can omit it. */
  accounts?: import('./accounts.ts').AccountsApi

  events: {
    /** Events after a cursor that the principal may see, without waiting. */
    list(filter: EventFilter, limit?: number): Promise<{ events: Event[]; cursor: number }>
    /** Resolve as soon as a matching event exists, or after timeoutMs with an empty list. */
    wait(filter: EventFilter, timeoutMs: number, signal?: AbortSignal): Promise<{ events: Event[]; cursor: number; timed_out: boolean }>
    /** Push subscription (SSE, MCP resource updates). Returns an unsubscribe function. */
    subscribe(filter: Omit<EventFilter, 'after_cursor'>, onEvent: (e: Event) => void): () => void
    latestCursor(): number
  }

  payments: {
    /** PayPal webhook receiver: verifies the signature, applies the event, returns 200-worthy result. */
    handleWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ accepted: boolean; event_type: string | null; note: string }>
    /** Buyer came back from PayPal approval for a job's order. Returns where to send the browser. */
    onOrderReturn(query: Record<string, string>): Promise<{ redirect: string }>
    /** Owner came back from approving a Vault setup token for a mandate. */
    onVaultReturn(query: Record<string, string>): Promise<{ redirect: string }>
    /** Simulated rail only: the stand-in PayPal approval page posts here. */
    simulatedApprove?(kind: 'order' | 'vault', id: string, approve: boolean): Promise<{ redirect: string }>
    /** Simulated rail only: what the stand-in approval page shows for an order or a vault setup token; null when unknown. */
    simulatedInfo?(kind: 'order' | 'vault', id: string): Promise<SimApprovalInfo | null>
  }

  artifacts: {
    /** Bytes of an artifact the principal may read (the uploader, a party of a job it belongs to, an arbiter); null otherwise, same as unknown. */
    read(id: string, principal: Principal): Promise<{ mime: string; name: string; bytes: Uint8Array } | null>
  }

  public: {
    stats(): Promise<PublicStats>
    feed(limit?: number): Promise<FeedItem[]>
  }

  demo?: {
    /** Wipe and re-seed demo data. */
    reset(): Promise<void>
  }

  /** The tool-calling model behind the AG Studio analyst (POST /api/analyst/turn). Absent when the AI client cannot chat. */
  analyst?: {
    enabled: boolean
    chat(req: ChatRequest): Promise<ChatResult>
  }

  close(): Promise<void>
}

export type { OpName, OpInput, OpOutput }
