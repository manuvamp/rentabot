// 48 fake AI/SaaS/startup/MCP directories, each with one real-world behaviour.
//
// Behaviour mix (fixed counts, seed only shuffles who gets what):
//   passes for a reasonable bot : instant 12, email_confirm 8, moderation_delay 7, flaky_503 4   = 31
//   fails for a reasonable bot  : moderation_reject 3, rewrite_name 3, removed_later 3          =  9
//   declared refusals (skipped) : paid_only 4, human_verification 4                            =  8
// A bot that skips the 8 declared refusals submits to exactly 40 directories and, once moderation and
// removals have settled (> 50 nominal minutes x timeScale), 31 of them pass url_live + page_mentions.
// Orthogonal to that mix, 14 of the free directories (never the email_confirm, paid or captcha ones) want an account first:
// a signup, a verification email to the given inbox, the link, a login, and only then the listing form.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { type AccountSite, type Accounts, ensureFormParser, sessionToken } from './accounts.ts'
import { between, hash32, hex, pick, rng, shuffle } from './rng.ts'
import type { Mail } from './mail.ts'
import type { Clock, Store, Submission } from './state.ts'
import { esc, isoUtc, shell, wrap } from './ui.ts'

export type Behavior =
  | 'instant'
  | 'email_confirm'
  | 'moderation_delay'
  | 'moderation_reject'
  | 'human_verification'
  | 'paid_only'
  | 'rewrite_name'
  | 'removed_later'
  | 'flaky_503'

const MIX: [Behavior, number][] = [
  ['instant', 12],
  ['email_confirm', 8],
  ['moderation_delay', 7],
  ['flaky_503', 4],
  ['moderation_reject', 3],
  ['rewrite_name', 3],
  ['removed_later', 3],
  ['paid_only', 4],
  ['human_verification', 4],
]

const NAMES = [
  'ToolHatch', 'AgentAtlas', 'LaunchLedger', 'PromptPier', 'StackSprout', 'ServerShelf', 'ShipShelf', 'NovaIndex',
  'BotBazaar', 'DevDrawer', 'SaaSHarbor', 'PixelPantry', 'ModelMile', 'FounderFeed', 'BetaBarn', 'LaunchLantern',
  'AgentArcade', 'ToolTrellis', 'ProductPulse', 'StartupStash', 'IndieIgloo', 'PluginPort', 'AIAlmanac', 'CopilotCorner',
  'ByteBoutique', 'GrowthGarage', 'KitKiln', 'WidgetWharf', 'StackStreet', 'SignalShelf', 'MakerMeadow', 'OpenOrbit',
  'RelayRoster', 'DemoDock', 'VectorVille', 'PromptPantry', 'BuilderBoard', 'LaunchLoft', 'AutomatonAisle', 'NimbusNook',
  'ToolTide', 'SiloSaaS', 'ScoutSpot', 'PatchPlaza', 'AgentAlley', 'MeshMesa', 'GadgetGlade', 'RocketRegistry',
]

const FOCUS = ['AI tools', 'SaaS products', 'startups', 'MCP servers', 'developer tools', 'AI agents']
const CATEGORY_POOL = ['AI Tools', 'Agents', 'MCP Servers', 'Developer Tools', 'SaaS', 'Productivity', 'Marketing', 'Startups', 'Design', 'Analytics', 'Security', 'Fintech']
const TAGLINES = [
  'The curated shelf for {f}.',
  'Discover {f} before everyone else does.',
  'Hand-picked {f}, updated daily.',
  'Where makers list their {f}.',
  'A friendly index of {f}.',
  'Launch your {f} to an audience that clicks.',
]
const FONTS = [
  'system-ui,-apple-system,"Segoe UI",sans-serif',
  'Georgia,"Times New Roman",serif',
  'ui-monospace,Consolas,"Courier New",monospace',
  '"Trebuchet MS","Segoe UI",sans-serif',
  'Palatino,"Palatino Linotype",serif',
]
const REWRITES = ['Smart Assistant', 'AI Productivity Suite', 'Workflow Helper', 'Business Toolkit', 'Growth Platform', 'Automation Hub', 'Team Companion', 'Insight Engine']

export interface Directory {
  slug: string
  name: string
  tagline: string
  focus: string
  categories: string[]
  behavior: Behavior
  theme: { hue: number; font: string; radius: number; dark: boolean; grid: boolean }
  /** Nominal minutes (x timeScale for real time). */
  review_minutes: number
  removal_minutes: number
  price_usd: number
  /** Listings need a verified account (signup, verification email, login). */
  needs_account: boolean
}

const ACCOUNT_BEHAVIORS: Behavior[] = ['instant', 'moderation_delay', 'moderation_reject', 'rewrite_name', 'removed_later', 'flaky_503']
const ACCOUNT_DIRECTORIES = 14

export function buildDirectories(seed: string): Directory[] {
  const r = rng(`${seed}:dirs`)
  const behaviors = shuffle(r, MIX.flatMap(([b, n]) => Array<Behavior>(n).fill(b)))
  // Which directories ask for an account: its own stream, so the behaviours and looks above never change.
  const ra = rng(`${seed}:accounts`)
  const withAccount = new Set(shuffle(ra, NAMES.map((_, i) => i).filter((i) => ACCOUNT_BEHAVIORS.includes(behaviors[i]!))).slice(0, ACCOUNT_DIRECTORIES))
  return NAMES.map((name, i) => {
    const focus = pick(r, FOCUS)
    const cats = shuffle(r, CATEGORY_POOL).slice(0, between(r, 3, 5))
    return {
      slug: name.toLowerCase(),
      name,
      tagline: pick(r, TAGLINES).replace('{f}', focus),
      focus,
      categories: cats,
      behavior: behaviors[i]!,
      theme: { hue: between(r, 0, 359), font: pick(r, FONTS), radius: pick(r, [2, 6, 10, 16]), dark: r() < 0.25, grid: r() < 0.5 },
      review_minutes: between(r, 5, 19), // moderation outcome arrives 5-19 nominal minutes after submit
      removal_minutes: between(r, 30, 49), // removed_later listings vanish 30-49 nominal minutes after going live
      price_usd: pick(r, [19, 29, 49, 79]),
      needs_account: withAccount.has(i),
    }
  })
}

/** Requirements a directory is honest about. Name rewriting, removal and flakiness stay hidden. */
export function declared(d: Directory): { requirements: string[]; pricing: 'free' | 'paid'; price_usd: number | null; human_verification: boolean; account_required: boolean } {
  const requirements: string[] = []
  if (d.needs_account) requirements.push('account required (email-verified)')
  if (d.behavior === 'email_confirm') requirements.push('email verification')
  if (d.behavior === 'moderation_delay' || d.behavior === 'moderation_reject') requirements.push('editorial review (up to ~20 min)')
  if (d.behavior === 'paid_only') requirements.push(`paid listing ($${d.price_usd})`)
  if (d.behavior === 'human_verification') requirements.push('human verification (captcha)')
  return {
    requirements,
    pricing: d.behavior === 'paid_only' ? 'paid' : 'free',
    price_usd: d.behavior === 'paid_only' ? d.price_usd : null,
    human_verification: d.behavior === 'human_verification',
    account_required: d.needs_account,
  }
}

export type Phase = 'pending_email_verification' | 'pending_review' | 'live' | 'rejected' | 'removed'

export function phaseOf(d: Directory, s: Submission, t: number, scale: number): Phase {
  const min = (m: number) => m * 60_000 * scale
  let liveAt: number | null
  switch (d.behavior) {
    case 'email_confirm':
      liveAt = s.verified_at
      break
    case 'moderation_delay':
      liveAt = s.created_at + min(d.review_minutes)
      break
    case 'moderation_reject':
      return t >= s.created_at + min(d.review_minutes) ? 'rejected' : 'pending_review'
    default:
      liveAt = s.created_at
  }
  if (liveAt === null) return 'pending_email_verification'
  if (t < liveAt) return 'pending_review'
  if (d.behavior === 'removed_later' && t >= liveAt + min(d.removal_minutes)) return 'removed'
  return 'live'
}

/** What the listing page actually shows (name rewriting directories publish something else). */
const shown = (d: Directory, s: Submission) =>
  d.behavior === 'rewrite_name' && s.rewritten ? s.rewritten : { name: s.name, tagline: s.tagline, description: s.description }

// ---------- validation ----------

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const isHttpUrl = (u: string) => {
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

interface Parsed {
  value?: Pick<Submission, 'name' | 'url' | 'tagline' | 'description' | 'category' | 'contact_email' | 'logo_url' | 'screenshot_url'>
  errors: Record<string, string>
}

function parse(body: Record<string, unknown>): Parsed {
  const errors: Record<string, string> = {}
  const name = str(body.name)
  const url = str(body.url)
  const tagline = str(body.tagline)
  const description = str(body.description)
  const category = str(body.category)
  const contact_email = str(body.contact_email).toLowerCase()
  const logo = str(body.logo_url)
  const shotRaw = body.screenshot_url ?? (Array.isArray(body.screenshot_urls) ? body.screenshot_urls[0] : '')
  const shot = str(shotRaw)
  if (name.length < 2 || name.length > 80) errors.name = 'name is required (2-80 chars)'
  if (!isHttpUrl(url) || url.length > 500) errors.url = 'url must be an http(s) URL'
  if (!tagline || tagline.length > 140) errors.tagline = 'tagline is required (max 140 chars)'
  if (!description || description.length > 2000) errors.description = 'description is required (max 2000 chars)'
  if (!category || category.length > 60) errors.category = 'category is required'
  if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z][a-z0-9-]*$/i.test(contact_email)) errors.contact_email = 'contact_email must be an email address'
  if (logo && !isHttpUrl(logo)) errors.logo_url = 'logo_url must be an http(s) URL'
  if (shot && !isHttpUrl(shot)) errors.screenshot_url = 'screenshot_url must be an http(s) URL'
  if (Object.keys(errors).length) return { errors }
  return { errors, value: { name, url, tagline, description, category, contact_email, logo_url: logo || null, screenshot_url: shot || null } }
}

// ---------- HTML ----------

function themeCss(d: Directory): string {
  const { hue, font, radius, dark, grid } = d.theme
  const bg = dark ? '#14161b' : `hsl(${hue} 30% 97%)`
  const ink = dark ? '#eceef2' : '#1c1f26'
  const card = dark ? '#1e2128' : '#fff'
  const line = dark ? '#2c3039' : `hsl(${hue} 20% 88%)`
  const accent = `hsl(${hue} 68% ${dark ? 62 : 42}%)`
  return `body{background:${bg};color:${ink};font-family:${font}}
.hd{background:${accent};color:#fff;padding:34px 20px}.hd .in{max-width:960px;margin:0 auto;display:flex;gap:16px;align-items:center}
.mono{width:54px;height:54px;border-radius:${radius}px;background:#fff;color:${accent};display:grid;place-items:center;font-weight:800;font-size:22px}
.hd h1{margin:0;font-size:28px}.hd p{margin:2px 0 0;opacity:.92}
.btn{display:inline-block;background:${accent};color:#fff;border:0;padding:10px 18px;border-radius:${radius}px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}
.hd .btn{background:#fff;color:${accent};margin-left:auto}
.cards{display:${grid ? 'grid' : 'block'};grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
.card{display:block;background:${card};border:1px solid ${line};border-radius:${radius}px;padding:16px;margin-bottom:${grid ? 0 : 12}px;text-decoration:none}
.card b{font-size:17px;color:${accent}}.card span{display:block;opacity:.8;font-size:14px}.chip{display:inline-block;font-size:12px;border:1px solid ${line};border-radius:20px;padding:1px 10px;margin-top:8px;opacity:.85}
.panel{background:${card};border:1px solid ${line};border-radius:${radius}px;padding:22px}
label{display:block;font-weight:650;margin:14px 0 4px;font-size:14px}input,textarea,select{width:100%;padding:9px 10px;border:1px solid ${line};border-radius:${Math.min(radius, 8)}px;font:inherit;background:${dark ? '#14161b' : '#fff'};color:inherit}
.note{font-size:13px;opacity:.75}.err{color:#c0392b}.ok{color:#1d7a46}.foot{margin-top:34px;font-size:12px;opacity:.6}
.cap{border:1px dashed ${line};border-radius:${radius}px;padding:12px;margin-top:14px;background:${dark ? '#191c22' : '#fafafa'}}
.cap i{display:inline-block;width:46px;height:46px;border:1px solid ${line};margin:2px;background:${dark ? '#262a33' : '#eee'}}`
}

const mono = (d: Directory) => d.name.slice(0, 2)

function dirPage(d: Directory, title: string, inner: string): string {
  return shell({
    title: `${title} · ${d.name}`,
    css: themeCss(d),
    body: `<div class="hd"><div class="in"><div class="mono">${esc(mono(d))}</div><div><h1><a href="/sandbox/dirs/${d.slug}" style="text-decoration:none">${esc(d.name)}</a></h1><p>${esc(d.tagline)}</p></div><a class="btn" href="/sandbox/dirs/${d.slug}/submit">Submit your product</a></div></div>
<div class="wrap">${inner}<div class="foot">${esc(d.name)} is a Sandbox Web fixture, not a real directory. Nothing here reaches the real internet.</div></div>`,
  })
}

function policyNotes(d: Directory): string {
  const items = declared(d).requirements
  return items.length ? `<p class="note">Submission policy: ${items.map(esc).join(' · ')}.</p>` : `<p class="note">Free to list.</p>`
}

// ---------- routes ----------

export interface DirContext {
  dirs: Directory[]
  store: Store
  mail: Mail
  accounts: Accounts
  clock: Clock
  scale: number
  publicUrl: string
}

// Real directories print the product's domain on the listing. Editorial rewrites drop the brand
// entirely (domain included), so those listings still fail a page_mentions check honestly.
const websiteLine = (d: { behavior: string }, url: string) => {
  if (d.behavior === 'rewrite_name') return ''
  let host = url
  try {
    host = new URL(url).host.replace(/^www\./, '')
  } catch {
    /* keep the raw string */
  }
  return `<span class="note">Website: ${esc(host)}</span> `
}

export function registerDirectoryRoutes(sb: FastifyInstance, ctx: DirContext): void {
  const { dirs, store, mail, clock, scale, accounts } = ctx
  const bySlug = new Map(dirs.map((d) => [d.slug, d]))
  const base = ctx.publicUrl.replace(/\/+$/, '')
  const dirUrl = (d: Directory) => `${base}/sandbox/dirs/${d.slug}`
  const listingUrl = (d: Directory, id: string) => `${dirUrl(d)}/listing/${id}`
  const subsOf = (d: Directory) => store.data.submissions.filter((s) => s.slug === d.slug)
  const phase = (d: Directory, s: Submission) => phaseOf(d, s, clock(), scale)
  const html = (reply: FastifyReply, code: number, body: string) => reply.code(code).type('text/html').send(body)
  const missing = (reply: FastifyReply, what: string, json = false) =>
    json ? reply.code(404).send({ error: 'not_found', message: what }) : html(reply, 404, shell({ title: 'Not found', body: `<div class="wrap"><h1>404</h1><p>${esc(what)}</p></div>` }))

  // Form posts (the HTML forms) arrive urlencoded.
  ensureFormParser(sb)

  // ---- accounts (directories with needs_account) ----
  const siteOf = (d: Directory): AccountSite => ({
    scope: `dir:${d.slug}`,
    name: d.name,
    host: `${d.slug}.dirs.sandbox`,
    verifyUrl: (t) => `${dirUrl(d)}/account/verify/${t}`,
    minPassword: 12,
  })
  const cookieName = (d: Directory) => `sbx_${d.slug}`
  const accountOf = (d: Directory, req: { headers: Record<string, unknown> }) => accounts.session(`dir:${d.slug}`, sessionToken(req, cookieName(d)))

  /** The whole submission pipeline; the JSON API and the HTML form both use it. */
  function submit(d: Directory, body: Record<string, unknown>, accountId: string | null = null): { code: number; json: Record<string, unknown>; headers?: Record<string, string> } {
    if (d.behavior === 'human_verification')
      return { code: 403, json: { error: 'human_verification_required', message: `${d.name} requires human verification (captcha) and refuses automated submissions. Skip this directory or have a person submit it.` } }
    if (d.behavior === 'paid_only')
      return { code: 402, json: { error: 'payment_required', price_usd: d.price_usd, message: `${d.name} only lists paid submissions ($${d.price_usd}). Free submissions are not accepted.` } }
    if (d.needs_account && !accountId)
      return {
        code: 401,
        headers: { 'www-authenticate': 'Bearer realm="sandbox directory account"' },
        json: { error: 'account_required', message: `${d.name} only takes listings from a verified account. Sign up, verify your email, log in, then submit with the session token.`, signup_endpoint: `${dirUrl(d)}/api/signup`, login_endpoint: `${dirUrl(d)}/api/login`, signup_form: `${dirUrl(d)}/signup` },
      }
    if (d.behavior === 'flaky_503') {
      const key = `${d.slug}|${str(body.url)}`
      const n = store.data.attempts[key] ?? 0
      store.data.attempts[key] = n + 1
      store.save()
      if (n === 0) return { code: 503, headers: { 'retry-after': '2' }, json: { error: 'service_unavailable', message: 'Temporarily overloaded. Retry in a few seconds.', retry_after_seconds: 2 } }
    }
    const p = parse(body)
    if (!p.value) return { code: 400, json: { error: 'invalid_request', errors: p.errors, accepted_categories: d.categories } }
    const dupe = subsOf(d).find((s) => s.url.replace(/\/+$/, '') === p.value!.url.replace(/\/+$/, ''))
    if (dupe) {
      // Like most real directory APIs, a duplicate points at the existing submission and its current status.
      return {
        code: 409,
        json: { error: 'duplicate', message: 'This product URL was already submitted.', submission_id: dupe.id, status: phase(d, dupe), listing_url: listingUrl(d, dupe.id), receipt_url: `${dirUrl(d)}/api/submissions/${dupe.id}` },
      }
    }

    const t = clock()
    const seq = ++store.data.seq
    const id = `p${String(seq).padStart(4, '0')}${hex(hash32(`${store.data.seed}:${d.slug}:${seq}`), 4)}`
    const sub: Submission = {
      id,
      slug: d.slug,
      created_at: t,
      ...p.value,
      category: d.categories.includes(p.value.category) ? p.value.category : 'Other',
      token: d.behavior === 'email_confirm' ? hex(hash32(`${store.data.seed}:${id}`)) + hex(hash32(`${id}:${d.slug}`)) : null,
      verified_at: null,
      account_id: accountId,
      rewritten: d.behavior === 'rewrite_name' ? { name: REWRITES[hash32(id) % REWRITES.length]!, tagline: 'A modern solution for busy teams.', description: 'A powerful platform that helps teams do more with less. Listing curated by our editorial team.' } : null,
    }
    store.data.submissions.push(sub)
    store.save()

    const from = `noreply@${d.slug}.dirs.sandbox`
    const review = t + d.review_minutes * 60_000 * scale
    let status: Phase = 'live'
    let message = 'Your listing is live.'
    if (d.behavior === 'email_confirm') {
      status = 'pending_email_verification'
      message = `We sent a confirmation link to ${sub.contact_email}. The listing goes live once you open it.`
      mail.deliverSystem({
        from,
        to: sub.contact_email,
        subject: `Confirm your ${d.name} listing for ${sub.name}`,
        text: `Hi,\n\nPlease confirm that you submitted ${sub.name} to ${d.name}.\n\nConfirm your listing: ${dirUrl(d)}/verify/${sub.token}\n\nIf this wasn't you, ignore this email.\n\n${d.name} (Sandbox Web fixture)`,
      })
    } else if (d.behavior === 'moderation_delay' || d.behavior === 'moderation_reject') {
      status = 'pending_review'
      message = `Submission received. Our editors review listings within about ${d.review_minutes} minutes (x time scale).`
      const ok = d.behavior === 'moderation_delay'
      mail.deliverSystem({
        from,
        to: sub.contact_email,
        at: review,
        subject: ok ? `${sub.name} is now listed on ${d.name}` : `Your ${d.name} submission was not approved`,
        text: ok
          ? `Good news: ${sub.name} passed review and is live at ${listingUrl(d, id)}.\n\n${d.name} (Sandbox Web fixture)`
          : `Thanks for submitting ${sub.name}. After review we decided not to list it (it does not meet our editorial guidelines).\n\n${d.name} (Sandbox Web fixture)`,
      })
    }
    return {
      code: status === 'live' ? 201 : 202,
      json: {
        ok: true,
        submission_id: id,
        status,
        message,
        listing_url: listingUrl(d, id),
        receipt_url: `${dirUrl(d)}/api/submissions/${id}`,
        ...(status === 'pending_review' ? { estimated_review_minutes: d.review_minutes } : {}),
      },
    }
  }

  // ---- catalog ----
  sb.get('/dirs.json', async () => ({
    count: dirs.length,
    time_scale: scale,
    note: 'Sandbox Web fixtures. Declared requirements only; real behaviour may differ, as on the real web.',
    directories: dirs.map((d) => ({
      slug: d.slug,
      name: d.name,
      url: dirUrl(d),
      tagline: d.tagline,
      focus: d.focus,
      categories: d.categories,
      submit_form: `${dirUrl(d)}/submit`,
      submit_endpoint: `${dirUrl(d)}/api/submit`,
      ...(d.needs_account
        ? {
            account: {
              required: true,
              signup_endpoint: `${dirUrl(d)}/api/signup`,
              verify: 'a link emailed to the account address',
              login_endpoint: `${dirUrl(d)}/api/login`,
              session: 'Authorization: Bearer <session_token> on submit_endpoint',
              password_policy: 'at least 12 characters with lower case, upper case, a digit and a symbol',
              signup_fields: { required: ['email', 'password'], optional: ['display_name'] },
            },
          }
        : {}),
      submit_fields: { required: ['name', 'url', 'tagline', 'description', 'category', 'contact_email'], optional: ['logo_url', 'screenshot_url'] },
      ...declared(d),
    })),
  }))

  sb.get('/dirs', async (_req, reply) =>
    html(reply, 200, shell({
      title: 'Sandbox directories',
      css: '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}.g a{background:#fff;border:1px solid #e1e4e9;border-radius:8px;padding:10px 12px;text-decoration:none}.g small{display:block;color:#6b7482}',
      body: `<div class="wrap"><h1>${dirs.length} sandbox directories</h1><p>Machine-readable: <a href="/sandbox/dirs.json">/sandbox/dirs.json</a></p><div class="g">${dirs.map((d) => `<a href="/sandbox/dirs/${d.slug}"><b>${esc(d.name)}</b><small>${esc(d.focus)}${declared(d).requirements.length ? ' · ' + esc(declared(d).requirements.join(', ')) : ''}</small></a>`).join('')}</div></div>`,
    })))

  // ---- per-directory pages ----
  sb.get('/dirs/:slug', async (req, reply) => {
    const d = bySlug.get((req.params as { slug: string }).slug)
    if (!d) return missing(reply, 'No such directory')
    const live = subsOf(d).filter((s) => phase(d, s) === 'live').sort((a, b) => b.created_at - a.created_at)
    const cards = live.map((s) => { const v = shown(d, s); return `<a class="card" href="/sandbox/dirs/${d.slug}/listing/${s.id}"><b>${esc(v.name)}</b><span>${esc(v.tagline)}</span><i class="chip">${esc(s.category)}</i></a>` }).join('')
    return html(reply, 200, dirPage(d, 'Home', `<h2>Approved products (${live.length})</h2>${policyNotes(d)}${live.length ? `<div class="cards">${cards}</div>` : '<p class="note">No products listed yet. Be the first.</p>'}`))
  })

  const formHtml = (d: Directory, values: Record<string, unknown> = {}, errors: Record<string, string> = {}) => {
    const f = (k: string, label: string, type = 'text', area = false) =>
      `<label for="${k}">${label}</label>${area ? `<textarea id="${k}" name="${k}" rows="4">${esc(values[k])}</textarea>` : `<input id="${k}" name="${k}" type="${type}" value="${esc(values[k])}">`}${errors[k] ? `<div class="err note">${esc(errors[k])}</div>` : ''}`
    const cap = d.behavior === 'human_verification' ? `<div class="cap"><b>Verify you are human</b><br>Select every square with a traffic light.<br><i></i><i></i><i></i><i></i><i></i><i></i></div>` : ''
    const fee = d.behavior === 'paid_only' ? `<p class="note"><b>Listing fee: $${d.price_usd}</b>, charged at checkout. Free submissions are not accepted.</p>` : ''
    return `<div class="panel"><h2>Submit your product to ${esc(d.name)}</h2>${policyNotes(d)}${fee}<form method="post" action="/sandbox/dirs/${d.slug}/submit">${f('name', 'Product name')}${f('url', 'Website URL', 'url')}${f('tagline', 'Tagline')}${f('description', 'Description', 'text', true)}
<label for="category">Category</label><select id="category" name="category">${d.categories.map((c) => `<option${values.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}<option>Other</option></select>
${f('contact_email', 'Contact email', 'email')}${f('logo_url', 'Logo URL (optional)', 'url')}${f('screenshot_url', 'Screenshot URL (optional)', 'url')}${cap}<p><button class="btn" type="submit">Submit</button></p></form></div>`
  }

  const gateHtml = (d: Directory) => `<div class="panel"><h2>Log in to submit</h2><p>${esc(d.name)} only takes listings from a verified account.</p><p><a class="btn" href="/sandbox/dirs/${d.slug}/login">Log in</a> &nbsp; <a href="/sandbox/dirs/${d.slug}/signup">Create an account</a></p></div>`

  sb.get('/dirs/:slug/submit', async (req, reply) => {
    const d = bySlug.get((req.params as { slug: string }).slug)
    if (!d) return missing(reply, 'No such directory')
    if (d.needs_account && !accountOf(d, req)) return html(reply, 401, dirPage(d, 'Submit', gateHtml(d)))
    return html(reply, 200, dirPage(d, 'Submit', formHtml(d)))
  })

  sb.post('/dirs/:slug/submit', async (req, reply) => {
    const d = bySlug.get((req.params as { slug: string }).slug)
    if (!d) return missing(reply, 'No such directory')
    const body = (req.body ?? {}) as Record<string, unknown>
    const res = submit(d, body, accountOf(d, req)?.id ?? null)
    for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v)
    if (res.code === 401) return html(reply, 401, dirPage(d, 'Submit', gateHtml(d)))
    const j = res.json as { ok?: boolean; message?: string; listing_url?: string; receipt_url?: string; errors?: Record<string, string> }
    if (res.code === 400) return html(reply, 400, dirPage(d, 'Submit', formHtml(d, body, j.errors)))
    const link = j.ok ? `<p><a href="${esc(j.listing_url)}">Your listing page</a> · <a href="${esc(j.receipt_url)}">Submission status (JSON)</a></p>` : ''
    return html(reply, res.code, dirPage(d, 'Submission', `<div class="panel"><h2 class="${j.ok ? 'ok' : 'err'}">${j.ok ? 'Submission received' : `Submission refused (${res.code})`}</h2><p>${esc(j.message)}</p>${link}</div>`))
  })

  sb.post('/dirs/:slug/api/submit', async (req, reply) => {
    const d = bySlug.get((req.params as { slug: string }).slug)
    if (!d) return missing(reply, 'No such directory', true)
    const res = submit(d, (req.body ?? {}) as Record<string, unknown>, accountOf(d, req)?.id ?? null)
    for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v)
    return reply.code(res.code).send(res.json)
  })

  // ---- account routes ----
  const accountDir = (slug: string) => {
    const d = bySlug.get(slug)
    return d && d.needs_account ? d : null
  }
  const authForm = (d: Directory, kind: 'signup' | 'login', values: Record<string, unknown> = {}, error = '') => {
    const f = (k: string, label: string, type = 'text') => `<label for="${k}">${label}</label><input id="${k}" name="${k}" type="${type}" value="${k === 'password' ? '' : esc(values[k])}" autocomplete="${k === 'password' ? (kind === 'signup' ? 'new-password' : 'current-password') : 'off'}">`
    return `<div class="panel"><h2>${kind === 'signup' ? `Create your ${esc(d.name)} account` : `Log in to ${esc(d.name)}`}</h2>${error ? `<p class="err">${esc(error)}</p>` : ''}<form method="post" action="/sandbox/dirs/${d.slug}/${kind}">${f('email', 'Email', 'email')}${kind === 'signup' ? f('display_name', 'Your name (optional)') : ''}${f('password', 'Password', 'password')}${kind === 'signup' ? '<p class="note">At least 12 characters with lower case, upper case, a digit and a symbol. We email a link to verify your address.</p>' : ''}<p><button class="btn" type="submit">${kind === 'signup' ? 'Sign up' : 'Log in'}</button></p></form><p class="note">${kind === 'signup' ? `Have an account? <a href="/sandbox/dirs/${d.slug}/login">Log in</a>` : `New here? <a href="/sandbox/dirs/${d.slug}/signup">Create an account</a>`}</p></div>`
  }
  for (const kind of ['signup', 'login'] as const) {
    sb.get(`/dirs/:slug/${kind}`, async (req, reply) => {
      const d = accountDir((req.params as { slug: string }).slug)
      return d ? html(reply, 200, dirPage(d, kind === 'signup' ? 'Sign up' : 'Log in', authForm(d, kind))) : missing(reply, 'This directory does not use accounts.')
    })
    sb.post(`/dirs/:slug/api/${kind}`, async (req, reply) => {
      const d = accountDir((req.params as { slug: string }).slug)
      if (!d) return missing(reply, 'This directory does not use accounts.', true)
      const res = kind === 'signup' ? accounts.signup(siteOf(d), (req.body ?? {}) as Record<string, unknown>) : accounts.login(siteOf(d), (req.body ?? {}) as Record<string, unknown>)
      return reply.code(res.code).send(res.json)
    })
    sb.post(`/dirs/:slug/${kind}`, async (req, reply) => {
      const d = accountDir((req.params as { slug: string }).slug)
      if (!d) return missing(reply, 'This directory does not use accounts.')
      const body = (req.body ?? {}) as Record<string, unknown>
      const res = kind === 'signup' ? accounts.signup(siteOf(d), body) : accounts.login(siteOf(d), body)
      if (kind === 'login' && res.code === 200) {
        reply.header('set-cookie', `${cookieName(d)}=${String(res.json.session_token)}; Path=/sandbox/dirs/${d.slug}; HttpOnly; SameSite=Lax`)
        return reply.redirect(`/sandbox/dirs/${d.slug}/submit`)
      }
      if (res.code >= 400) return html(reply, res.code, dirPage(d, kind === 'signup' ? 'Sign up' : 'Log in', authForm(d, kind, body, String(res.json.message ?? res.json.error))))
      return html(reply, res.code, dirPage(d, 'Check your inbox', `<div class="panel"><h2 class="ok">Almost there</h2><p>${esc(res.json.message)}</p></div>`))
    })
  }
  sb.get('/dirs/:slug/account/verify/:token', async (req, reply) => {
    const { slug, token } = req.params as { slug: string; token: string }
    const d = accountDir(slug)
    const a = d && accounts.verify(`dir:${slug}`, token)
    if (!d || !a) return missing(reply, 'This verification link is invalid.')
    return html(reply, 200, dirPage(d, 'Verified', `<div class="panel"><h2 class="ok">Email verified</h2><p>Your ${esc(d.name)} account is active.</p><p><a class="btn" href="/sandbox/dirs/${d.slug}/login">Log in and submit your product</a></p></div>`))
  })

  sb.get('/dirs/:slug/api/submissions/:id', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string }
    const d = bySlug.get(slug)
    const s = d && store.data.submissions.find((x) => x.slug === slug && x.id === id)
    if (!d || !s) return missing(reply, 'No such submission', true)
    const ph = phase(d, s)
    return { submission_id: s.id, status: ph, listing_url: listingUrl(d, s.id), submitted_at: new Date(s.created_at).toISOString(), ...(ph === 'rejected' ? { reason: 'Did not meet editorial guidelines.' } : {}) }
  })

  // 404 for anything not live: pending, rejected, removed and unknown look the same to a visitor.
  const liveSub = (slug: string, id: string) => {
    const d = bySlug.get(slug)
    const s = d && store.data.submissions.find((x) => x.slug === slug && x.id === id)
    return d && s && phase(d, s) === 'live' ? { d, s } : null
  }

  sb.get('/dirs/:slug/listing/:id', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string }
    const hit = liveSub(slug, id)
    if (!hit) return missing(reply, 'This listing does not exist or is no longer available.')
    const { d, s } = hit
    const v = shown(d, s)
    const logo = s.logo_url ? `<img src="${esc(s.logo_url)}" alt="" style="max-height:64px;float:right;border-radius:8px" onerror="this.remove()">` : ''
    const body = `<article class="panel">${logo}<h2 style="margin-top:0">${esc(v.name)}</h2><p style="font-size:17px">${esc(v.tagline)}</p><p>${esc(v.description)}</p><p><i class="chip">${esc(s.category)}</i></p><p>${websiteLine(d, s.url)}<a class="btn" rel="nofollow noopener" href="${esc(s.url)}">Visit website</a></p><p class="note">Listed ${isoUtc(s.created_at)} · <a href="/sandbox/dirs/${d.slug}/listing/${s.id}/snapshot">rendered snapshot (SVG)</a></p></article>`
    return html(reply, 200, dirPage(d, v.name, body))
  })

  // A rendering of the listing as an image, for bots without a browser. Labelled as a rendered snapshot.
  sb.get('/dirs/:slug/listing/:id/snapshot', async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string }
    const hit = liveSub(slug, id)
    if (!hit) return missing(reply, 'This listing does not exist or is no longer available.', true)
    const { d, s } = hit
    const v = shown(d, s)
    const accent = `hsl(${d.theme.hue} 68% 42%)`
    const bg = d.theme.dark ? '#14161b' : '#ffffff'
    const ink = d.theme.dark ? '#eceef2' : '#1c1f26'
    const text = (x: number, y: number, size: number, content: string, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${ink}" ${extra}>${esc(content)}</text>`
    const desc = wrap(v.description, 78, 6).map((l, i) => text(70, 360 + i * 30, 22, l, 'opacity=".85"')).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720" font-family="Segoe UI,Arial,sans-serif">
<rect width="1200" height="720" fill="${bg}"/>
<rect width="1200" height="44" fill="#e5e7eb"/><circle cx="24" cy="22" r="7" fill="#f87171"/><circle cx="46" cy="22" r="7" fill="#fbbf24"/><circle cx="68" cy="22" r="7" fill="#34d399"/>
<rect x="100" y="9" width="900" height="26" rx="13" fill="#fff"/><text x="116" y="27" font-size="14" fill="#374151">${esc(listingUrl(d, s.id))}</text>
<rect y="44" width="1200" height="110" fill="${accent}"/><text x="70" y="112" font-size="38" font-weight="700" fill="#fff">${esc(d.name)}</text><text x="70" y="142" font-size="18" fill="#fff" opacity=".9">${esc(d.tagline)}</text>
${text(70, 250, 46, v.name.slice(0, 40), 'font-weight="700"')}${text(70, 300, 26, v.tagline.slice(0, 80), 'opacity=".9"')}${desc}
<rect x="70" y="${360 + 6 * 30 + 10}" width="${40 + s.category.length * 11}" height="34" rx="17" fill="none" stroke="${accent}"/><text x="86" y="${360 + 6 * 30 + 33}" font-size="18" fill="${accent}">${esc(s.category)}</text>
<rect y="680" width="1200" height="40" fill="#14161b"/><text x="20" y="705" font-size="15" fill="#e8d9a8" font-family="Consolas,monospace">rendered snapshot · Sandbox Web fixture, not a real site · ${esc(new Date(clock()).toISOString())}</text>
</svg>`
    return reply.type('image/svg+xml').header('content-disposition', `inline; filename="snapshot-${d.slug}-${s.id}.svg"`).send(svg)
  })

  // Email confirmation link (email_confirm directories).
  sb.get('/dirs/:slug/verify/:token', async (req, reply) => {
    const { slug, token } = req.params as { slug: string; token: string }
    const d = bySlug.get(slug)
    const s = d && store.data.submissions.find((x) => x.slug === slug && x.token === token)
    if (!d || !s) return missing(reply, 'This confirmation link is invalid.')
    if (s.verified_at === null) {
      s.verified_at = clock()
      store.save()
    }
    return html(reply, 200, dirPage(d, 'Confirmed', `<div class="panel"><h2 class="ok">Email confirmed</h2><p>${esc(s.name)} is now listed.</p><p><a href="/sandbox/dirs/${d.slug}/listing/${s.id}">View your listing</a></p></div>`))
  })
}
