// A fake PayPal Identity server for tests and local screenshots: the consent page (/connect), the token
// exchange (/v1/oauth2/token, grant_type=authorization_code, Basic client auth) and userinfo
// (/v1/identity/oauth2/userinfo?schema=paypalv1.1). Shapes follow PayPal's docs; codes are single use.
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface FakePayPalUser {
  user_id: string
  payer_id: string
  name: string
  email: string
  confirmed?: boolean
  verified_account?: boolean
}

export interface FakePayPalIdentity {
  base: string
  clientId: string
  clientSecret: string
  /** The person who "logs in" on the consent page next. */
  user: FakePayPalUser
  /** Issue a code for `user` directly (tests skip the consent page). */
  issueCode(user?: FakePayPalUser): string
  /** Make the next token/userinfo calls fail (PayPal down). */
  down: boolean
  calls: { path: string; auth: string | null; egress: string | null }[]
  close(): Promise<void>
}

export async function startFakePayPalIdentity(opts: { port?: number; user?: FakePayPalUser } = {}): Promise<FakePayPalIdentity> {
  const clientId = 'fake-client-id'
  const clientSecret = 'fake-client-secret'
  const codes = new Map<string, FakePayPalUser>()
  const tokens = new Map<string, FakePayPalUser>()
  const fake: FakePayPalIdentity = {
    base: '',
    clientId,
    clientSecret,
    user: opts.user ?? { user_id: 'https://www.paypal.com/webapps/auth/identity/user/fakeUser123', payer_id: 'FAKEPAYER123', name: 'Riley Buyer', email: 'riley.buyer@example.com', confirmed: true, verified_account: true },
    issueCode(user) {
      const c = 'C21AA' + randomBytes(12).toString('hex')
      codes.set(c, user ?? fake.user)
      return c
    },
    down: false,
    calls: [],
    close: () => new Promise((r) => server.close(() => r())),
  }
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    fake.calls.push({ path: url.pathname, auth: req.headers.authorization ?? null, egress: (req.headers['x-egress-key'] as string | undefined) ?? null })
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (url.pathname === '/connect' && req.method === 'GET') {
        // Consent page: auto-approves (or ?deny=1 / the user cancels) and sends the browser back like PayPal does.
        const back = new URL(url.searchParams.get('redirect_uri') ?? '')
        const state = url.searchParams.get('state') ?? ''
        if (url.searchParams.get('client_id') !== clientId || url.searchParams.get('response_type') !== 'code') return json(res, 400, { error: 'invalid_request' })
        if (url.searchParams.get('deny')) {
          back.searchParams.set('error', 'access_denied')
          back.searchParams.set('state', state)
        } else {
          back.searchParams.set('code', fake.issueCode())
          back.searchParams.set('scope', url.searchParams.get('scope') ?? '')
          back.searchParams.set('state', state)
        }
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      if (fake.down) return json(res, 503, { name: 'SERVICE_UNAVAILABLE' })
      if (url.pathname === '/v1/oauth2/token' && req.method === 'POST') {
        const want = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
        if (req.headers.authorization !== want) return json(res, 401, { error: 'invalid_client', error_description: 'Client Authentication failed' })
        const form = new URLSearchParams(raw)
        const user = form.get('grant_type') === 'authorization_code' ? codes.get(form.get('code') ?? '') : undefined
        if (!user) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
        codes.delete(form.get('code')!)
        const access = 'A21AA' + randomBytes(16).toString('hex')
        tokens.set(access, user)
        return json(res, 200, { scope: 'openid profile email https://uri.paypal.com/services/paypalattributes', access_token: access, token_type: 'Bearer', expires_in: 28800, refresh_token: 'R23AA' + randomBytes(8).toString('hex'), nonce: 'n' })
      }
      if (url.pathname === '/v1/identity/oauth2/userinfo' && req.method === 'GET') {
        const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
        if (!user) return json(res, 401, { error: 'invalid_token' })
        return json(res, 200, {
          user_id: user.user_id,
          name: user.name,
          payer_id: user.payer_id,
          verified_account: String(user.verified_account ?? true),
          emails: [{ value: user.email, primary: true, confirmed: user.confirmed ?? true }],
        })
      }
      json(res, 404, { name: 'RESOURCE_NOT_FOUND' })
    })
  })
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()))
  const addr = server.address()
  fake.base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  return fake
}
