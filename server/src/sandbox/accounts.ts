// Accounts for Sandbox Web sites (directories that demand one, and the fake SaaS services): signup with a password policy,
// a verification email to the given inbox, the verification link, login (refused until verified) and sessions.
// A scope names the site ("dir:<slug>" or "saas:<slug>"); an email can hold one account per scope.
import type { FastifyInstance } from 'fastify'
import { between, hash32, hex, rng } from './rng.ts'
import type { Mail } from './mail.ts'
import { isEmail, normAddr } from './mail.ts'
import { hashSecret, passwordProblems, token, verifySecret } from './secrets.ts'
import type { Account, Clock, Store } from './state.ts'

export interface AccountSite {
  scope: string
  /** Display name and virtual host, e.g. "ToolHatch" / "toolhatch.dirs.sandbox". */
  name: string
  host: string
  /** Absolute URL of the verification link for a token. */
  verifyUrl(token: string): string
  minPassword?: number
  /** Nominal minutes before the verification email arrives: [low, high]. */
  mailDelayMinutes?: [number, number]
}

export interface Reply {
  code: number
  json: Record<string, unknown>
  headers?: Record<string, string>
}

export interface Accounts {
  signup(site: AccountSite, body: { email?: unknown; password?: unknown; display_name?: unknown; handle?: string | null }): Reply & { account?: Account }
  /** Mark the account behind a verification token as verified; null when the token is unknown. */
  verify(scope: string, token: string): Account | null
  login(site: AccountSite, body: { email?: unknown; password?: unknown }): Reply
  /** The verified account behind a session token of this scope. */
  session(scope: string, token: string | null | undefined): Account | null
  byId(id: string): Account | undefined
  find(scope: string, email: string): Account | undefined
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function createAccounts(deps: { store: Store; mail: Mail; clock: Clock; scale: number }): Accounts {
  const { store, mail, clock, scale } = deps
  const find = (scope: string, email: string) => store.data.accounts.find((a) => a.scope === scope && a.email === email)
  const byId = (id: string) => store.data.accounts.find((a) => a.id === id)
  return {
    find,
    byId,
    signup(site, body) {
      const email = normAddr(str(body.email))
      const password = typeof body.password === 'string' ? body.password : ''
      const display = str(body.display_name).slice(0, 80)
      if (!isEmail(email)) return { code: 400, json: { error: 'invalid_request', errors: { email: 'a valid email address is required' } } }
      const problems = passwordProblems(password, email, { min: site.minPassword ?? 12 })
      if (problems.length) return { code: 422, json: { error: 'weak_password', message: `The password needs ${problems.join(', ')}.`, problems } }
      if (find(site.scope, email)) return { code: 409, json: { error: 'account_exists', message: `There is already an account for ${email} on ${site.name}. Log in, or reset the password.` } }
      const seq = store.data.accounts.length + 1
      const account: Account = {
        id: `acc${String(seq).padStart(4, '0')}${hex(hash32(`${store.data.seed}:${site.scope}:${email}`), 4)}`,
        scope: site.scope,
        email,
        display_name: display,
        handle: body.handle ?? null,
        ...hashSecret(password),
        verify_token: token(16),
        verified_at: null,
        created_at: clock(),
      }
      store.data.accounts.push(account)
      store.save()
      // The verification mail takes a little while, like real ones.
      const [lo, hi] = site.mailDelayMinutes ?? [1, 3]
      const minutes = between(rng(`${store.data.seed}:verifymail:${account.id}`), lo, hi)
      mail.deliverSystem({
        from: `noreply@${site.host}`,
        to: email,
        at: clock() + minutes * 60_000 * scale,
        subject: `Verify your email for ${site.name}`,
        text: `Hi${display ? ` ${display}` : ''},\n\nWelcome to ${site.name}. Verify your email address to activate your account:\n\n${site.verifyUrl(account.verify_token)}\n\nIf you did not sign up, ignore this email.\n\n${site.name} (Sandbox Web fixture)`,
      })
      return { code: 201, account, json: { ok: true, account_id: account.id, status: 'pending_email_verification', message: `We sent a verification link to ${email}. Open it, then log in.` } }
    },
    verify(scope, tok) {
      const a = store.data.accounts.find((x) => x.scope === scope && x.verify_token === tok)
      if (!a) return null
      if (a.verified_at === null) {
        a.verified_at = clock()
        store.save()
      }
      return a
    },
    login(site, body) {
      const email = normAddr(str(body.email))
      const a = find(site.scope, email)
      const password = typeof body.password === 'string' ? body.password : ''
      if (!a || !verifySecret(password, a.salt, a.hash)) return { code: 401, json: { error: 'invalid_credentials', message: 'Wrong email or password.' } }
      if (a.verified_at === null) return { code: 403, json: { error: 'email_not_verified', message: `Verify your email first: open the link we sent to ${email}.` } }
      const session = token(18)
      store.data.sessions[session] = a.id
      store.save()
      return { code: 200, json: { ok: true, session_token: session, account_id: a.id, email: a.email } }
    },
    session(scope, tok) {
      if (!tok) return null
      const a = byId(store.data.sessions[tok] ?? '')
      return a && a.scope === scope && a.verified_at !== null ? a : null
    },
  }
}

/** Urlencoded form posts (the HTML forms of every sandbox site); add the parser only if the scope has none. */
export function ensureFormParser(sb: FastifyInstance): void {
  if (sb.hasContentTypeParser('application/x-www-form-urlencoded')) return
  sb.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    } catch (e) {
      done(e as Error)
    }
  })
}

/** A bearer token from the Authorization header, or the named cookie. */
export function sessionToken(req: { headers: Record<string, unknown> }, cookie: string): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(\S+)$/i)
    if (m) return m[1]!
  }
  const raw = req.headers.cookie
  if (typeof raw === 'string') for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === cookie) return v.join('=') || null
  }
  return null
}
