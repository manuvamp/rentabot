// A mock Hunter.io for the find_leads tests: an injected fetch that answers /v2/account and /v2/domain-search from a table,
// counts the searches it spends like the real free plan (50 a month), and records every request so tests can check what was sent.
// No test in this repo calls the real Hunter.

/** A made-up key: long enough for the redactors, nothing like a real one. */
export const KEY = 'mockhunterkey0123456789abcdef0123456789ab'

export interface MockEmail {
  value: string
  type?: 'personal' | 'generic'
  confidence?: number
  first_name?: string | null
  last_name?: string | null
  position?: string | null
  department?: string | null
  seniority?: string | null
  sources?: { uri: string; extracted_on?: string; last_seen_on?: string; still_on_page?: boolean }[]
}

export interface MockDomain {
  organization?: string
  webmail?: boolean
  emails: MockEmail[]
  /** Respond to a search of this domain with this error instead. */
  fail?: { status: number; id?: string; details: string }
}

export interface HunterCall {
  path: string
  url: string
  query: Record<string, string>
  key: string | null
  redirect: string | undefined
}

export interface MockHunter {
  fetchImpl: typeof fetch
  calls: HunterCall[]
  domains: Record<string, MockDomain>
  /** Searches already used / allowed this month. A search over the allowance answers 429 like the real service. */
  searches: { used: number; available: number }
  /** Make /account answer this error (a Hunter outage). */
  accountFails: { status: number; details: string } | null
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function mockHunter(domains: Record<string, MockDomain>, init: { used?: number; available?: number; key?: string } = {}): MockHunter {
  const key = init.key ?? KEY
  const m: MockHunter = {
    calls: [],
    domains,
    searches: { used: init.used ?? 0, available: init.available ?? 50 },
    accountFails: null,
    fetchImpl: async (input, opts) => {
      const url = new URL(String(input))
      const headers = new Headers(opts?.headers)
      m.calls.push({ path: url.pathname, url: url.toString(), query: Object.fromEntries(url.searchParams), key: headers.get('x-api-key'), redirect: opts?.redirect })
      if (headers.get('x-api-key') !== key) return json(401, { errors: [{ id: 'authentication_failed', code: 401, details: `No user found for the API key supplied (${headers.get('x-api-key') ?? 'none'}).` }] })
      const left = Math.max(0, m.searches.available - m.searches.used)
      if (url.pathname === '/v2/account') {
        if (m.accountFails) return json(m.accountFails.status, { errors: [{ id: 'server_error', code: m.accountFails.status, details: m.accountFails.details }] })
        const counter = { used: m.searches.used, available: m.searches.available, remaining: left }
        return json(200, {
          data: {
            plan_name: 'Free',
            plan_level: 0,
            reset_date: '2026-11-20',
            requests: { credits: counter, searches: counter, verifications: { used: 0, available: 100, remaining: 100 } },
            calls: { _deprecation_notice: 'Sums the searches and the verifications', used: m.searches.used, available: m.searches.available + 25 },
          },
        })
      }
      if (url.pathname === '/v2/domain-search') {
        const domain = url.searchParams.get('domain') ?? ''
        const d = m.domains[domain]
        if (left < 1) return json(429, { errors: [{ id: 'usage_limit_reached', code: 429, details: 'You have reached your monthly usage limit. Upgrade your plan to continue.' }] })
        if (d?.fail) return json(d.fail.status, { errors: [{ id: d.fail.id ?? 'wrong_params', code: d.fail.status, details: d.fail.details }] })
        m.searches.used++
        const limit = Number(url.searchParams.get('limit') ?? 10)
        const dept = url.searchParams.get('department')
        const emails = (d?.emails ?? []).filter((e) => !dept || dept.split(',').includes(e.department ?? '')).slice(0, Math.min(limit, 10))
        return json(200, {
          data: { domain, disposable: false, webmail: d?.webmail ?? false, accept_all: false, pattern: '{first}', organization: d?.organization ?? domain, emails, linked_domains: [] },
          meta: { results: d?.emails.length ?? 0, limit, offset: 0, params: Object.fromEntries(url.searchParams) },
        })
      }
      return json(404, { errors: [{ id: 'not_found', code: 404, details: 'no such endpoint' }] })
    },
  }
  return m
}

/** A Hunter email entry whose single source is `page`, still on the page. */
export const email = (value: string, page: string, extra: Partial<MockEmail> = {}): MockEmail => ({
  value,
  type: 'personal',
  confidence: 90,
  first_name: value.split('@')[0]!.replace(/[^a-z]/gi, '') || null,
  last_name: 'Tester',
  position: 'Head of Marketing',
  department: 'marketing',
  seniority: 'senior',
  sources: [{ uri: page, extracted_on: '2025-01-10', last_seen_on: '2026-09-30', still_on_page: true }],
  ...extra,
})
