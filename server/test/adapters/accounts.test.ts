// Log in with PayPal (against a fake PayPal Identity server), the /account API, and the agent self-signup ->
// owner claim -> mandate flow, end to end over real HTTP and MCP on a real core (simulated rail).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCore, type CoreImpl } from '../../src/core/index.ts'
import { buildApp } from '../../src/http/app.ts'
import { safeReturnPath, signState, verifyState } from '../../src/http/paypal-login.ts'
import { fakeIntelligence } from '../fakes/intelligence.ts'
import { startFakePayPalIdentity, type FakePayPalIdentity } from '../fakes/paypal-identity.ts'

let core: CoreImpl
let app: FastifyInstance
let base = ''
let fake: FakePayPalIdentity
let dataDir = ''
let nowMs = Date.now()
const clients: Client[] = []

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rab-acct-'))
  fake = await startFakePayPalIdentity()
  core = await createCore({
    intelligence: fakeIntelligence({}),
    config: { dataDir, tickMs: 0, demoMode: true, rail: 'simulated', sealKey: 'b'.repeat(64), publicUrl: 'http://127.0.0.1', paypal: { clientId: '', clientSecret: '', webhookId: '', env: 'sandbox' } },
    dbFile: ':memory:',
    simulated: { webhookDelayMs: 1 },
  })
  app = await buildApp(core, {
    logger: false,
    strictOutput: true,
    paypalLogin: {
      enabled: true,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      authorizeUrl: `${fake.base}/connect`,
      apiBase: fake.base,
      egressSecret: 'egress-test-key',
      redirectUri: 'http://127.0.0.1/api/auth/paypal/callback',
      stateSecret: 'test-state-secret',
      now: () => nowMs,
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
  await app.close()
  await core.close()
  await fake.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers })
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const cookieValue = (res: Response, name: string) => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return { raw: c, value: decodeURIComponent(c.slice(name.length + 1).split(';')[0]!) }
  return null
}

/** Browser half of the flow: /start -> (PayPal consent) -> /callback. Returns the session cookie header. */
async function start(returnTo?: string) {
  const res = await get(`/api/auth/paypal/start${returnTo !== undefined ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`)
  expect(res.status).toBe(302)
  const loc = new URL(res.headers.get('location')!)
  const nonce = cookieValue(res, 'rab_oauth')!
  return { loc, state: loc.searchParams.get('state')!, nonceCookie: `rab_oauth=${nonce.value}`, rawCookie: nonce.raw }
}
async function login(user = fake.user, returnTo?: string) {
  const s = await start(returnTo)
  const code = fake.issueCode(user)
  const cb = await get(`/api/auth/paypal/callback?code=${code}&state=${encodeURIComponent(s.state)}`, { cookie: s.nonceCookie })
  expect(cb.status).toBe(302)
  const sess = cookieValue(cb, 'rab_session')
  return { cb, location: cb.headers.get('location')!, cookie: sess ? `rab_session=${encodeURIComponent(sess.value)}` : '', rawSession: sess?.raw ?? '' }
}

async function mcp(key?: string) {
  const client = new Client({ name: 'acct-test', version: '0.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : {}))
  clients.push(client)
  return client
}

describe('return path guard', () => {
  it('only accepts same-origin relative paths', () => {
    expect(safeReturnPath('/jobs?x=1#a')).toBe('/jobs?x=1#a')
    expect(safeReturnPath('/account')).toBe('/account')
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', 'evil.com', '', '/%0d%0aSet-Cookie:x', '/a\nb', '/api/session/logout', ' /x', '/' + 'a'.repeat(400)]) expect(safeReturnPath(bad), bad).toBeNull()
    // Encoded slashes stay a path on this origin.
    expect(safeReturnPath('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com')
  })
})

describe('state', () => {
  const key = Buffer.alloc(32, 7)
  it('round-trips, rejects tampering and expiry', () => {
    const s = signState(key, { n: 'nonce', r: '/jobs', e: 2_000 })
    expect(verifyState(key, s, 1_000)).toEqual({ n: 'nonce', r: '/jobs', e: 2_000 })
    expect(verifyState(key, s, 3_000)).toBeNull()
    expect(verifyState(Buffer.alloc(32, 8), s, 1_000)).toBeNull()
    const [body, sig] = s.split('.')
    const forged = Buffer.from(JSON.stringify({ n: 'nonce', r: '//evil.com', e: 9e15 })).toString('base64url')
    expect(verifyState(key, `${forged}.${sig}`, 1_000)).toBeNull()
    expect(verifyState(key, `${body}.${sig}x`, 1_000)).toBeNull()
    expect(verifyState(key, `${body}`, 1_000)).toBeNull()
    // A signed but unsafe return path falls back to /account.
    expect(verifyState(key, signState(key, { n: 'n', r: '//evil.com', e: 2_000 }), 1_000)?.r).toBe('/account')
  })
})

describe('Log in with PayPal', () => {
  it('reports itself enabled', async () => {
    expect(await (await get('/api/auth/config')).json()).toMatchObject({ paypal_login: true, demo_mode: true })
  })

  it('start redirects to PayPal consent with a signed state bound to a short-lived HttpOnly cookie', async () => {
    const s = await start('/jobs')
    expect(s.loc.origin + s.loc.pathname).toBe(`${fake.base}/connect`)
    expect(Object.fromEntries(s.loc.searchParams)).toMatchObject({ flowEntry: 'static', client_id: fake.clientId, response_type: 'code', redirect_uri: 'http://127.0.0.1/api/auth/paypal/callback' })
    expect(s.loc.searchParams.get('scope')).toContain('openid')
    expect(s.loc.searchParams.get('scope')).toContain('email')
    expect(s.rawCookie).toMatch(/HttpOnly/)
    expect(s.rawCookie).toMatch(/SameSite=Lax/)
    expect(s.rawCookie).toMatch(/Path=\/api\/auth\/paypal/)
    expect(s.rawCookie).toMatch(/Max-Age=600/)
    expect(s.rawCookie).not.toMatch(/Secure/) // http here; see the https test below
  })

  it('first sign-in signs up: owner, personal buyer agent, verified flags, payout email = PayPal email', async () => {
    const before = fake.calls.length
    const r = await login()
    expect(r.location).toBe('/account?welcome=1')
    expect(r.rawSession).toMatch(/HttpOnly/)
    expect(r.rawSession).toMatch(/SameSite=Lax/)
    // PayPal calls went through the egress base with the egress key, token by Basic auth, userinfo by Bearer.
    const calls = fake.calls.slice(before)
    expect(calls.map((c) => c.path)).toEqual(['/v1/oauth2/token', '/v1/identity/oauth2/userinfo'])
    expect(calls.every((c) => c.egress === 'egress-test-key')).toBe(true)
    expect(calls[0]!.auth).toMatch(/^Basic /)
    expect(calls[1]!.auth).toMatch(/^Bearer A21AA/)

    const session = await (await get('/api/session', { cookie: r.cookie })).json()
    expect(session.user).toMatchObject({ name: 'Riley Buyer', role: 'owner', email: 'riley.buyer@example.com' })
    const acct = await (await get('/api/account', { cookie: r.cookie })).json()
    expect(acct.profile).toMatchObject({ name: 'Riley Buyer', email: 'riley.buyer@example.com', payout_email: 'riley.buyer@example.com', demo: false })
    expect(acct.profile.paypal).toMatchObject({ payer_id: 'FAKEPAYER123', email_verified: true, verified_account: true })
    expect(acct.agents).toHaveLength(1)
    expect(acct.agents[0]).toMatchObject({ personal: true, agent: { claimed: true, payout_email: 'riley.buyer@example.com' } })

    // No PayPal access token, refresh token or code is stored anywhere.
    const db = core.internal.services.d.db
    for (const t of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")) {
      const rows = JSON.stringify(db.all(`SELECT * FROM "${t.name}"`))
      expect(rows, t.name).not.toMatch(/A21AA|R23AA|C21AA/)
    }
  })

  it('find-or-create is idempotent: the same PayPal user gets the same account, fresh profile fields', async () => {
    const a = await login()
    const id1 = (await (await get('/api/session', { cookie: a.cookie })).json()).user.id
    const b = await login({ ...fake.user, name: 'Riley B. Buyer', email: 'riley.new@example.com' })
    expect(b.location).toBe('/account') // not a sign-up
    const s2 = await (await get('/api/session', { cookie: b.cookie })).json()
    expect(s2.user.id).toBe(id1)
    expect(s2.user.name).toBe('Riley B. Buyer')
    const db = core.internal.services.d.db
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM paypal_identities WHERE paypal_user_id = ?', fake.user.user_id)!.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?', id1)!.n).toBe(1)
    // The payout email the user may have chosen is not overwritten by a later login.
    expect((await (await get('/api/account', { cookie: b.cookie })).json()).profile.payout_email).toBe('riley.buyer@example.com')
  })

  it('an unconfirmed PayPal email is not used for payouts', async () => {
    const r = await login({ user_id: 'https://www.paypal.com/webapps/auth/identity/user/unconfirmed1', payer_id: 'UNCONF1', name: 'Una Confirmed', email: 'una@example.com', confirmed: false, verified_account: false })
    const acct = await (await get('/api/account', { cookie: r.cookie })).json()
    expect(acct.profile.payout_email).toBeNull()
    expect(acct.profile.paypal).toMatchObject({ email_verified: false, verified_account: false })
  })

  it('returns to the requested same-origin page, never to another origin', async () => {
    expect((await login(fake.user, '/jobs?tab=open')).location).toBe('/jobs?tab=open')
    expect((await login(fake.user, '//evil.example/steal')).location).toBe('/account')
    expect((await login(fake.user, 'https://evil.example')).location).toBe('/account')
  })

  it('rejects a callback whose state is missing, forged, from another browser, expired or replayed', async () => {
    const fail = async (q: string, cookie?: string) => {
      const res = await get(`/api/auth/paypal/callback?${q}`, cookie ? { cookie } : {})
      expect(res.status).toBe(302)
      expect(cookieValue(res, 'rab_session')).toBeNull()
      return res.headers.get('location')
    }
    const s = await start('/jobs')
    const code = () => fake.issueCode()
    expect(await fail(`code=${code()}`, s.nonceCookie)).toBe('/account?login_error=state')
    expect(await fail(`code=${code()}&state=${encodeURIComponent(s.state + 'x')}`, s.nonceCookie)).toBe('/account?login_error=state')
    // CSRF: an attacker's own valid state, replayed into a victim browser that has no (or another) nonce cookie.
    expect(await fail(`code=${code()}&state=${encodeURIComponent(s.state)}`)).toBe('/account?login_error=state')
    const other = await start()
    expect(await fail(`code=${code()}&state=${encodeURIComponent(s.state)}`, other.nonceCookie)).toBe('/account?login_error=state')
    // Expired.
    const old = await start()
    nowMs += 11 * 60_000
    expect(await fail(`code=${code()}&state=${encodeURIComponent(old.state)}`, old.nonceCookie)).toBe('/account?login_error=state')
    nowMs = Date.now()
    // Replayed: the first use works, the second is refused.
    const once = await start()
    const ok = await get(`/api/auth/paypal/callback?code=${code()}&state=${encodeURIComponent(once.state)}`, { cookie: once.nonceCookie })
    expect(cookieValue(ok, 'rab_session')).not.toBeNull()
    expect(await fail(`code=${code()}&state=${encodeURIComponent(once.state)}`, once.nonceCookie)).toBe('/account?login_error=state')
  })

  it('maps denied consent and PayPal outages to clear errors', async () => {
    const d = await start('/jobs')
    const denied = await get(`/api/auth/paypal/callback?error=access_denied&state=${encodeURIComponent(d.state)}`, { cookie: d.nonceCookie })
    expect(denied.headers.get('location')).toBe('/jobs?login_error=denied')
    expect((await get('/api/auth/paypal/callback?error=access_denied')).headers.get('location')).toBe('/account?login_error=denied')
    // A code PayPal does not know.
    const bad = await start()
    expect((await get(`/api/auth/paypal/callback?code=nope&state=${encodeURIComponent(bad.state)}`, { cookie: bad.nonceCookie })).headers.get('location')).toBe('/account?login_error=paypal')
    fake.down = true
    try {
      const s = await start()
      expect((await get(`/api/auth/paypal/callback?code=${fake.issueCode()}&state=${encodeURIComponent(s.state)}`, { cookie: s.nonceCookie })).headers.get('location')).toBe('/account?login_error=paypal')
    } finally {
      fake.down = false
    }
  })

  it('sign-out forgets the session server-side', async () => {
    const r = await login()
    expect((await (await get('/api/session', { cookie: r.cookie })).json()).user).not.toBeNull()
    await postJson('/api/session/logout', {}, { cookie: r.cookie })
    expect((await (await get('/api/session', { cookie: r.cookie })).json()).user).toBeNull()
  })

  it('marks cookies Secure on an https public URL', async () => {
    const httpsCore = await createCore({
      intelligence: fakeIntelligence({}),
      config: { dataDir, tickMs: 0, demoMode: false, rail: 'simulated', sealKey: 'b'.repeat(64), publicUrl: 'https://rentabot.example', paypal: { clientId: '', clientSecret: '', webhookId: '', env: 'sandbox' } },
      dbFile: ':memory:',
      seed: false,
    })
    const a = await buildApp(httpsCore, { logger: false, paypalLogin: { enabled: true, clientId: fake.clientId, clientSecret: fake.clientSecret, authorizeUrl: `${fake.base}/connect`, apiBase: fake.base } })
    const res = await a.inject({ method: 'GET', url: '/api/auth/paypal/start' })
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure/)
    expect(new URL(String(res.headers.location)).searchParams.get('redirect_uri')).toBe('https://rentabot.example/api/auth/paypal/callback')
    await a.close()
    await httpsCore.close()
  })
})

describe('agent self-signup -> owner claim -> mandate', () => {
  it('an agent with no key registers over MCP, keeps working, and its owner claims it and approves a mandate', async () => {
    // 1. The agent connects with no key, registers, and keeps going in the same session.
    const agent = await mcp()
    const reg = (await agent.callTool({ name: 'register_agent', arguments: { name: 'Self Signup Agent' } })) as any
    expect(reg.isError).toBeFalsy()
    const { api_key, claim_code, claim_url, agent: me } = reg.structuredContent
    expect(api_key).toMatch(/^rab_test_/)
    expect(claim_url).toContain(`/claim?code=${claim_code}`)
    expect(reg.structuredContent.next_actions.map((a: any) => a.op)).toEqual(expect.arrayContaining(['search_bots', 'request_mandate']))
    const bots = (await agent.callTool({ name: 'search_bots', arguments: {} })) as any
    expect(bots.isError).toBeFalsy()
    const bot = bots.structuredContent.bots[0]
    const draft = (await agent.callTool({ name: 'draft_job_spec', arguments: { bot_id: bot.id, skill_id: bot.skills[0].id, goal: 'List my product on five relevant directories.', quantity: 5 } })) as any
    expect(draft.isError).toBeFalsy()
    expect(draft.structuredContent.spec).toBeTruthy()

    // 2. The human signs in with PayPal and claims it. Wrong and reused codes fail clearly.
    const owner = await login({ user_id: 'https://www.paypal.com/webapps/auth/identity/user/owner42', payer_id: 'OWNER42', name: 'Olive Owner', email: 'olive@example.com' })
    const wrong = await postJson('/api/account/claim', { claim_code: 'ZZZZ9999' }, { cookie: owner.cookie })
    expect(wrong.status).toBe(404)
    expect((await wrong.json()).error.message).toMatch(/Unknown or already used/)
    const malformed = await postJson('/api/account/claim', { claim_code: '<script>' }, { cookie: owner.cookie })
    expect(malformed.status).toBe(400)
    expect((await postJson('/api/account/claim', { claim_code }, {})).status).toBe(401) // signed out
    const claimed = await postJson('/api/account/claim', { claim_code: claim_code.toLowerCase().replace(/(....)/, '$1-') }, { cookie: owner.cookie })
    expect(claimed.status).toBe(200)
    const cj = await claimed.json()
    expect(cj.agent).toMatchObject({ id: me.id, claimed: true, payout_email: 'olive@example.com' })
    const reused = await postJson('/api/account/claim', { claim_code }, { cookie: owner.cookie })
    expect(reused.status).toBe(404)
    // The claim_agent op still works for other clients and refuses a used code too.
    expect((await postJson('/api/ops/claim_agent', { claim_code }, { cookie: owner.cookie })).status).toBe(404)

    // 3. The owner approves a mandate once, acting as the claimed agent.
    const mres = await postJson('/api/ops/request_mandate', { monthly_cap: '100.00', per_job_cap: '40.00', categories: ['real_world_action'] }, { cookie: owner.cookie, 'x-act-as': me.id })
    expect(mres.status).toBe(200)
    const m = await mres.json()
    expect(m.mandate.status).toBe('pending_approval')
    const setupId = new URL(m.approval_url).pathname.split('/').pop()!
    const approved = await core.payments.simulatedApprove!('vault', setupId, true)
    expect(approved.redirect).toBe('/account?mandate=active')

    // The agent, on its own key, now has an active mandate and an owner.
    const again = await mcp(api_key)
    const who = (await again.callTool({ name: 'whoami', arguments: {} })) as any
    expect(who.structuredContent.owner.name).toBe('Olive Owner')
    expect(who.structuredContent.mandate.status).toBe('active')

    // /account shows it; revoking the mandate stops spending.
    const acct = await (await get('/api/account', { cookie: owner.cookie })).json()
    expect(acct.agents.find((a: any) => a.agent.id === me.id).mandate.status).toBe('active')
    const rv = await postJson(`/api/account/agents/${me.id}/revoke-mandate`, {}, { cookie: owner.cookie })
    expect((await rv.json()).mandate.status).toBe('revoked')
    // Someone else cannot touch this agent.
    const stranger = await login({ user_id: 'https://www.paypal.com/webapps/auth/identity/user/stranger7', payer_id: 'STR7', name: 'Sam Stranger', email: 'sam@example.com' })
    expect((await postJson(`/api/account/agents/${me.id}/rotate-key`, {}, { cookie: stranger.cookie })).status).toBe(404)
  })

  it('creates agents with a key shown once, rotates and revokes keys', async () => {
    const r = await login()
    const created = await (await postJson('/api/account/agents', { name: 'Research agent' }, { cookie: r.cookie })).json()
    expect(created.api_key).toMatch(/^rab_test_/)
    const whoami = (key: string) => fetch(`${base}/api/ops/whoami`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}' })
    expect((await whoami(created.api_key)).status).toBe(200)
    const acct = await (await get('/api/account', { cookie: r.cookie })).json()
    expect(JSON.stringify(acct)).not.toContain(created.api_key) // never shown again
    const rot = await (await postJson(`/api/account/agents/${created.agent.id}/rotate-key`, {}, { cookie: r.cookie })).json()
    expect((await whoami(created.api_key)).status).toBe(401)
    expect((await whoami(rot.api_key)).status).toBe(200)
    const rev = await (await postJson(`/api/account/agents/${created.agent.id}/revoke-keys`, {}, { cookie: r.cookie })).json()
    expect(rev.revoked).toBe(1)
    expect((await whoami(rot.api_key)).status).toBe(401)
    // An API key is not a session: agents cannot use the account API.
    expect((await fetch(`${base}/api/account`, { headers: { authorization: `Bearer ${created.api_key}` } })).status).toBe(401)
  })

  it('changes the payout email for every owned agent', async () => {
    const r = await login()
    expect((await postJson('/api/account/payout-email', { email: 'not-an-email' }, { cookie: r.cookie })).status).toBe(400)
    const ok = await (await postJson('/api/account/payout-email', { email: 'payouts@example.com' }, { cookie: r.cookie })).json()
    expect(ok.profile.payout_email).toBe('payouts@example.com')
    const acct = await (await get('/api/account', { cookie: r.cookie })).json()
    expect(acct.agents.every((a: any) => a.agent.payout_email === 'payouts@example.com')).toBe(true)
  })
})
