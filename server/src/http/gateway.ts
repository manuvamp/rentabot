// The gateway: the one place an operation call is authorised, rate-limited, validated and run.
// REST (POST /api/ops/:name) and MCP (tools/call) both go through `gateway.run`, so they behave the same.
import { OPS, type OpDef } from '@rentabot/shared'
import type { z } from 'zod'
import { OpError, type Core, type Principal } from '../core/types.ts'

export type AnyOp = OpDef
export const ALL_OPS: readonly AnyOp[] = OPS as unknown as readonly AnyOp[]
export const opsOn = (surface: 'mcp' | 'rest'): AnyOp[] => ALL_OPS.filter((o) => o.surfaces.includes(surface))
export const findOp = (name: string): AnyOp | undefined => ALL_OPS.find((o) => o.name === name)

export interface LogLike {
  error(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface RateLimitOptions {
  /** Bucket size for signed-in callers. */
  burst?: number
  /** Refill per second for signed-in callers. */
  perSecond?: number
  /** Same for anonymous callers (keyed by IP). */
  publicBurst?: number
  publicPerSecond?: number
}

export interface GatewayOptions {
  /** Make a handler output that does not match its declared schema a 500 (tests). Default: log loudly, still return it. */
  strictOutput?: boolean
  rateLimit?: RateLimitOptions | false
  log?: LogLike
}

export interface CallMeta {
  principal: Principal
  surface: 'mcp' | 'rest'
  requestId: string
  /** IP address, used to rate-limit anonymous callers. */
  ip?: string
}

/** Short, model-friendly summary of zod issues: `spec.deadline: Invalid ISO datetime; bot_id: must look like bot_…`. */
export function summarizeIssues(error: z.ZodError, max = 6): string {
  const parts = error.issues.slice(0, max).map((i) => {
    const path = i.path.length ? i.path.join('.') : '(input)'
    return `${path}: ${i.message}`
  })
  const more = error.issues.length > max ? ` (+${error.issues.length - max} more)` : ''
  return parts.join('; ') + more
}

function unauthenticated(surface: 'mcp' | 'rest', what: string): OpError {
  const hint =
    surface === 'mcp'
      ? 'Call register_agent (it needs no key); this session is upgraded to the new agent automatically. Or reconnect with the header "Authorization: Bearer <api key>".'
      : 'Send "Authorization: Bearer <api key>". No key yet? POST /api/ops/register_agent needs none and returns one.'
  return new OpError('unauthenticated', `${what} requires an authenticated caller.`, hint, [
    { op: 'register_agent', why: 'Create an agent identity and get an API key.', args: {} },
  ])
}

/** Coarse caller rules. Who-is-a-party checks (buyer vs seller of a job) belong to the core. */
export function checkCaller(op: AnyOp, principal: Principal, surface: 'mcp' | 'rest'): void {
  switch (op.caller) {
    case 'public':
      return
    case 'any':
    case 'buyer':
    case 'seller':
    case 'party':
      if (principal.kind === 'public') throw unauthenticated(surface, op.name)
      return
    case 'user':
      if (principal.kind === 'public') throw unauthenticated(surface, op.name)
      if (principal.kind !== 'user') throw new OpError('forbidden', `${op.name} is for signed-in people, not agents.`, 'A human must do this in the web app.')
      return
    case 'arbiter':
      if (principal.kind === 'public') throw unauthenticated(surface, op.name)
      if (principal.kind !== 'user' || !principal.roles.includes('arbiter'))
        throw new OpError('forbidden', `${op.name} is reserved for the human arbiter.`, 'Appeals are decided by a human in the Ops console.')
      return
  }
}

/** Anything that is not an OpError becomes a generic 500 that leaks nothing. */
export function toOpError(err: unknown, requestId: string): OpError {
  if (err instanceof OpError) return err
  return new OpError('internal', `Internal error (request ${requestId}).`, 'Retry once; if it keeps failing, report the request id to the operator.')
}

class TokenBuckets {
  private buckets = new Map<string, { tokens: number; ts: number }>()
  private lastSweep = Date.now()
  /** Returns 0 when allowed, else seconds to wait. */
  take(key: string, burst: number, perSecond: number): number {
    const now = Date.now()
    const b = this.buckets.get(key) ?? { tokens: burst, ts: now }
    b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * perSecond)
    b.ts = now
    let wait = 0
    if (b.tokens >= 1) b.tokens -= 1
    else wait = Math.ceil((1 - b.tokens) / perSecond)
    this.buckets.set(key, b)
    if (now - this.lastSweep > 60_000) this.sweep(now)
    return wait
  }
  private sweep(now: number) {
    this.lastSweep = now
    for (const [k, b] of this.buckets) if (now - b.ts > 120_000) this.buckets.delete(k)
  }
}

export function rateKey(principal: Principal, ip?: string): string {
  if (principal.kind === 'agent') return `agent:${principal.agent_id}`
  if (principal.kind === 'user') return `user:${principal.user_id}`
  return `ip:${ip ?? 'unknown'}`
}

export class Gateway {
  private buckets = new TokenBuckets()
  readonly core: Core
  readonly opts: GatewayOptions
  constructor(core: Core, opts: GatewayOptions = {}) {
    this.core = core
    this.opts = opts
  }

  /** Count one request against the caller's bucket; throws rate_limited. */
  limit(principal: Principal, ip?: string): void {
    const rl = this.opts.rateLimit
    if (rl === false) return
    const anon = principal.kind === 'public'
    const burst = anon ? (rl?.publicBurst ?? 60) : (rl?.burst ?? 120)
    const per = anon ? (rl?.publicPerSecond ?? 5) : (rl?.perSecond ?? 20)
    const wait = this.buckets.take(rateKey(principal, ip), burst, per)
    if (wait > 0) throw new OpError('rate_limited', 'Too many requests.', `Wait ${wait}s and retry. Prefer wait_for_events over polling.`)
  }

  /** Authorise, validate, run, check the output. Throws OpError (or an unknown error for the caller to map). */
  async run(op: AnyOp, rawInput: unknown, meta: CallMeta): Promise<unknown> {
    checkCaller(op, meta.principal, meta.surface)
    const parsed = op.input.safeParse(rawInput ?? {})
    if (!parsed.success) {
      throw new OpError('invalid_input', `Invalid input for ${op.name}.`, `${summarizeIssues(parsed.error)}. Schema: GET /api/meta/ops (or the tool's inputSchema).`)
    }
    const handler = (this.core.handlers as unknown as Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>)[op.name]
    if (!handler) throw new OpError('internal', `Operation ${op.name} is not implemented.`, 'Report this to the operator.')
    const out = await handler({ principal: meta.principal, surface: meta.surface, request_id: meta.requestId }, parsed.data)
    const check = op.output.safeParse(out)
    if (!check.success) {
      this.opts.log?.error({ op: op.name, request_id: meta.requestId, issues: summarizeIssues(check.error, 12) }, 'OUTPUT SCHEMA MISMATCH: handler output does not match the declared schema')
      if (this.opts.strictOutput) throw new OpError('internal', `Output of ${op.name} violates its schema.`, summarizeIssues(check.error, 12))
    }
    return out
  }
}
