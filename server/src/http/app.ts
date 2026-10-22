// The Fastify app: REST ops, sessions, SSE, PayPal callbacks, public data, discovery files, /mcp, static web.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import { OpError, type Core, type Principal } from '../core/types.ts'
import { opCatalog, type CatalogEntry } from '../discovery/catalog.ts'
import { registerDiscovery } from '../discovery/index.ts'
import { SERVER_VERSION } from '../discovery/meta.ts'
import { mountMcp, type McpMountOptions } from '../mcp/server.ts'
import { registerAnalyst, type AnalystLimits } from './analyst.ts'
import { clearedSessionCookie, resolvePrincipal, sessionCookie } from './auth.ts'
import { Gateway, opsOn, toOpError, type RateLimitOptions } from './gateway.ts'
import { registerAccounts, type PayPalLoginOptions } from './paypal-login.ts'
import { registerSse } from './sse.ts'

export interface AppOptions {
  /** false silences logs (tests). Default: on, unless running under vitest. */
  logger?: boolean
  /** Treat a handler output that violates its schema as a 500 (tests). Default: log loudly and return it. */
  strictOutput?: boolean
  rateLimit?: RateLimitOptions | false
  /** Token bucket for POST /api/analyst/turn (tests). Default: 16 turns in a burst, one more every 2.5 s. */
  analystLimits?: AnalystLimits | false
  mcp?: McpMountOptions
  /** Folder with the built web app. Default: <repo>/web/dist (hosted only if it exists). */
  webDist?: string
  /** Extra origins allowed to send cookies (the web app in dev). */
  corsOrigins?: string[]
  sseHeartbeatMs?: number
  /** Log in with PayPal overrides (tests: a fake identity server). Default: from env, see config.ts. */
  paypalLogin?: PayPalLoginOptions
}

const BODY_LIMIT = 25 * 1024 * 1024 // upload_artifact allows ~14 MB of base64
const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|text\/plain|application\/(pdf|json))(;|$)/i

/** GET aliases: query strings are strings, so coerce them using the op's JSON Schema. */
function coerceQuery(op: CatalogEntry, query: Record<string, unknown>): Record<string, unknown> {
  const props = (op.input_schema.properties ?? {}) as Record<string, { type?: string }>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query)) {
    const type = props[k]?.type
    const s = Array.isArray(v) ? v : String(v)
    if (type === 'integer' || type === 'number') out[k] = s !== '' && !Number.isNaN(Number(s)) && !Array.isArray(s) ? Number(s) : v
    else if (type === 'boolean') out[k] = s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : v
    else if (type === 'array') out[k] = Array.isArray(v) ? v : String(v) === '' ? [] : String(v).split(',')
    else if (type === 'object') {
      try {
        out[k] = JSON.parse(String(v))
      } catch {
        out[k] = v
      }
    } else out[k] = v
  }
  return out
}

const flat = (q: unknown): Record<string, string> => Object.fromEntries(Object.entries((q ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]))

export async function buildApp(core: Core, opts: AppOptions = {}): Promise<FastifyInstance> {
  const logger =
    (opts.logger ?? !process.env.VITEST)
      ? {
          level: process.env.LOG_LEVEL ?? 'info',
          // Never log credentials: headers are not logged at all, and these paths are redacted as a second layer.
          redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', '*.api_key', '*.token', '*.value'],
          serializers: { req: (r: FastifyRequest) => ({ method: r.method, path: r.url.split('?')[0] }) },
        }
      : false

  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT,
    trustProxy: true,
    forceCloseConnections: true,
    genReqId: (req) => {
      const given = req.headers['x-request-id']
      return typeof given === 'string' && /^[\w.-]{6,64}$/.test(given) ? given : 'req_' + randomBytes(6).toString('hex')
    },
  })

  const gw = new Gateway(core, { ...(opts.strictOutput !== undefined && { strictOutput: opts.strictOutput }), ...(opts.rateLimit !== undefined && { rateLimit: opts.rateLimit }), log: app.log })
  const secure = core.config.publicUrl.startsWith('https:')
  const publicOrigin = (() => {
    try {
      return new URL(core.config.publicUrl).origin
    } catch {
      return ''
    }
  })()
  const credentialOrigins = new Set([publicOrigin, ...(opts.corsOrigins ?? []), ...(process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? [])].filter(Boolean))
  const isLocalDev = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)

  // ---------- request id, CORS (set on the raw response so it also covers hijacked MCP/SSE replies) ----------
  app.addHook('onRequest', async (req, reply) => {
    reply.raw.setHeader('x-request-id', req.id)
    const origin = req.headers.origin
    if (typeof origin === 'string') {
      const withCreds = credentialOrigins.has(origin) || isLocalDev(origin)
      reply.raw.setHeader('access-control-allow-origin', withCreds ? origin : '*')
      if (withCreds) reply.raw.setHeader('access-control-allow-credentials', 'true')
      reply.raw.setHeader('vary', 'Origin')
      reply.raw.setHeader('access-control-expose-headers', 'Mcp-Session-Id, X-Request-Id, Retry-After, WWW-Authenticate')
      if (req.method === 'OPTIONS') {
        reply.raw.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
        reply.raw.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Act-As, X-Api-Key, X-Request-Id')
        reply.raw.setHeader('access-control-max-age', '600')
        return reply.code(204).send()
      }
    }
  })

  // JSON bodies: empty body = {}, raw text kept for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as FastifyRequest & { rawBody?: string }).rawBody = body as string
    if (!body) return done(null, {})
    try {
      done(null, JSON.parse(body as string))
    } catch {
      done(Object.assign(new Error('Request body is not valid JSON.'), { statusCode: 400 }), undefined)
    }
  })

  const sendError = (reply: FastifyReply, err: OpError) => {
    if (err.code === 'rate_limited') reply.header('retry-after', /(\d+)s/.exec(err.hint)?.[1] ?? '1')
    if (err.code === 'unauthenticated') reply.header('www-authenticate', 'Bearer realm="rent-a-bot"')
    return reply.code(err.status).send(err.toBody())
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    if (error instanceof OpError) return sendError(reply, error)
    const status = error.statusCode ?? 500
    if (status === 413) return sendError(reply, new OpError('invalid_input', 'Request body too large.', 'Upload large files as smaller artifacts or by url.'))
    if (status >= 400 && status < 500) return sendError(reply, new OpError('invalid_input', error.message, 'Check the request: JSON body with content-type application/json, or the query string for GET.'))
    const oe = toOpError(error, req.id)
    req.log.error({ req_id: req.id, err: error.message }, 'unhandled error')
    return sendError(reply, oe)
  })

  const webDist = opts.webDist ?? process.env.WEB_DIST ?? join(import.meta.dirname, '..', '..', '..', 'web', 'dist')
  const hasWeb = existsSync(join(webDist, 'index.html'))

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!
    const apiish = /^\/(api|mcp|\.well-known)(\/|$)/.test(path)
    if (hasWeb && !apiish && (req.method === 'GET' || req.method === 'HEAD') && !/\.[a-z0-9]{2,5}$/i.test(path)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html')
    }
    return sendError(reply, new OpError('not_found', `No such route: ${req.method} ${path}`, 'GET /api/meta/ops lists operations; GET /llms.txt explains the API.'))
  })

  // ---------- operations ----------
  const catalog = new Map(opCatalog().map((c) => [c.name, c]))
  const restOps = new Map(opsOn('rest').map((o) => [o.name, o]))

  /** Public ops ignore a stale key so a self-onboarding agent is never blocked by an old credential. */
  async function principalFor(req: FastifyRequest, publicOp: boolean): Promise<Principal> {
    try {
      return await resolvePrincipal(core, req.headers)
    } catch (e) {
      if (publicOp) return { kind: 'public' }
      throw e
    }
  }

  async function runRest(req: FastifyRequest, reply: FastifyReply, name: string, rawInput: unknown) {
    const op = restOps.get(name)
    if (!op) throw new OpError('not_found', `Unknown operation "${name}".`, 'GET /api/meta/ops lists the operations available over REST.')
    const principal = await principalFor(req, op.caller === 'public')
    gw.limit(principal, req.ip)
    const out = await gw.run(op, rawInput, { principal, surface: 'rest', requestId: req.id, ip: req.ip })
    return reply.send(out)
  }

  app.post<{ Params: { name: string } }>('/api/ops/:name', (req, reply) => runRest(req, reply, req.params.name, req.body))

  app.get<{ Params: { name: string } }>('/api/ops/:name', (req, reply) => {
    const op = restOps.get(req.params.name)
    if (!op) throw new OpError('not_found', `Unknown operation "${req.params.name}".`, 'GET /api/meta/ops lists the operations available over REST.')
    if (!op.annotations.readOnlyHint) throw new OpError('invalid_input', `${op.name} changes state, so it is POST only.`, `POST /api/ops/${op.name} with a JSON body.`)
    return runRest(req, reply, op.name, coerceQuery(catalog.get(op.name)!, req.query as Record<string, unknown>))
  })

  app.get('/api/meta/ops', async (_req, reply) => reply.header('cache-control', 'public, max-age=60').send({ version: SERVER_VERSION, count: opCatalog().length, ops: opCatalog() }))

  app.get('/api/health', async () => ({ ok: true, version: SERVER_VERSION, payment_rail: core.config.paymentRail, ai_provider: core.config.aiProvider, demo_mode: core.config.demoMode }))

  // ---------- sessions (people) ----------
  const summarise = (p: Principal) => (p.kind === 'agent' ? { kind: p.kind, agent_id: p.agent_id, owner_id: p.owner_id } : p.kind === 'user' ? { kind: p.kind, user_id: p.user_id, name: p.name, roles: p.roles, act_as: p.act_as } : { kind: 'public' })
  const config = () => ({ demo_mode: core.config.demoMode, payment_rail: core.config.paymentRail, public_url: core.config.publicUrl })

  // The web app reads { user: {id, name, role} | null, agents }; `principal` and `config` stay for other clients.
  app.get('/api/session', async (req) => {
    const principal = await resolvePrincipal(core, req.headers)
    const { user, agents } = await core.auth.session(principal)
    return { user, agents, principal: summarise(principal), config: config() }
  })

  const DemoBody = z.object({ persona: z.enum(['owner', 'arbiter', 'seller']) })
  app.post('/api/session/demo', async (req, reply) => {
    if (!core.config.demoMode) throw new OpError('not_found', 'Demo sign-in is disabled on this server.', 'Sign in with a real account.')
    gw.limit({ kind: 'public' }, req.ip)
    const body = DemoBody.safeParse(req.body)
    if (!body.success) throw new OpError('invalid_input', 'persona must be owner, arbiter or seller.', 'POST {"persona":"owner"}.')
    const { token, principal } = await core.auth.demoSignIn(body.data.persona)
    reply.header('set-cookie', sessionCookie(token, secure))
    const { user, agents } = await core.auth.session(principal)
    return { user, agents, principal: summarise(principal), config: config() }
  })

  // Log in with PayPal and the /account API (paypal-login.ts).
  const accounts = registerAccounts(app, core, gw, { secure, demoMode: core.config.demoMode, ...opts.paypalLogin })

  app.post('/api/session/logout', async (req, reply) => {
    accounts.endSession(req)
    reply.header('set-cookie', clearedSessionCookie(secure))
    return { ok: true }
  })

  // ---------- events ----------
  registerSse(app, gw, opts.sseHeartbeatMs !== undefined ? { heartbeatMs: opts.sseHeartbeatMs } : {})

  // ---------- PayPal ----------
  app.post('/api/paypal/webhook', async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {})
    try {
      const res = await core.payments.handleWebhook(req.headers, raw)
      if (!res.accepted) req.log.warn({ req_id: req.id, event_type: res.event_type, note: res.note }, 'paypal webhook not accepted')
      return reply.code(res.accepted ? 200 : 202).send(res)
    } catch (e) {
      req.log.error({ req_id: req.id, err: e instanceof Error ? e.message : String(e) }, 'paypal webhook failed')
      return reply.code(500).send({ accepted: false, event_type: null, note: 'webhook processing failed; PayPal will retry' })
    }
  })

  const toBrowser = (fn: (q: Record<string, string>) => Promise<{ redirect: string }>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.redirect((await fn(flat(req.query))).redirect, 302)
    } catch (e) {
      const err = toOpError(e, req.id)
      return reply.redirect(`/?payment_error=${encodeURIComponent(err.code)}`, 302)
    }
  }
  app.get('/api/paypal/return', toBrowser((q) => core.payments.onOrderReturn(q)))
  app.get('/api/paypal/vault/return', toBrowser((q) => core.payments.onVaultReturn(q)))

  // The stand-in PayPal pages exist only on the simulated rail; on real PayPal these routes are 404.
  const SimBody = z.object({ kind: z.enum(['order', 'vault', 'mandate']), id: z.string().min(1).max(200), approve: z.boolean() })
  app.post('/api/sim/paypal/approve', async (req) => {
    if (!core.payments.simulatedApprove) throw new OpError('not_found', 'The payment rail is not simulated.', 'Use the real PayPal approval_url.')
    const body = SimBody.safeParse(req.body)
    if (!body.success) throw new OpError('invalid_input', 'Body must be {kind: "order"|"vault", id, approve: boolean}.', 'See docs/API.md.')
    // Answers { redirect } where the browser should go next.
    return core.payments.simulatedApprove(body.data.kind === 'mandate' ? 'vault' : body.data.kind, body.data.id, body.data.approve)
  })
  app.get<{ Params: { kind: string; id: string } }>('/api/sim/paypal/:kind/:id', async (req) => {
    const kind = req.params.kind === 'mandate' ? 'vault' : req.params.kind
    if (!core.payments.simulatedInfo || (kind !== 'order' && kind !== 'vault')) throw new OpError('not_found', 'The payment rail is not simulated.', 'Use the real PayPal approval_url.')
    gw.limit({ kind: 'public' }, req.ip)
    const info = await core.payments.simulatedInfo(kind, req.params.id)
    if (!info) throw new OpError('not_found', 'Unknown simulated PayPal object.', 'Use the approval_url from fund_job or request_mandate.')
    return info
  })

  // ---------- artifacts, public data, demo ----------
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const principal = await resolvePrincipal(core, req.headers)
    if (principal.kind === 'public') throw new OpError('unauthenticated', 'Artifacts are private to the parties of a job.', 'Send "Authorization: Bearer <api key>" or sign in.')
    gw.limit(principal, req.ip)
    const art = await core.artifacts.read(req.params.id, principal)
    if (!art) throw new OpError('not_found', 'No such artifact.', 'Check the artifact id from upload_artifact or the job room.')
    const mime = /^[\w.+-]+\/[\w.+-]+(;[\w=.+\- ]*)?$/.test(art.mime) ? art.mime : 'application/octet-stream'
    const inline = SAFE_INLINE.test(mime)
    return reply
      .header('content-type', mime)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(art.name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
      .header('cache-control', 'private, max-age=300')
      .send(Buffer.from(art.bytes))
  })

  app.get('/api/public/stats', async (req, reply) => {
    gw.limit({ kind: 'public' }, req.ip)
    return reply.header('cache-control', 'public, max-age=5').send(await core.public.stats())
  })
  app.get('/api/public/feed', async (req, reply) => {
    gw.limit({ kind: 'public' }, req.ip)
    const n = Number((req.query as { limit?: string }).limit ?? 30)
    return reply.header('cache-control', 'public, max-age=5').send(await core.public.feed(Number.isInteger(n) ? Math.min(Math.max(n, 1), 100) : 30))
  })

  app.post('/api/demo/reset', async (req) => {
    if (!core.config.demoMode || !core.demo) throw new OpError('not_found', 'Demo reset is only available in demo mode.', 'Nothing to do.')
    // A public demo must not be wipeable by anyone: with DEMO_RESET_TOKEN set the caller must present it, and a
    // production server without one has no reset at all.
    const token = process.env.DEMO_RESET_TOKEN?.trim()
    const given = req.headers['x-demo-reset-token']
    const ok = token ? typeof given === 'string' && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token)) : process.env.NODE_ENV !== 'production'
    if (!ok) throw new OpError('not_found', 'Demo reset is only available in demo mode.', 'Nothing to do.')
    await core.demo.reset()
    return { ok: true }
  })

  // ---------- the AG Studio analyst's model route (people only, rate-limited, counted against the AI spend cap) ----------
  registerAnalyst(app, core, opts.analystLimits)

  // ---------- discovery, MCP, static web ----------
  registerDiscovery(app, core)
  mountMcp(app, gw, opts.mcp)

  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: true,
      index: ['index.html'],
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('cache-control', 'public, max-age=31536000, immutable')
      },
    })
  }

  return app
}
