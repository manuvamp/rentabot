// Agents, API keys, people, sessions and claim codes.
// API keys look like rab_test_… (sandbox/simulated rail) or rab_live_…; only their sha256 is stored.
// Session tokens are stored the same way.
import type { Agent } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { Domain } from './domain.ts'
import { OpError, type Principal } from './types.ts'
import { newId, randomToken, sha256Hex } from './util.ts'

const SESSION_MS = 7 * 86_400_000
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export type UserPrincipal = Extract<Principal, { kind: 'user' }>
interface UserRow {
  id: string
  name: string
  email: string | null
  roles: string
  act_as: string
  persona: string | null
}

export class Auth {
  private d: Domain
  constructor(d: Domain) {
    this.d = d
  }

  private keyPrefix() {
    return this.d.rail.kind === 'paypal_live' ? 'rab_live_' : 'rab_test_'
  }

  createAgent(p: { name: string; description?: string; payout_email?: string | null; owner_id?: string | null }): { agent: Agent; api_key: string; claim_code: string } {
    const id = newId('agt')
    const claim_code = Array.from(randomToken(16)).slice(0, 8).map((ch) => CLAIM_ALPHABET[ch.charCodeAt(0) % CLAIM_ALPHABET.length]).join('')
    const agent: Agent = {
      id,
      name: p.name,
      description: p.description ?? '',
      owner_id: p.owner_id ?? null,
      claimed: !!p.owner_id,
      payout_email: p.payout_email ?? null,
      created_at: this.d.nowIso(),
    }
    const api_key = this.keyPrefix() + randomToken(24)
    this.d.db.tx(() => {
      this.d.db.run('INSERT INTO agents (id, data, owner_id, claim_code, created_at) VALUES (?, ?, ?, ?, ?)', id, JSON.stringify(agent), agent.owner_id, p.owner_id ? null : claim_code, agent.created_at)
      this.d.db.run('INSERT INTO api_keys (key_hash, agent_id, prefix, created_at) VALUES (?, ?, ?, ?)', sha256Hex(api_key), id, api_key.slice(0, 9), agent.created_at)
    })
    return { agent, api_key, claim_code }
  }

  saveAgent(a: Agent) {
    this.d.db.run('UPDATE agents SET data = ?, owner_id = ? WHERE id = ?', JSON.stringify(a), a.owner_id, a.id)
  }

  claim(user_id: string, code: string): Agent {
    const row = this.d.db.get<{ id: string; data: string }>('SELECT id, data FROM agents WHERE claim_code = ?', code.trim().toUpperCase())
    if (!row) throw new OpError('not_found', 'Unknown or already used claim code.', 'Check the code the agent gave you (claim_url from register_agent).')
    const a = json<Agent>(row.data)
    a.owner_id = user_id
    a.claimed = true
    this.d.db.run('UPDATE agents SET data = ?, owner_id = ?, claim_code = NULL WHERE id = ?', JSON.stringify(a), user_id, a.id)
    // Mandates the agent requested before it was claimed now belong to the owner.
    for (const m of this.d.db.all<{ id: string; data: string }>('SELECT id, data FROM mandates WHERE agent_id = ?', a.id)) {
      const md = json<Record<string, unknown>>(m.data)
      if (!md.owner_id) this.d.db.run('UPDATE mandates SET data = ? WHERE id = ?', JSON.stringify({ ...md, owner_id: user_id }), m.id)
    }
    return a
  }

  agentFromApiKey(key: string): Extract<Principal, { kind: 'agent' }> | null {
    if (!/^rab_(live|test)_[A-Za-z0-9_-]{16,}$/.test(key)) return null
    const row = this.d.db.get<{ agent_id: string; revoked: number }>('SELECT agent_id, revoked FROM api_keys WHERE key_hash = ?', sha256Hex(key))
    if (!row || row.revoked) return null
    const a = this.d.agent(row.agent_id)
    return a ? { kind: 'agent', agent_id: a.id, owner_id: a.owner_id } : null
  }

  createUser(p: { name: string; email?: string; roles: ('owner' | 'arbiter')[]; persona?: string }): { id: string; act_as: string } {
    const id = newId('usr')
    // Every person gets a personal agent to act through on the web.
    const personal = this.createAgent({ name: `${p.name} (web)`, description: `Personal web agent of ${p.name}.`, owner_id: id })
    this.d.db.run('INSERT INTO users (id, name, email, roles, act_as, persona, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, p.name, p.email ?? null, JSON.stringify(p.roles), personal.agent.id, p.persona ?? null, this.d.nowIso())
    return { id, act_as: personal.agent.id }
  }
  setActAs(user_id: string, agent_id: string) {
    this.d.db.run('UPDATE users SET act_as = ? WHERE id = ?', agent_id, user_id)
  }
  user(id: string): UserRow | undefined {
    return this.d.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)
  }
  private principalOf(u: UserRow, act_as?: string | null): UserPrincipal {
    return { kind: 'user', user_id: u.id, name: u.name, roles: json(u.roles), act_as: act_as || u.act_as }
  }

  createSession(user_id: string): { token: string; principal: UserPrincipal } {
    const u = this.user(user_id)
    if (!u) throw new OpError('not_found', 'Unknown user.', 'Sign in again.')
    const token = `rabs_${randomToken(32)}`
    const now = this.d.nowMs()
    this.d.db.run('INSERT INTO sessions (token_hash, user_id, act_as, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256Hex(token), user_id, u.act_as, new Date(now).toISOString(), new Date(now + SESSION_MS).toISOString())
    return { token, principal: this.principalOf(u) }
  }

  userFromSession(token: string): UserPrincipal | null {
    const s = this.d.db.get<{ user_id: string; act_as: string | null; expires_at: string }>('SELECT user_id, act_as, expires_at FROM sessions WHERE token_hash = ?', sha256Hex(token))
    if (!s || Date.parse(s.expires_at) < this.d.nowMs()) return null
    const u = this.user(s.user_id)
    return u ? this.principalOf(u, s.act_as) : null
  }

  demoSignIn(persona: 'owner' | 'arbiter' | 'seller') {
    const u = this.d.db.get<{ id: string }>('SELECT id FROM users WHERE persona = ?', persona)
    if (!u) throw new OpError('not_found', `Demo persona ${persona} is not seeded.`, 'Reset the demo data.')
    return this.createSession(u.id)
  }
}
