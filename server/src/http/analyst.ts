// POST /api/analyst/turn: the one LLM route behind the AG Studio dashboard's agents (/ops/studio).
// The browser runs the agent loop (Studio's harness); each model turn comes here so the provider key never leaves the
// server. Same provider as the rest of the platform (Anthropic Messages in production, an OpenAI-compatible endpoint in
// dev) and the same monthly spend ledger and cap (AI_SPEND_CAP_USD) as the mediator.
//
// Guards, in order: signed-in person who may read the platform P&L (arbiter; owner persona in demo mode only), AI on,
// a per-person token bucket (a dashboard run is a handful of turns, a script is not), strict body shape and size limits,
// then the spend cap inside the provider call. Message content is never logged.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { canViewPlatformAnalytics } from '../core/analytics.ts'
import { OpError, type Core } from '../core/types.ts'
import { AiUnavailable } from '../intelligence/ai/provider.ts'
import { resolvePrincipal } from './auth.ts'

const Call = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(100), arguments: z.string().max(60_000) })
const Msg = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string().max(60_000) }),
  z.object({ role: z.literal('assistant'), text: z.string().max(60_000).optional(), tool_calls: z.array(Call).max(20).optional(), reasoning: z.string().max(200_000).nullable().optional() }),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().min(1).max(200), content: z.string().max(100_000) }),
])
export const TurnBody = z.object({
  system: z.string().max(100_000),
  messages: z.array(Msg).min(1).max(300),
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().max(10_000), parameters: z.record(z.string(), z.unknown()) })).max(40),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) })]).optional(),
})

/** Whole-request ceiling, a second guard behind the per-field limits. */
const MAX_CHARS = 600_000

export interface AnalystLimits {
  /** Turns a person may send in a burst. */
  burst: number
  /** Refill, turns per second. */
  perSecond: number
}
export const DEFAULT_ANALYST_LIMITS: AnalystLimits = { burst: 16, perSecond: 0.4 }

export function registerAnalyst(app: FastifyInstance, core: Core, limits: AnalystLimits | false = DEFAULT_ANALYST_LIMITS) {
  const buckets = new Map<string, { tokens: number; ts: number }>()
  const take = (key: string): number => {
    if (limits === false) return 0
    const now = Date.now()
    const b = buckets.get(key) ?? { tokens: limits.burst, ts: now }
    b.tokens = Math.min(limits.burst, b.tokens + ((now - b.ts) / 1000) * limits.perSecond)
    b.ts = now
    let wait = 0
    if (b.tokens >= 1) b.tokens -= 1
    else wait = Math.ceil((1 - b.tokens) / limits.perSecond)
    buckets.set(key, b)
    if (buckets.size > 500) for (const [k, v] of buckets) if (now - v.ts > 600_000) buckets.delete(k)
    return wait
  }

  app.post('/api/analyst/turn', async (req, reply) => {
    const principal = await resolvePrincipal(core, req.headers)
    if (principal.kind === 'public') throw new OpError('unauthenticated', 'The analyst is for signed-in people.', 'Sign in as the Arbiter in the Ops console.')
    const { user } = await core.auth.session(principal)
    if (principal.kind !== 'user' || !user || !canViewPlatformAnalytics(principal.roles, user.role, core.config.demoMode))
      throw new OpError('forbidden', 'The analyst reads the platform P&L, which is for the human arbiter (and the owner persona in demo mode).', 'Sign in as the Arbiter.')
    if (!core.analyst?.enabled || core.config.aiProvider === 'none') throw new OpError('invalid_state', 'AI is off on this server (AI_PROVIDER=none).', 'The dashboard still works; only the analyst chat is unavailable.')
    const wait = take(`user:${principal.user_id}`)
    if (wait > 0) throw new OpError('rate_limited', 'The analyst is being asked too fast.', `Wait ${wait}s and retry.`)

    const body = TurnBody.safeParse(req.body)
    if (!body.success) throw new OpError('invalid_input', 'The analyst turn is malformed.', body.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '))
    const size = JSON.stringify(body.data).length
    if (size > MAX_CHARS) throw new OpError('invalid_input', 'The conversation is too long for one turn.', 'Start a new conversation in the chat panel.')

    try {
      const out = await core.analyst.chat({ system: body.data.system, messages: body.data.messages, tools: body.data.tools, ...(body.data.tool_choice ? { tool_choice: body.data.tool_choice } : {}), maxTokens: 4000 })
      return reply.header('cache-control', 'no-store').send(out)
    } catch (e) {
      if (e instanceof AiUnavailable) throw new OpError('invalid_state', e.message, 'The monthly AI spend cap or the model endpoint stopped this turn; the dashboard still works.')
      req.log.error({ req_id: req.id, err: e instanceof Error ? e.message : String(e) }, 'analyst turn failed')
      throw new OpError('internal', 'The analyst could not answer.', 'Retry once; if it keeps failing, check the server log.')
    }
  })
}
