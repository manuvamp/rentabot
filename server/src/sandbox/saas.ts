// Five fake SaaS products (analytics, newsletter, social, status page, community forum) for the Account Setup Bot.
// Each has the same shape: signup (handle + password policy) -> verification email -> login -> a profile
// (name, logo, bio, link) -> a public page that goes live (the forum reviews new communities first).
// Real-web friction on purpose: handles can be taken or reserved, one service rate-limits signups, mail is slow, passwords
// have per-service strength rules, and a profile is only public once it is complete.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type AccountSite, type Accounts, ensureFormParser, sessionToken } from './accounts.ts'
import { normAddr } from './mail.ts'
import type { Clock, Profile, Store } from './state.ts'
import { esc, shell, wrap } from './ui.ts'

export interface Service {
  slug: string
  name: string
  kind: 'analytics' | 'newsletter' | 'social' | 'status' | 'forum'
  tagline: string
  /** What the account's public page is called, and its URL segment. */
  noun: string
  prefix: string
  hue: number
  handle: [number, number]
  limits: { display_name: number; bio: number }
  minPassword: number
  /** Nominal minutes before a completed profile becomes public (0 = at once). */
  review_minutes: number
  mailDelay: [number, number]
  /** The first signup of every email gets a 429 (retry after a couple of seconds). */
  rate_limited: boolean
  /** Handles somebody else already holds. */
  squatted: string[]
}

export const SERVICES: Service[] = [
  { slug: 'pulsemetrics', name: 'PulseMetrics', kind: 'analytics', tagline: 'Privacy-friendly website analytics.', noun: 'public dashboard', prefix: 'w', hue: 212, handle: [3, 30], limits: { display_name: 60, bio: 200 }, minPassword: 12, review_minutes: 0, mailDelay: [1, 2], rate_limited: false, squatted: ['demo', 'test', 'admin'] },
  { slug: 'inkletter', name: 'Inkletter', kind: 'newsletter', tagline: 'Newsletters people finish reading.', noun: 'publication', prefix: 'n', hue: 28, handle: [3, 30], limits: { display_name: 60, bio: 280 }, minPassword: 12, review_minutes: 0, mailDelay: [1, 3], rate_limited: false, squatted: ['news', 'weekly', 'admin'] },
  { slug: 'chirpbook', name: 'Chirpbook', kind: 'social', tagline: 'Short posts, real people.', noun: 'profile', prefix: 'u', hue: 190, handle: [5, 15], limits: { display_name: 50, bio: 160 }, minPassword: 14, review_minutes: 0, mailDelay: [1, 2], rate_limited: false, squatted: ['orano', 'admin', 'official'] },
  { slug: 'statusbeacon', name: 'StatusBeacon', kind: 'status', tagline: 'A status page your customers trust.', noun: 'status page', prefix: 's', hue: 142, handle: [3, 40], limits: { display_name: 60, bio: 120 }, minPassword: 12, review_minutes: 0, mailDelay: [1, 2], rate_limited: true, squatted: ['status', 'demo', 'test'] },
  { slug: 'townsquare', name: 'TownSquare', kind: 'forum', tagline: 'Communities for products people love.', noun: 'community', prefix: 'c', hue: 300, handle: [4, 30], limits: { display_name: 60, bio: 300 }, minPassword: 16, review_minutes: 6, mailDelay: [2, 4], rate_limited: false, squatted: ['orano', 'support', 'general'] },
]

const HANDLE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const isHttpUrl = (u: string) => {
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

export interface SaasContext {
  store: Store
  accounts: Accounts
  clock: Clock
  scale: number
  publicUrl: string
}

export function registerSaasRoutes(sb: FastifyInstance, ctx: SaasContext): void {
  const { store, accounts, clock, scale } = ctx
  const base = ctx.publicUrl.replace(/\/+$/, '')
  const bySlug = new Map(SERVICES.map((s) => [s.slug, s]))
  const svcUrl = (s: Service) => `${base}/sandbox/saas/${s.slug}`
  const pageUrl = (s: Service, handle: string) => `${svcUrl(s)}/${s.prefix}/${handle}`
  const host = (s: Service) => `${s.slug}.saas.sandbox`
  const site = (s: Service): AccountSite => ({ scope: `saas:${s.slug}`, name: s.name, host: host(s), verifyUrl: (t) => `${svcUrl(s)}/account/verify/${t}`, minPassword: s.minPassword, mailDelayMinutes: s.mailDelay })
  const cookie = (s: Service) => `sbx_${s.slug}`
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html').send(body)
  const missing = (reply: FastifyReply, what: string, json = false) =>
    json ? reply.code(404).send({ error: 'not_found', message: what }) : html(reply, 404, shell({ title: 'Not found', body: `<div class="wrap"><h1>404</h1><p>${esc(what)}</p></div>` }))
  ensureFormParser(sb)

  const profileOf = (s: Service, accountId: string) => store.data.profiles.find((p) => p.service === s.slug && p.account_id === accountId)
  const isLive = (s: Service, p: Profile) => p.live_at !== null && clock() >= p.live_at && !!p.display_name
  const byHandle = (s: Service, handle: string) => store.data.profiles.find((p) => p.service === s.slug && p.handle === handle)
  const handleTaken = (s: Service, h: string) => s.squatted.includes(h) || store.data.accounts.some((a) => a.scope === `saas:${s.slug}` && a.handle === h)

  const handleProblem = (s: Service, h: string): string | null => {
    if (!h) return 'a handle is required'
    if (h.length < s.handle[0] || h.length > s.handle[1]) return `handles are ${s.handle[0]}-${s.handle[1]} characters`
    if (!HANDLE.test(h)) return 'handles use lower-case letters, digits and hyphens, and cannot start or end with a hyphen'
    return null
  }

  const policyText = (s: Service) => `at least ${s.minPassword} characters with lower case, upper case, a digit and a symbol`

  function signup(s: Service, body: Record<string, unknown>) {
    const email = normAddr(str(body.email))
    const handle = str(body.handle).toLowerCase()
    const problem = handleProblem(s, handle)
    if (problem) return { code: 400, json: { error: 'invalid_request', errors: { handle: problem } } }
    if (s.rate_limited) {
      const key = `saas|${s.slug}|${email}`
      const n = store.data.attempts[key] ?? 0
      store.data.attempts[key] = n + 1
      store.save()
      if (n === 0) return { code: 429, headers: { 'retry-after': '2' }, json: { error: 'rate_limited', message: 'Too many signups from your network right now. Retry in a few seconds.', retry_after_seconds: 2 } }
    }
    if (handleTaken(s, handle)) {
      const suggestions = [`${handle}-hq`, `get${handle}`, `${handle}-app`].filter((h) => !handleProblem(s, h) && !handleTaken(s, h))
      return { code: 409, json: { error: 'handle_taken', message: `The handle "${handle}" is taken.`, suggestions } }
    }
    const res = accounts.signup(site(s), { email, password: body.password, display_name: body.display_name, handle })
    return res
  }

  function putProfile(s: Service, accountId: string, body: Record<string, unknown>) {
    const a = accounts.byId(accountId)!
    const display_name = str(body.display_name)
    const bio = str(body.bio)
    const logo_url = str(body.logo_url)
    const link = str(body.link)
    const errors: Record<string, string> = {}
    if (display_name.length < 2 || display_name.length > s.limits.display_name) errors.display_name = `display_name is required (2-${s.limits.display_name} characters)`
    if (!bio || bio.length > s.limits.bio) errors.bio = `bio is required (max ${s.limits.bio} characters)`
    if (!isHttpUrl(logo_url) || logo_url.length > 500) errors.logo_url = 'logo_url must be an http(s) URL'
    if (!isHttpUrl(link) || link.length > 500) errors.link = 'link must be an http(s) URL'
    if (Object.keys(errors).length) return { code: 422, json: { error: 'invalid_request', errors, limits: s.limits } }
    const t = clock()
    let p = profileOf(s, accountId)
    if (!p) {
      p = { id: `prf${String(store.data.profiles.length + 1).padStart(4, '0')}`, service: s.slug, account_id: accountId, handle: a.handle ?? '', display_name, bio, logo_url, link, created_at: t, updated_at: t, live_at: null }
      store.data.profiles.push(p)
    } else Object.assign(p, { display_name, bio, logo_url, link, updated_at: t })
    // Complete profiles go public; the forum reviews a new community first.
    if (p.live_at === null) p.live_at = t + s.review_minutes * 60_000 * scale
    store.save()
    const live = isLive(s, p)
    return { code: 200, json: { ok: true, status: live ? 'live' : 'pending_review', profile_url: pageUrl(s, p.handle), message: live ? `Your ${s.noun} is public.` : `Your ${s.noun} is in review and goes public in about ${s.review_minutes} minutes (x time scale).` } }
  }

  // ---- catalog and pages ----
  sb.get('/saas.json', async () => ({
    count: SERVICES.length,
    time_scale: scale,
    note: 'Sandbox Web fixtures: fake SaaS products. One account per service, an email verification, then a profile.',
    services: SERVICES.map((s) => ({
      slug: s.slug,
      name: s.name,
      kind: s.kind,
      tagline: s.tagline,
      url: svcUrl(s),
      signup_endpoint: `${svcUrl(s)}/api/signup`,
      login_endpoint: `${svcUrl(s)}/api/login`,
      profile_endpoint: `${svcUrl(s)}/api/profile`,
      public_page: `${svcUrl(s)}/${s.prefix}/<handle>`,
      host: host(s),
      signup_fields: { required: ['email', 'password', 'handle'], optional: ['display_name'] },
      profile_fields: { required: ['display_name', 'bio', 'logo_url', 'link'] },
      limits: s.limits,
      handle_rules: { length: s.handle, pattern: 'lower-case letters, digits, hyphens' },
      password_policy: policyText(s),
      requirements: ['email verification', ...(s.review_minutes ? [`profile review (about ${s.review_minutes} min)`] : [])],
    })),
  }))

  sb.get('/saas', async (_req, reply) =>
    html(reply, 200, shell({
      title: 'Sandbox SaaS',
      css: '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.g a{background:#fff;border:1px solid #e1e4e9;border-radius:10px;padding:14px;text-decoration:none}.g small{display:block;color:#6b7482}',
      body: `<div class="wrap"><h1>${SERVICES.length} sandbox SaaS products</h1><p>Machine-readable: <a href="/sandbox/saas.json">/sandbox/saas.json</a></p><div class="g">${SERVICES.map((s) => `<a href="/sandbox/saas/${s.slug}"><b style="color:hsl(${s.hue} 60% 38%)">${esc(s.name)}</b><small>${esc(s.tagline)}</small></a>`).join('')}</div></div>`,
    })))

  const css = (s: Service) => `body{background:hsl(${s.hue} 30% 97%)}.hd{background:hsl(${s.hue} 62% 38%);color:#fff;padding:26px 20px}.hd .in{max-width:880px;margin:0 auto;display:flex;gap:14px;align-items:center}.hd h1{margin:0;font-size:24px}.hd a{color:#fff;text-decoration:none}.hd p{margin:2px 0 0;opacity:.9}
.panel{background:#fff;border:1px solid hsl(${s.hue} 20% 88%);border-radius:10px;padding:22px}.btn{display:inline-block;background:hsl(${s.hue} 62% 38%);color:#fff;border:0;padding:10px 18px;border-radius:8px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}
label{display:block;font-weight:650;margin:14px 0 4px;font-size:14px}input,textarea{width:100%;padding:9px 10px;border:1px solid hsl(${s.hue} 20% 82%);border-radius:6px;font:inherit}.note{font-size:13px;opacity:.75}.err{color:#c0392b}.ok{color:#1d7a46}
.logo{width:72px;height:72px;border-radius:14px;object-fit:cover;background:hsl(${s.hue} 30% 90%);float:right;margin-left:14px}.stat{display:inline-block;margin:6px 14px 0 0;font-size:13px}.stat b{display:block;font-size:20px}.pill{display:inline-block;background:hsl(${s.hue} 40% 92%);border-radius:20px;padding:2px 12px;font-size:13px;margin-right:6px}`
  const page = (s: Service, title: string, inner: string) =>
    shell({ title: `${title} · ${s.name}`, css: css(s), body: `<div class="hd"><div class="in"><div style="font-size:30px;font-weight:800">${esc(s.name.slice(0, 1))}</div><div><h1><a href="/sandbox/saas/${s.slug}">${esc(s.name)}</a></h1><p>${esc(s.tagline)}</p></div></div></div><div class="wrap">${inner}<div class="foot note" style="margin-top:30px">${esc(s.name)} is a Sandbox Web fixture, not a real product. Nothing here reaches the real internet.</div></div>` })

  sb.get('/saas/:slug', async (req, reply) => {
    const s = bySlug.get((req.params as { slug: string }).slug)
    if (!s) return missing(reply, 'No such service')
    return html(reply, 200, page(s, 'Home', `<div class="panel"><h2>${esc(s.tagline)}</h2><p>Create a free account to set up your ${esc(s.noun)}.</p><p><a class="btn" href="/sandbox/saas/${s.slug}/signup">Sign up</a> &nbsp; <a href="/sandbox/saas/${s.slug}/login">Log in</a></p><p class="note">Handles: ${s.handle[0]}-${s.handle[1]} characters. Passwords: ${esc(policyText(s))}.</p></div>`))
  })

  const form = (s: Service, kind: 'signup' | 'login', values: Record<string, unknown> = {}, error = '') => {
    const f = (k: string, label: string, type = 'text') => `<label for="${k}">${label}</label><input id="${k}" name="${k}" type="${type}" value="${k === 'password' ? '' : esc(values[k])}">`
    return `<div class="panel"><h2>${kind === 'signup' ? `Create your ${esc(s.name)} account` : `Log in to ${esc(s.name)}`}</h2>${error ? `<p class="err">${esc(error)}</p>` : ''}<form method="post" action="/sandbox/saas/${s.slug}/${kind}">${f('email', 'Email', 'email')}${kind === 'signup' ? f('handle', 'Handle') + f('display_name', 'Your name (optional)') : ''}${f('password', 'Password', 'password')}${kind === 'signup' ? `<p class="note">${esc(policyText(s))}.</p>` : ''}<p><button class="btn" type="submit">${kind === 'signup' ? 'Sign up' : 'Log in'}</button></p></form></div>`
  }
  const profileForm = (s: Service, p: Profile | undefined, errors: Record<string, string> = {}) => {
    const f = (k: keyof Profile, label: string, area = false) => `<label for="${k}">${label}</label>${area ? `<textarea id="${k}" name="${k}" rows="4">${esc(p?.[k])}</textarea>` : `<input id="${k}" name="${k}" value="${esc(p?.[k])}">`}${errors[k] ? `<div class="err note">${esc(errors[k])}</div>` : ''}`
    return `<div class="panel"><h2>Set up your ${esc(s.noun)}</h2><form method="post" action="/sandbox/saas/${s.slug}/profile">${f('display_name', `Name (max ${s.limits.display_name})`)}${f('bio', `Bio (max ${s.limits.bio})`, true)}${f('logo_url', 'Logo URL')}${f('link', 'Website link')}<p><button class="btn" type="submit">Save and publish</button></p></form></div>`
  }

  for (const kind of ['signup', 'login'] as const) {
    sb.get(`/saas/:slug/${kind}`, async (req, reply) => {
      const s = bySlug.get((req.params as { slug: string }).slug)
      return s ? html(reply, 200, page(s, kind === 'signup' ? 'Sign up' : 'Log in', form(s, kind))) : missing(reply, 'No such service')
    })
    sb.post(`/saas/:slug/api/${kind}`, async (req, reply) => {
      const s = bySlug.get((req.params as { slug: string }).slug)
      if (!s) return missing(reply, 'No such service', true)
      const body = (req.body ?? {}) as Record<string, unknown>
      const res = kind === 'signup' ? signup(s, body) : accounts.login(site(s), body)
      for (const [k, v] of Object.entries((res as { headers?: Record<string, string> }).headers ?? {})) reply.header(k, v)
      return reply.code(res.code).send(res.json)
    })
    sb.post(`/saas/:slug/${kind}`, async (req, reply) => {
      const s = bySlug.get((req.params as { slug: string }).slug)
      if (!s) return missing(reply, 'No such service')
      const body = (req.body ?? {}) as Record<string, unknown>
      const res = kind === 'signup' ? signup(s, body) : accounts.login(site(s), body)
      if (kind === 'login' && res.code === 200) {
        reply.header('set-cookie', `${cookie(s)}=${String(res.json.session_token)}; Path=/sandbox/saas/${s.slug}; HttpOnly; SameSite=Lax`)
        return reply.redirect(`/sandbox/saas/${s.slug}/profile`)
      }
      if (res.code >= 400) return html(reply, res.code, page(s, kind === 'signup' ? 'Sign up' : 'Log in', form(s, kind, body, String(res.json.message ?? res.json.error))))
      return html(reply, res.code, page(s, 'Check your inbox', `<div class="panel"><h2 class="ok">Almost there</h2><p>${esc(res.json.message)}</p></div>`))
    })
  }

  sb.get('/saas/:slug/account/verify/:token', async (req, reply) => {
    const { slug, token } = req.params as { slug: string; token: string }
    const s = bySlug.get(slug)
    const a = s && accounts.verify(`saas:${slug}`, token)
    if (!s || !a) return missing(reply, 'This verification link is invalid.')
    return html(reply, 200, page(s, 'Verified', `<div class="panel"><h2 class="ok">Email verified</h2><p>Your ${esc(s.name)} account is active.</p><p><a class="btn" href="/sandbox/saas/${s.slug}/login">Log in</a></p></div>`))
  })

  const me = (s: Service, req: { headers: Record<string, unknown> }) => accounts.session(`saas:${s.slug}`, sessionToken(req, cookie(s)))

  sb.get('/saas/:slug/profile', async (req, reply) => {
    const s = bySlug.get((req.params as { slug: string }).slug)
    if (!s) return missing(reply, 'No such service')
    const a = me(s, req)
    if (!a) return html(reply, 401, page(s, 'Profile', `<div class="panel"><p>Log in to edit your ${esc(s.noun)}.</p><p><a class="btn" href="/sandbox/saas/${s.slug}/login">Log in</a></p></div>`))
    return html(reply, 200, page(s, 'Profile', profileForm(s, profileOf(s, a.id))))
  })
  sb.post('/saas/:slug/profile', async (req, reply) => {
    const s = bySlug.get((req.params as { slug: string }).slug)
    if (!s) return missing(reply, 'No such service')
    const a = me(s, req)
    if (!a) return html(reply, 401, page(s, 'Profile', '<div class="panel"><p>Log in first.</p></div>'))
    const res = putProfile(s, a.id, (req.body ?? {}) as Record<string, unknown>)
    if (res.code !== 200) return html(reply, res.code, page(s, 'Profile', profileForm(s, { ...(profileOf(s, a.id) ?? ({} as Profile)), ...((req.body ?? {}) as Partial<Profile>) } as Profile, (res.json as { errors: Record<string, string> }).errors)))
    return html(reply, 200, page(s, 'Saved', `<div class="panel"><h2 class="ok">Saved</h2><p>${esc(res.json.message)}</p><p><a href="${esc(res.json.profile_url)}">View your public ${esc(s.noun)}</a></p></div>`))
  })
  sb.put('/saas/:slug/api/profile', async (req, reply) => {
    const s = bySlug.get((req.params as { slug: string }).slug)
    if (!s) return missing(reply, 'No such service', true)
    const a = me(s, req)
    if (!a) return reply.code(401).header('www-authenticate', 'Bearer realm="sandbox saas account"').send({ error: 'auth_required', message: 'Log in and send the session token as a Bearer token.' })
    const res = putProfile(s, a.id, (req.body ?? {}) as Record<string, unknown>)
    return reply.code(res.code).send(res.json)
  })
  sb.get('/saas/:slug/api/profile', async (req, reply) => {
    const s = bySlug.get((req.params as { slug: string }).slug)
    if (!s) return missing(reply, 'No such service', true)
    const a = me(s, req)
    if (!a) return reply.code(401).send({ error: 'auth_required' })
    const p = profileOf(s, a.id)
    return { handle: a.handle, profile: p ? { display_name: p.display_name, bio: p.bio, logo_url: p.logo_url, link: p.link, status: isLive(s, p) ? 'live' : 'pending_review', profile_url: pageUrl(s, p.handle) } : null }
  })

  // ---- the public page ----
  const publicProfile = (slug: string, handle: string) => {
    const s = bySlug.get(slug)
    const p = s && byHandle(s, handle)
    return s && p && isLive(s, p) ? { s, p } : null
  }
  const linkHost = (u: string) => {
    try {
      return new URL(u).host.replace(/^www\./, '')
    } catch {
      return u
    }
  }
  const extras = (s: Service, p: Profile): string => {
    switch (s.kind) {
      case 'analytics':
        return `<p><span class="stat"><b>0</b>visitors today</span><span class="stat"><b>0</b>page views</span><span class="stat"><b>-</b>top page</span></p><p class="note">Public dashboard for ${esc(p.display_name)}. Tracking snippet not installed yet.</p>`
      case 'newsletter':
        return `<p><span class="pill">0 subscribers</span><span class="pill">0 issues</span></p><p><a class="btn" href="#">Subscribe</a></p>`
      case 'social':
        return `<p><span class="stat"><b>0</b>posts</span><span class="stat"><b>0</b>followers</span><span class="stat"><b>0</b>following</span></p>`
      case 'status':
        return `<p><b class="ok">All systems operational</b></p><p><span class="pill">Website</span><span class="pill">API</span><span class="pill">Dashboard</span></p><p class="note">No incidents reported.</p>`
      case 'forum':
        return `<p><span class="pill">General</span><span class="pill">Announcements</span><span class="pill">Feedback</span></p><p class="note">Welcome to the ${esc(p.display_name)} community. Be kind.</p>`
    }
  }
  sb.get('/saas/:slug/:prefix/:handle', async (req, reply) => {
    const { slug, prefix, handle } = req.params as { slug: string; prefix: string; handle: string }
    const hit = publicProfile(slug, handle)
    if (!hit || hit.s.prefix !== prefix) return missing(reply, 'This page does not exist or is not public yet.')
    const { s, p } = hit
    return html(reply, 200, page(s, p.display_name, `<article class="panel"><img class="logo" src="${esc(p.logo_url)}" alt="" onerror="this.remove()"><h2 style="margin-top:0">${esc(p.display_name)}</h2><p class="note">${esc(s.noun)} · @${esc(p.handle)}</p><p style="font-size:16px">${esc(p.bio)}</p><p>Website: <a rel="nofollow noopener" href="${esc(p.link)}">${esc(linkHost(p.link))}</a></p>${extras(s, p)}<p class="note"><a href="${esc(pageUrl(s, p.handle))}/snapshot">rendered snapshot (SVG)</a></p></article>`))
  })
  sb.get('/saas/:slug/:prefix/:handle/snapshot', async (req, reply) => {
    const { slug, prefix, handle } = req.params as { slug: string; prefix: string; handle: string }
    const hit = publicProfile(slug, handle)
    if (!hit || hit.s.prefix !== prefix) return missing(reply, 'This page does not exist or is not public yet.', true)
    const { s, p } = hit
    const accent = `hsl(${s.hue} 62% 38%)`
    const lines = wrap(p.bio, 70, 5).map((l, i) => `<text x="70" y="${300 + i * 30}" font-size="22" fill="#1c1f26" opacity=".85">${esc(l)}</text>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620" font-family="Segoe UI,Arial,sans-serif"><rect width="1200" height="620" fill="#fff"/><rect width="1200" height="44" fill="#e5e7eb"/><circle cx="24" cy="22" r="7" fill="#f87171"/><circle cx="46" cy="22" r="7" fill="#fbbf24"/><circle cx="68" cy="22" r="7" fill="#34d399"/><rect x="100" y="9" width="900" height="26" rx="13" fill="#fff"/><text x="116" y="27" font-size="14" fill="#374151">${esc(pageUrl(s, p.handle))}</text><rect y="44" width="1200" height="100" fill="${accent}"/><text x="70" y="106" font-size="36" font-weight="700" fill="#fff">${esc(s.name)}</text><text x="70" y="206" font-size="24" fill="#59626f">${esc(s.noun)} · @${esc(p.handle)}</text><text x="70" y="262" font-size="44" font-weight="700" fill="#1c1f26">${esc(p.display_name.slice(0, 40))}</text>${lines}<text x="70" y="480" font-size="20" fill="${accent}">${esc(linkHost(p.link))}</text><rect y="580" width="1200" height="40" fill="#14161b"/><text x="20" y="605" font-size="15" fill="#e8d9a8" font-family="Consolas,monospace">rendered snapshot · Sandbox Web fixture, not a real site · ${esc(new Date(clock()).toISOString())}</text></svg>`
    return reply.type('image/svg+xml').send(svg)
  })
}
