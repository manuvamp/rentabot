// Hunter.io client for the Lead Verifier's find_leads skill: the bot's OWN Hunter account (env HUNTER_API_KEY), never the buyer's.
//   - GET /v2/account (free) tells how many domain searches are left this month; GET /v2/domain-search lists up to 10 addresses
//     for a domain, each with the source pages Hunter saw it on.
//   - The key travels only in the X-API-KEY header, never in a URL. Redirects are refused so the header cannot follow one to
//     another host. It is registered with the log redactor, and every error text is scrubbed of it before it leaves this file.
//   - Direct fetch: api.hunter.io has IPv6, and the production server is IPv6-only, so no egress Worker is needed.
import { readEnv } from './env.ts'
import { registerSecret, redact } from './log.ts'

export const HUNTER_BASE = 'https://api.hunter.io/v2'
/** Hunter's free plan returns at most this many addresses per domain search. */
export const HUNTER_PER_SEARCH = 10
/** Values Hunter's domain-search filters accept; anything else is dropped before the request. */
export const HUNTER_DEPARTMENTS = ['executive', 'it', 'finance', 'management', 'sales', 'legal', 'support', 'hr', 'marketing', 'communication', 'education', 'design', 'health', 'operations'] as const
export const HUNTER_SENIORITY = ['junior', 'senior', 'executive'] as const
export const HUNTER_TYPES = ['personal', 'generic'] as const

export type HunterErrorKind = 'no_key' | 'auth' | 'quota' | 'rate_limit' | 'bad_request' | 'unavailable' | 'server' | 'network'

export class HunterError extends Error {
  readonly kind: HunterErrorKind
  readonly status: number
  constructor(kind: HunterErrorKind, message: string, status = 0) {
    super(message)
    this.name = 'HunterError'
    this.kind = kind
    this.status = status
  }
}

export interface HunterAccount {
  plan: string
  /** "2026-11-20": when the monthly allowance resets, or null. */
  resetDate: string | null
  /** Domain searches left this month (the smaller of Hunter's "searches" and "credits" counters). */
  searchesLeft: number
  verificationsLeft: number | null
}

export interface HunterSource {
  uri: string
  extractedOn: string
  lastSeenOn: string
  stillOnPage: boolean | null
}

export interface HunterEmail {
  value: string
  type: string
  confidence: number
  firstName: string
  lastName: string
  position: string
  department: string
  seniority: string
  sources: HunterSource[]
}

export interface HunterDomainResult {
  domain: string
  organization: string
  /** True when the searched domain is a free webmail provider (gmail.com): not a company. */
  webmail: boolean
  /** Total addresses Hunter knows for the domain (only the first HUNTER_PER_SEARCH come back). */
  total: number
  emails: HunterEmail[]
}

export interface HunterFilters {
  department?: string[]
  seniority?: string[]
  type?: string
}

export interface HunterOptions {
  /** The key. Omit to read HUNTER_API_KEY from the environment (and the repo .env); '' means "not configured". */
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** How long a successful /account answer is reused (default 30 s). 0 = always ask. */
  accountTtlMs?: number
}

export interface Hunter {
  /** A key is set. When false every call throws HunterError('no_key') without any network request. */
  readonly configured: boolean
  account(opts?: { fresh?: boolean }): Promise<HunterAccount>
  domainSearch(domain: string, filters?: HunterFilters): Promise<HunterDomainResult>
  /** Calls sent, by endpoint (tests assert on quota use). */
  readonly requests: { account: number; domainSearch: number }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Keep only the values Hunter accepts, lower-cased and de-duplicated. */
export function allowed(list: unknown, ok: readonly string[]): string[] {
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[\s,;|]+/) : []
  return [...new Set(raw.map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => ok.includes(x)))]
}

function remainingOf(c: unknown): number | null {
  const o = rec(c)
  const remaining = num(o.remaining)
  if (remaining !== null) return Math.max(0, remaining)
  const available = num(o.available)
  const used = num(o.used)
  return available !== null ? Math.max(0, available - (used ?? 0)) : null
}

/** One Hunter email entry, defensively: a field Hunter leaves out becomes an empty value, never a crash. */
function parseEmail(raw: unknown): HunterEmail | null {
  const e = rec(raw)
  const value = text(e.value, 254).toLowerCase()
  if (!value) return null
  const sources = (Array.isArray(e.sources) ? e.sources : []).flatMap((s): HunterSource[] => {
    const o = rec(s)
    const uri = text(o.uri, 2000)
    if (!uri) return []
    return [{ uri, extractedOn: text(o.extracted_on, 20), lastSeenOn: text(o.last_seen_on, 20), stillOnPage: typeof o.still_on_page === 'boolean' ? o.still_on_page : null }]
  })
  return {
    value,
    type: text(e.type, 20),
    confidence: num(e.confidence) ?? 0,
    firstName: text(e.first_name, 80),
    lastName: text(e.last_name, 80),
    position: text(e.position, 120),
    department: text(e.department, 40),
    seniority: text(e.seniority, 40),
    sources,
  }
}

export function createHunter(opts: HunterOptions = {}): Hunter {
  const key = (opts.apiKey !== undefined ? opts.apiKey : (readEnv().HUNTER_API_KEY ?? '')).trim()
  registerSecret(key)
  const base = (opts.baseUrl ?? HUNTER_BASE).replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  const ttl = opts.accountTtlMs ?? 30_000
  const requests = { account: 0, domainSearch: 0 }
  let cached: { at: number; acct: HunterAccount } | null = null

  /** Never let the key into a message, whatever put it there. */
  const clean = (s: string) => redact(key ? s.split(key).join('[redacted]') : s).slice(0, 300)

  async function get(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (!key) throw new HunterError('no_key', 'Hunter.io is not configured on this bot (no API key).')
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000)
    let res: Response
    let body = ''
    try {
      // The key only in the header; redirects refused so it can never be replayed to another host.
      res = await doFetch(url, { headers: { 'X-API-KEY': key, accept: 'application/json' }, redirect: 'error', signal: ctl.signal })
      body = await res.text()
    } catch (e) {
      throw new HunterError('network', `could not reach Hunter.io (${clean((e as Error).message || 'network error')})`)
    } finally {
      clearTimeout(timer)
    }
    let json: Record<string, unknown> = {}
    try {
      json = rec(JSON.parse(body))
    } catch {
      /* not JSON: judged by status below */
    }
    if (res.status >= 200 && res.status < 300) return json
    const first = rec((Array.isArray(json.errors) ? json.errors : [])[0])
    const detail = clean(text(first.details, 200) || `HTTP ${res.status}`)
    const id = text(first.id, 60)
    if (res.status === 401) throw new HunterError('auth', 'Hunter.io rejected the bot\'s API key.', 401)
    if (res.status === 429 || res.status === 403) {
      const usage = /limit|quota|credit|usage|plan|upgrade/i.test(`${id} ${detail}`) && !/rate/i.test(id)
      throw new HunterError(usage ? 'quota' : 'rate_limit', usage ? `Hunter.io says the monthly allowance is used up (${detail})` : `Hunter.io is rate limiting the bot (${detail})`, res.status)
    }
    if (res.status === 451) throw new HunterError('unavailable', `Hunter.io will not list that domain (${detail})`, 451)
    if (res.status >= 400 && res.status < 500) throw new HunterError('bad_request', `Hunter.io refused the request (${detail})`, res.status)
    throw new HunterError('server', `Hunter.io answered HTTP ${res.status} (${detail})`, res.status)
  }

  return {
    configured: key.length > 0,
    requests,

    async account(o = {}) {
      if (!o.fresh && cached && ttl > 0 && Date.now() - cached.at < ttl) return cached.acct
      requests.account++
      const data = rec((await get('/account')).data)
      const r = rec(data.requests)
      const searches = remainingOf(r.searches)
      const credits = remainingOf(r.credits)
      const left = [searches, credits].filter((x): x is number => x !== null)
      if (left.length === 0) throw new HunterError('server', 'Hunter.io\'s account answer had no search counters.')
      const acct: HunterAccount = {
        plan: text(data.plan_name, 40) || 'unknown',
        resetDate: text(data.reset_date, 20) || null,
        searchesLeft: Math.min(...left),
        verificationsLeft: remainingOf(r.verifications),
      }
      cached = { at: Date.now(), acct }
      return acct
    },

    async domainSearch(domain, filters = {}) {
      const q: Record<string, string> = { domain, limit: String(HUNTER_PER_SEARCH) }
      const dept = allowed(filters.department, HUNTER_DEPARTMENTS)
      const sen = allowed(filters.seniority, HUNTER_SENIORITY)
      const type = allowed(filters.type, HUNTER_TYPES)[0]
      if (dept.length) q.department = dept.join(',')
      if (sen.length) q.seniority = sen.join(',')
      if (type) q.type = type
      requests.domainSearch++
      cached = null // the allowance just changed
      const j = await get('/domain-search', q)
      const data = rec(j.data)
      const emails = (Array.isArray(data.emails) ? data.emails : []).map(parseEmail).filter((e): e is HunterEmail => !!e).slice(0, HUNTER_PER_SEARCH)
      return {
        domain: text(data.domain, 253).toLowerCase() || domain,
        organization: text(data.organization, 120),
        webmail: data.webmail === true,
        total: num(rec(j.meta).results) ?? emails.length,
        emails,
      }
    },
  }
}
