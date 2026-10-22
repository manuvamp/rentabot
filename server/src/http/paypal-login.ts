// People's accounts over HTTP: "Log in with PayPal" (OAuth 2.0 authorization code, PayPal Identity API) and the
// /account API (profile, payout email, agents and their keys, claiming, mandate revoke).
//
// Security: the OAuth `state` is HMAC-signed, expires in 10 minutes, carries a nonce that must match a short-lived
// HttpOnly cookie (CSRF) and is single use. Return paths are same-origin relative paths only. The PayPal access
// token lives for one request and is never stored or logged; neither is the authorization code (request logs keep
// only the path, never the query string).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { loadPayPalLoginConfig, type PayPalLoginConfig } from '../config.ts'
import type { PayPalIdentity } from '../core/accounts.ts'
import { OpError, type Core } from '../core/types.ts'
import { SESSION_COOKIE, cookieFrom, resolvePrincipal, sessionCookie } from './auth.ts'
import type { Gateway } from './gateway.ts'

export interface PayPalLoginOptions extends Partial<PayPalLoginConfig> {
  fetch?: typeof fetch
  now?: () => number
}

const STATE_COOKIE = 'rab_oauth'
const STATE_TTL_MS = 10 * 60_000
const TIMEOUT_MS = 15_000
const DEFAULT_RETURN = '/account'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const truthy = (v: unknown) => v === true || v === 'true'

/** A same-origin relative path ("/account?x=1"), or null. Rejects "//host", "/\host", schemes and control characters. */
export function safeReturnPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return null
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\u0000-\u001f\u007f]|%[01][0-9a-f]|%7f/i.test(p)) return null
  try {
    const u = new URL(p, 'http://same.invalid')
    if (u.origin !== 'http://same.invalid') return null
    if (u.pathname.startsWith('/api/')) return null
    return u.pathname + u.search + u.hash
  } catch {
    return null
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')

export function signState(secret: Buffer, payload: { n: string; r: string; e: number }): string {
  const body = b64(JSON.stringify(payload))
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** Verify signature and expiry; returns the payload or null. The nonce/cookie match is the caller's job. */
export function verifyState(secret: Buffer, state: string, nowMs: number): { n: string; r: string; e: number } | null {
  const [body, sig, extra] = state.split('.')
  if (!body || !sig || extra !== undefined || state.length > 1000) return null
  const want = createHmac('sha256', secret).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { n?: unknown; r?: unknown; e?: unknown }
    if (typeof p.n !== 'string' || typeof p.r !== 'string' || typeof p.e !== 'number' || p.e < nowMs) return null
    return { n: p.n, r: safeReturnPath(p.r) ?? DEFAULT_RETURN, e: p.e }
  } catch {
    return null
  }
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** PayPal userinfo (schema=paypalv1.1, or the OpenID shape) -> the fields we keep. */
export function identityFromUserinfo(u: Obj): PayPalIdentity | null {
  const paypal_user_id = str(u.user_id) ?? str(u.sub)
  if (!paypal_user_id) return null
  const emails = (Array.isArray(u.emails) ? u.emails : []).map(obj)
  const best = emails.find((e) => truthy(e.primary) && truthy(e.confirmed)) ?? emails.find((e) => truthy(e.primary)) ?? emails.find((e) => truthy(e.confirmed)) ?? emails[0]
  const email = str(best?.value) ?? str(u.email)
  const email_verified = best ? truthy(best.confirmed) : truthy(u.email_verified)
  const name = str(u.name) ?? ([str(u.given_name), str(u.family_name)].filter(Boolean).join(' ') || 'PayPal user')
  return { paypal_user_id, payer_id: str(u.payer_id), name, email, email_verified, verified_account: truthy(u.verified_account) }
}

class LoginError extends Error {
  code: 'state' | 'denied' | 'paypal' | 'disabled' | 'rate_limited'
  constructor(code: LoginError['code'], msg: string) {
    super(msg)
    this.code = code
  }
}

export function registerAccounts(app: FastifyInstance, core: Core, gw: Gateway, opts: { secure: boolean; demoMode: boolean } & PayPalLoginOptions) {
  const cfg: PayPalLoginConfig = { ...loadPayPalLoginConfig(core.config.publicUrl), ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) }
  const accounts = core.accounts
  const enabled = () => cfg.enabled && !!accounts
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const secret = cfg.stateSecret ? createHmac('sha256', 'rab-oauth-state').update(cfg.stateSecret).digest() : randomBytes(32)
  // Single use: a nonce seen once is refused until its state would have expired anyway.
  const usedNonces = new Map<string, number>()
  const stateCookie = (value: string, maxAge: number) => `${STATE_COOKIE}=${value}; Path=/api/auth/paypal; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${opts.secure ? '; Secure' : ''}`
  const withError = (path: string, code: string) => `${path}${path.includes('?') ? '&' : '?'}login_error=${code}`

  // ---------- Log in with PayPal ----------
  app.get('/api/auth/config', async () => ({ paypal_login: enabled(), demo_mode: core.config.demoMode, paypal_env: cfg.authorizeUrl.startsWith('https://www.paypal.com') ? 'live' : 'sandbox' }))

  app.get('/api/auth/paypal/start', async (req, reply) => {
    const q = req.query as { return_to?: string }
    const back = safeReturnPath(q.return_to) ?? DEFAULT_RETURN
    if (!enabled()) return reply.redirect(withError(back, 'disabled'), 302)
    try {
      gw.limit({ kind: 'public' }, req.ip)
    } catch {
      return reply.redirect(withError(back, 'rate_limited'), 302)
    }
    const nonce = randomBytes(18).toString('base64url')
    const state = signState(secret, { n: nonce, r: back, e: now() + STATE_TTL_MS })
    const url = new URL(cfg.authorizeUrl)
    url.searchParams.set('flowEntry', 'static')
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', cfg.scopes)
    url.searchParams.set('redirect_uri', cfg.redirectUri)
    url.searchParams.set('state', state)
    reply.header('set-cookie', stateCookie(nonce, STATE_TTL_MS / 1000))
    reply.header('cache-control', 'no-store')
    return reply.redirect(url.toString(), 302)
  })

  async function paypalJson(path: string, init: RequestInit, what: string): Promise<Obj> {
    const headers: Record<string, string> = { accept: 'application/json', ...(init.headers as Record<string, string>) }
    if (cfg.egressSecret) headers['x-egress-key'] = cfg.egressSecret
    let res: Response
    try {
      res = await doFetch(`${cfg.apiBase}${path}`, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new LoginError('paypal', `PayPal ${what} unreachable (${e instanceof Error ? e.name : 'error'})`)
    }
    const text = await res.text()
    let body: Obj = {}
    try {
      body = obj(JSON.parse(text))
    } catch {
      /* non-JSON error page */
    }
    // Only the error name goes to the log: PayPal bodies never echo tokens, but we do not risk it.
    if (!res.ok) throw new LoginError('paypal', `PayPal ${what} failed: HTTP ${res.status} ${str(body.error) ?? str(body.name) ?? ''}`.trim())
    return body
  }

  app.get('/api/auth/paypal/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    reply.header('cache-control', 'no-store')
    const clear = stateCookie('', 0)
    let back = DEFAULT_RETURN
    try {
      if (!enabled()) throw new LoginError('disabled', 'Log in with PayPal is off')
      try {
        gw.limit({ kind: 'public' }, req.ip)
      } catch {
        throw new LoginError('rate_limited', 'too many sign-in attempts')
      }
      const st = typeof q.state === 'string' ? verifyState(secret, q.state, now()) : null
      // Cancelled consent may come back without a usable state: still say "denied", to the default page.
      if (!st && q.error) throw new LoginError('denied', `consent not given (${String(q.error).slice(0, 40)})`)
      if (!st) throw new LoginError('state', 'state missing, forged or expired')
      back = st.r
      const cookie = cookieFrom(req.headers, STATE_COOKIE)
      if (!cookie || !sameText(cookie, st.n)) throw new LoginError('state', 'state does not match this browser')
      for (const [n, exp] of usedNonces) if (exp < now()) usedNonces.delete(n)
      if (usedNonces.has(st.n)) throw new LoginError('state', 'state already used')
      usedNonces.set(st.n, st.e)
      // PayPal sends the user back with ?error=access_denied (or no code) when they cancel consent.
      if (q.error || !q.code) throw new LoginError('denied', `consent not given (${String(q.error ?? 'no code').slice(0, 40)})`)
      if (q.code.length > 2000) throw new LoginError('state', 'code too long')

      const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
      const tok = await paypalJson(
        '/v1/oauth2/token',
        { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code }).toString() },
        'token exchange',
      )
      const access = str(tok.access_token)
      if (!access) throw new LoginError('paypal', 'PayPal token exchange returned no access token')
      const info = await paypalJson('/v1/identity/oauth2/userinfo?schema=paypalv1.1', { method: 'GET', headers: { authorization: `Bearer ${access}` } }, 'userinfo')
      const identity = identityFromUserinfo(info)
      if (!identity) throw new LoginError('paypal', 'PayPal userinfo had no user id')
      const { token, created } = accounts!.paypalSignIn(identity)
      req.log.info({ req_id: req.id, created }, created ? 'paypal sign-up' : 'paypal sign-in')
      reply.header('set-cookie', [clear, sessionCookie(token, opts.secure)])
      const dest = created && back === DEFAULT_RETURN ? `${DEFAULT_RETURN}?welcome=1` : back
      return reply.redirect(dest, 302)
    } catch (e) {
      const code = e instanceof LoginError ? e.code : 'paypal'
      req.log.warn({ req_id: req.id, code, err: e instanceof Error ? e.message : 'error' }, 'paypal login failed')
      reply.header('set-cookie', clear)
      return reply.redirect(withError(code === 'state' ? DEFAULT_RETURN : back, code), 302)
    }
  })

  // ---------- /account API (signed-in people only) ----------
  const need = () => {
    if (!accounts) throw new OpError('not_found', 'Accounts are not available on this server.', 'Use an API key.')
    return accounts
  }
  async function who(req: FastifyRequest) {
    const p = await resolvePrincipal(core, req.headers)
    gw.limit(p, req.ip)
    if (p.kind !== 'user') throw new OpError('unauthenticated', 'Sign in to manage your account.', 'Log in with PayPal on /account.')
    return p
  }
  const body = <T extends z.ZodType>(schema: T, raw: unknown, hint: string): z.infer<T> => {
    const r = schema.safeParse(raw)
    if (!r.success) throw new OpError('invalid_input', r.error.issues[0]?.message ?? 'Invalid input.', hint)
    return r.data
  }
  const send = (reply: FastifyReply, v: unknown) => reply.header('cache-control', 'no-store').send(v)
  const AgentParams = z.object({ id: z.string().regex(/^agt_[A-Za-z0-9]{6,40}$/) })

  app.get('/api/account', async (req, reply) => send(reply, need().overview(await who(req))))

  app.post('/api/account/payout-email', async (req, reply) => {
    const { email } = body(z.object({ email: z.string().max(254) }), req.body, 'POST {"email":"you@example.com"}.')
    return send(reply, { profile: need().setPayoutEmail(await who(req), email) })
  })

  app.post('/api/account/agents', async (req, reply) => {
    const { name } = body(z.object({ name: z.string().max(80) }), req.body, 'POST {"name":"Research agent"}.')
    return send(reply, need().createAgent(await who(req), name))
  })

  app.post<{ Params: { id: string } }>('/api/account/agents/:id/rotate-key', async (req, reply) => {
    const { id } = body(AgentParams, req.params, 'Use an agent id from GET /api/account.')
    return send(reply, need().rotateKey(await who(req), id))
  })

  app.post<{ Params: { id: string } }>('/api/account/agents/:id/revoke-keys', async (req, reply) => {
    const { id } = body(AgentParams, req.params, 'Use an agent id from GET /api/account.')
    return send(reply, need().revokeKeys(await who(req), id))
  })

  app.post<{ Params: { id: string } }>('/api/account/agents/:id/revoke-mandate', async (req, reply) => {
    const { id } = body(AgentParams, req.params, 'Use an agent id from GET /api/account.')
    return send(reply, need().revokeMandate(await who(req), id))
  })

  app.post('/api/account/claim', async (req, reply) => {
    const { claim_code } = body(z.object({ claim_code: z.string().min(1).max(40) }), req.body, 'POST {"claim_code":"ABCD2345"}.')
    return send(reply, need().claim(await who(req), claim_code))
  })

  /** Sign-out also forgets the session server-side. */
  return {
    endSession(req: FastifyRequest) {
      const t = cookieFrom(req.headers, SESSION_COOKIE)
      if (t) accounts?.endSession(t)
    },
  }
}
