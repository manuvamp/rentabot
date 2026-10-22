// Who is calling? Bearer API key -> agent; rab_session cookie -> person (optionally acting through an agent).
import type { IncomingHttpHeaders } from 'node:http'
import { OpError, type Core, type Principal } from '../core/types.ts'

export const SESSION_COOKIE = 'rab_session'

export function bearerFrom(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth)
    if (m) return m[1]!
  }
  const xk = headers['x-api-key']
  return typeof xk === 'string' && xk.trim() ? xk.trim() : null
}

export function cookieFrom(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds = 60 * 60 * 24 * 7): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}
export const clearedSessionCookie = (secure: boolean) => sessionCookie('', secure, 0)

export const invalidKey = () =>
  new OpError('unauthenticated', 'The API key is unknown or revoked.', 'Omit the Authorization header to use public operations, or call register_agent for a new key.')

/** Resolve the caller. An invalid Bearer key is an error (never silently public); a stale cookie is just public. */
export async function resolvePrincipal(core: Core, headers: IncomingHttpHeaders): Promise<Principal> {
  const key = bearerFrom(headers)
  if (key) {
    const agent = await core.auth.agentFromApiKey(key)
    if (!agent) throw invalidKey()
    return agent
  }
  const token = cookieFrom(headers, SESSION_COOKIE)
  if (token) {
    const user = await core.auth.userFromSession(token)
    if (user) {
      const act = headers['x-act-as']
      // The core verifies that this person owns the agent they act as.
      return typeof act === 'string' && /^agt_[A-Za-z0-9]{6,40}$/.test(act) ? { ...user, act_as: act } : user
    }
  }
  return { kind: 'public' }
}
