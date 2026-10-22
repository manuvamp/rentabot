import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiGet, apiPost, getActAs, setActAs as storeActAs } from './client'
import type { Agent } from './types'

export type Persona = 'owner' | 'arbiter' | 'seller'

/**
 * GET /api/session. Tolerant reader: `user` null means signed out; `agents` are the agents the user owns/operates.
 * Server contract assumed: { user: {id,name,role,email?}|null, agents?: Agent[], agent?: Agent }.
 */
export interface SessionUser {
  id: string
  name: string
  role: Persona
  email?: string
}
export interface SessionInfo {
  user: SessionUser | null
  agents: Agent[]
}

function normalize(raw: unknown): SessionInfo {
  const r = (raw ?? {}) as { user?: Partial<SessionUser> & { persona?: Persona }; agents?: Agent[]; agent?: Agent; persona?: Persona }
  if (!r.user) return { user: null, agents: [] }
  const role = (r.user.role ?? r.user.persona ?? r.persona ?? 'owner') as Persona
  const agents = r.agents ?? (r.agent ? [r.agent] : [])
  return { user: { id: String(r.user.id), name: String(r.user.name ?? 'You'), role, email: r.user.email }, agents }
}

/** GET /api/auth/config: which sign-in options this server offers. */
export interface AuthOptions {
  paypal_login: boolean
  demo_mode: boolean
}

/** Full-page redirect into Log in with PayPal; the server sends the browser back to `returnTo` (same-origin path). */
export function paypalLoginUrl(returnTo?: string) {
  const back = returnTo ?? (typeof window === 'undefined' ? '/account' : window.location.pathname + window.location.search)
  return `/api/auth/paypal/start?return_to=${encodeURIComponent(back)}`
}

interface Ctx {
  session: SessionInfo | null
  loading: boolean
  auth: AuthOptions
  /** The small "Sign in" sheet in the header. */
  sheetOpen: boolean
  openSignIn: () => void
  closeSignIn: () => void
  actAs: string | null
  setActAs: (id: string | null) => void
  signIn: (p: Persona) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const SessionContext = createContext<Ctx | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [actAs, setActAsState] = useState<string | null>(getActAs())
  const [auth, setAuth] = useState<AuthOptions>({ paypal_login: false, demo_mode: false })
  const [sheetOpen, setSheetOpen] = useState(false)
  const openSignIn = useCallback(() => setSheetOpen(true), [])
  const closeSignIn = useCallback(() => setSheetOpen(false), [])

  const refresh = useCallback(async () => {
    try {
      setSession(normalize(await apiGet('/api/session')))
    } catch {
      setSession({ user: null, agents: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    apiGet<AuthOptions>('/api/auth/config')
      .then((a) => setAuth({ paypal_login: !!a.paypal_login, demo_mode: !!a.demo_mode }))
      .catch(() => setAuth({ paypal_login: false, demo_mode: true }))
  }, [refresh])

  const signIn = useCallback(
    async (persona: Persona) => {
      await apiPost('/api/session/demo', { persona })
      storeActAs(null)
      setActAsState(null)
      setSheetOpen(false)
      await refresh()
    },
    [refresh],
  )

  const signOut = useCallback(async () => {
    try {
      await apiPost('/api/session/logout', {})
    } finally {
      storeActAs(null)
      setActAsState(null)
      setSession({ user: null, agents: [] })
    }
  }, [])

  const setActAs = useCallback((id: string | null) => {
    storeActAs(id)
    setActAsState(id)
  }, [])

  const value = useMemo(
    () => ({ session, loading, auth, sheetOpen, openSignIn, closeSignIn, actAs, setActAs, signIn, signOut, refresh }),
    [session, loading, auth, sheetOpen, openSignIn, closeSignIn, actAs, setActAs, signIn, signOut, refresh],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Ctx {
  const c = useContext(SessionContext)
  if (!c) throw new Error('useSession outside SessionProvider')
  return c
}

export const PERSONAS: { id: Persona; label: string; sub: string }[] = [
  { id: 'owner', label: 'Continue as Manu (ORANO)', sub: 'Buyer. Owns the ORANO Growth Agent and its PayPal mandate.' },
  { id: 'seller', label: 'Continue as Bot operator', sub: 'Seller. Runs Directory Blaster and gets paid out.' },
  { id: 'arbiter', label: 'Continue as Arbiter', sub: 'Human reviewer. Sees appeals in the Ops console.' },
]
