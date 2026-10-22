// People's accounts: "Log in with PayPal" identities (find-or-create), the /account page data, agent keys
// (create, rotate, revoke), claiming self-registered agents, payout email, and revoking a mandate.
// PayPal access tokens never reach this module: the HTTP layer exchanges them, reads the profile, and drops them.
import type { Agent, Mandate } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { Services } from './services.ts'
import { OpError, type Principal } from './types.ts'
import { randomToken, sha256Hex } from './util.ts'

/** The profile fields we keep from PayPal's userinfo. Nothing else is stored. */
export interface PayPalIdentity {
  /** Stable PayPal user id for this app (`user_id` / `sub`). The lookup key. */
  paypal_user_id: string
  payer_id: string | null
  name: string
  email: string | null
  email_verified: boolean
  verified_account: boolean
}

export interface AccountAgent {
  agent: Agent
  /** The agent the web app acts through by default. */
  personal: boolean
  keys: { prefix: string; created_at: string; revoked: boolean }[]
  mandate: Mandate | null
}

export interface AccountOverview {
  profile: {
    id: string
    name: string
    email: string | null
    paypal: { payer_id: string | null; email_verified: boolean; verified_account: boolean; linked_at: string } | null
    payout_email: string | null
    demo: boolean
  }
  agents: AccountAgent[]
}

export interface AccountsApi {
  paypalSignIn(id: PayPalIdentity): { token: string; user_id: string; created: boolean }
  endSession(token: string): void
  overview(p: Principal): AccountOverview
  setPayoutEmail(p: Principal, email: string): AccountOverview['profile']
  createAgent(p: Principal, name: string): { agent: Agent; api_key: string }
  rotateKey(p: Principal, agent_id: string): { agent: Agent; api_key: string }
  revokeKeys(p: Principal, agent_id: string): { agent: Agent; revoked: number }
  claim(p: Principal, code: string): { agent: Agent }
  revokeMandate(p: Principal, agent_id: string): { mandate: Mandate | null }
}

interface IdentityRow {
  paypal_user_id: string
  user_id: string
  payer_id: string | null
  email: string | null
  email_verified: number
  verified_account: number
  payout_email: string | null
  created_at: string
  updated_at: string
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

export function createAccounts(s: Services): AccountsApi {
  const { d, auth, escrow } = s
  // Its own table (created here, not in the shared migration list) so it never collides with other migrations.
  d.db.raw.exec(`CREATE TABLE IF NOT EXISTS paypal_identities (
    paypal_user_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, payer_id TEXT, email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0, verified_account INTEGER NOT NULL DEFAULT 0,
    payout_email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)

  const identityOf = (user_id: string) => d.db.get<IdentityRow>('SELECT * FROM paypal_identities WHERE user_id = ?', user_id)

  function person(p: Principal) {
    if (p.kind !== 'user') throw new OpError('unauthenticated', 'Sign in to manage your account.', 'Log in with PayPal on /account.')
    const u = auth.user(p.user_id)
    if (!u) throw new OpError('unauthenticated', 'Your session is no longer valid.', 'Sign in again.')
    return u
  }
  function owned(p: Principal, agent_id: string): Agent {
    const u = person(p)
    const a = d.agent(agent_id)
    if (!a || a.owner_id !== u.id) throw new OpError('not_found', 'You do not own an agent with that id.', 'GET /api/account lists your agents.')
    return a
  }
  const cleanName = (n: string) => n.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const keyPrefix = () => (d.rail.kind === 'paypal_live' ? 'rab_live_' : 'rab_test_')

  function issueKey(agent_id: string): string {
    const api_key = keyPrefix() + randomToken(24)
    d.db.run('INSERT INTO api_keys (key_hash, agent_id, prefix, created_at) VALUES (?, ?, ?, ?)', sha256Hex(api_key), agent_id, api_key.slice(0, 9) + api_key.slice(9, 13), d.nowIso())
    return api_key
  }

  function profile(u: { id: string; name: string; email: string | null; persona: string | null }): AccountOverview['profile'] {
    const idn = identityOf(u.id)
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      paypal: idn ? { payer_id: idn.payer_id, email_verified: !!idn.email_verified, verified_account: !!idn.verified_account, linked_at: idn.created_at } : null,
      payout_email: idn?.payout_email ?? d.agent(auth.user(u.id)!.act_as)?.payout_email ?? null,
      demo: !!u.persona,
    }
  }

  return {
    paypalSignIn(id) {
      if (!id.paypal_user_id || id.paypal_user_id.length > 300) throw new OpError('invalid_input', 'PayPal returned no user id.', 'Try logging in again.')
      const name = cleanName(id.name) || 'PayPal user'
      const email = id.email && EMAIL.test(id.email) ? id.email.slice(0, 254) : null
      const now = d.nowIso()
      // node:sqlite is synchronous, so the lookup and the insert below cannot interleave with another callback.
      const { user_id, created } = d.db.tx(() => {
        const found = d.db.get<IdentityRow>('SELECT * FROM paypal_identities WHERE paypal_user_id = ?', id.paypal_user_id)
        if (found) {
          d.db.run('UPDATE paypal_identities SET payer_id = ?, email = ?, email_verified = ?, verified_account = ?, updated_at = ? WHERE paypal_user_id = ?', id.payer_id, email, id.email_verified ? 1 : 0, id.verified_account ? 1 : 0, now, id.paypal_user_id)
          d.db.run('UPDATE users SET name = ?, email = ? WHERE id = ?', name, email, found.user_id)
          return { user_id: found.user_id, created: false }
        }
        // First sign-in is sign-up: an owner with a personal buyer agent, like the demo owner.
        const u = auth.createUser({ name, ...(email ? { email } : {}), roles: ['owner'] })
        // Payouts default to the PayPal email only when PayPal says it is confirmed.
        const payout = email && id.email_verified ? email : null
        if (payout) {
          const a = d.agent(u.act_as)!
          auth.saveAgent({ ...a, name: `${name.split(' ')[0]}'s agent`.slice(0, 80), payout_email: payout })
        }
        d.db.run(
          'INSERT INTO paypal_identities (paypal_user_id, user_id, payer_id, email, email_verified, verified_account, payout_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id.paypal_user_id, u.id, id.payer_id, email, id.email_verified ? 1 : 0, id.verified_account ? 1 : 0, payout, now, now,
        )
        return { user_id: u.id, created: true }
      })
      const { token } = auth.createSession(user_id)
      return { token, user_id, created }
    },

    endSession(token) {
      if (token) d.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256Hex(token))
    },

    overview(p) {
      const u = person(p)
      const ids = d.db.all<{ id: string }>('SELECT id FROM agents WHERE owner_id = ? ORDER BY created_at', u.id).map((r) => r.id)
      const agents = ids
        .map((id) => d.agent(id))
        .filter((a): a is Agent => !!a)
        .map((agent) => ({
          agent,
          personal: agent.id === u.act_as,
          keys: d.db.all<{ prefix: string; created_at: string; revoked: number }>('SELECT prefix, created_at, revoked FROM api_keys WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC', agent.id).map((k) => ({ prefix: k.prefix, created_at: k.created_at, revoked: !!k.revoked })),
          mandate: escrow.mandateFor(agent.id),
        }))
      return { profile: profile(u), agents }
    },

    setPayoutEmail(p, email) {
      const u = person(p)
      const e = email.trim()
      if (!EMAIL.test(e) || e.length > 254) throw new OpError('invalid_input', 'That is not a valid email address.', 'Use the email of the PayPal account that should receive payouts.')
      d.db.tx(() => {
        for (const r of d.db.all<{ id: string }>('SELECT id FROM agents WHERE owner_id = ?', u.id)) {
          const a = d.agent(r.id)
          if (a) auth.saveAgent({ ...a, payout_email: e })
        }
        d.db.run('UPDATE paypal_identities SET payout_email = ?, updated_at = ? WHERE user_id = ?', e, d.nowIso(), u.id)
      })
      return profile(auth.user(u.id)!)
    },

    createAgent(p, name) {
      const u = person(p)
      const n = cleanName(name)
      if (n.length < 2) throw new OpError('invalid_input', 'Give the agent a name of at least 2 characters.', 'For example "Research agent".')
      if (d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?', u.id)!.n >= 20) throw new OpError('invalid_input', 'You already own 20 agents.', 'Revoke or reuse one of them.')
      const payout = profile(u).payout_email
      const { agent, api_key } = auth.createAgent({ name: n, description: `Agent of ${u.name}.`, owner_id: u.id, payout_email: payout })
      return { agent, api_key }
    },

    rotateKey(p, agent_id) {
      const a = owned(p, agent_id)
      const api_key = d.db.tx(() => {
        d.db.run('UPDATE api_keys SET revoked = 1 WHERE agent_id = ?', a.id)
        return issueKey(a.id)
      })
      return { agent: a, api_key }
    },

    revokeKeys(p, agent_id) {
      const a = owned(p, agent_id)
      const r = d.db.run('UPDATE api_keys SET revoked = 1 WHERE agent_id = ? AND revoked = 0', a.id)
      return { agent: a, revoked: Number(r.changes) }
    },

    claim(p, code) {
      const u = person(p)
      const c = code.trim().toUpperCase().replace(/[\s-]/g, '')
      if (!/^[A-Z0-9]{6,16}$/.test(c)) throw new OpError('invalid_input', 'A claim code is 8 letters and digits.', 'Copy claim_code from the agent’s register_agent result.')
      const agent = auth.claim(u.id, c)
      // A seller agent without a payout address pays out to the owner's.
      const payout = profile(u).payout_email
      if (!agent.payout_email && payout) {
        const next = { ...agent, payout_email: payout }
        auth.saveAgent(next)
        return { agent: next }
      }
      return { agent }
    },

    revokeMandate(p, agent_id) {
      const a = owned(p, agent_id)
      for (const row of d.db.all<{ id: string; data: string }>('SELECT id, data FROM mandates WHERE agent_id = ?', a.id)) {
        const m = json<Mandate>(row.data)
        if (m.status === 'active' || m.status === 'pending_approval') d.db.run('UPDATE mandates SET data = ? WHERE id = ?', JSON.stringify({ ...m, status: 'revoked', approval_url: null }), row.id)
      }
      const mandate = escrow.mandateFor(a.id)
      d.bus.publish('mandate', null, { agents: [a.id] }, 'Spending mandate revoked by its owner', { mandate_id: mandate?.id ?? null, status: 'revoked' })
      return { mandate }
    },
  }
}

