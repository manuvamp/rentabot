// Acceptance checks for the house bots that act on the real web: lead_verified, http_claim_holds, email_lint.
// The platform re-does the work itself (re-fetches the page, asks DNS, lints the text); it never takes
// the seller's word. Register at boot:  registerHouseBotChecks(intelligence.checks, { safeFetch, allowHosts }).
import type { CheckContext, CheckImpl, CheckLibrary, CheckOutcome } from '../intelligence/types.ts'
import { htmlToText } from '../intelligence/checks/library.ts'
import { BlockedUrl, safeFetch as defaultSafeFetch, type FetchResult, type SafeFetch } from '../intelligence/checks/safe-fetch.ts'
import { registerDnsChecks } from './dns-checks.ts'
import { registerExtractChecks } from './extract-checks.ts'
import { registerLinkChecks } from './link-checks.ts'
import type { DnsResolvers } from './dns-logic.ts'
import { lintEmail } from './email-lint.ts'
import { makeMx, pageHasEmail, parseEmail, type MxOptions } from './lead-logic.ts'

export { cfDecode, pageHasEmail, parseEmail, type MxRecord } from './lead-logic.ts'

export interface HouseBotCheckOptions extends MxOptions {
  /** The SSRF-guarded fetch used for every URL a seller points at. */
  safeFetch?: SafeFetch
  /** Hosts ("host" or "host:port") that skip the address check, e.g. the server's own Sandbox Web. */
  allowHosts?: string[]
  /** Resolvers for dns_claims_hold (tests). Default: the system resolver and DNS-over-HTTPS. */
  dns?: DnsResolvers
}

const out = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({
  status,
  detail: detail.length > 1000 ? `${detail.slice(0, 999)}…` : detail,
  evidence_id,
})

const timeoutParam = { type: 'integer', minimum: 1000, maximum: 15000, description: 'Fetch timeout in ms (default 8000).' }

// ---------- shared helpers ----------

function evidenceOf(r: FetchResult) {
  return { final_url: r.url, status: r.status, ms: r.ms, hops: r.hops, content_type: r.headers['content-type'] ?? null, body_truncated: r.truncated }
}

const looksHtml = (r: FetchResult) => /html/i.test(r.headers['content-type'] ?? '') || /<html|<body/i.test(r.body.slice(0, 2000))

// ---------- the checks ----------

export function registerHouseBotChecks(lib: CheckLibrary, opts: HouseBotCheckOptions = {}): void {
  const fetcher = opts.safeFetch ?? defaultSafeFetch
  const allowHosts = opts.allowHosts ?? []
  const get = (url: string, timeoutMs?: number, maxBytes = 2_000_000) => fetcher(url, { allowHosts, timeoutMs: timeoutMs ?? 8000, maxBytes, maxRedirects: 3 })
  const hasMx = makeMx(opts)

  const leadVerified: CheckImpl = {
    def: {
      id: 'lead_verified',
      title: 'Lead is verified',
      description:
        'The platform re-verifies each lead itself. Rule: (1) unit.meta.to is a real address (a form or placeholder can only be an honest rejection); (2) the platform fetches unit.meta.email_source_url (public http(s) only) and the exact address appears there as a mailto link, plain text, ' +
        'a written-out form like "name [at] domain", or a Cloudflare-protected address (data-cfemail or /cdn-cgi/l/email-protection#...); (3) the address domain has MX records (DNS, falling back to DNS-over-HTTPS). ' +
        'A unit claiming unit.meta.verified true passes only if (2) and (3) hold. A unit claiming verified false (an honest rejection) passes only if the platform also cannot verify it, ' +
        'because the page was readable and the address is not on it, the page does not exist (4xx), or the domain has no MX. If the page or DNS cannot be reached at all the result is `error` (inconclusive), never a free pass. ' +
        'One-contact-per-domain is not checked here (a per-unit check cannot see the other units).',
      params: { type: 'object', properties: { timeout_ms: timeoutParam }, additionalProperties: false },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return out('error', 'lead_verified runs per delivered unit')
      const meta = ctx.unit.meta
      const claim = meta.verified === false ? false : true // a missing claim counts as "verified"
      const email = parseEmail(meta.to)
      if (!email) {
        const shown = String(meta.to ?? '').slice(0, 80)
        return claim ? out('fail', `unit.meta.to "${shown}" is not an email address`) : out('pass', `honest rejection confirmed: "${shown}" is not an email address`)
      }
      const srcRaw = typeof meta.email_source_url === 'string' ? meta.email_source_url.trim() : ''
      if (!srcRaw) return claim ? out('fail', 'unit.meta.email_source_url is missing, so the address cannot be verified') : out('pass', 'honest rejection: no source page was given, and the platform cannot verify the address either')

      // 1) the address on its source page (known=false: the page could not be judged either way)
      let pg: { known: boolean; found: boolean; detail: string; ev: object }
      try {
        const r = await get(srcRaw, ctx.test.params.timeout_ms as number | undefined)
        if (r.status >= 500 || r.status === 429 || r.status === 408) pg = { known: false, found: false, detail: `source page answered HTTP ${r.status}`, ev: evidenceOf(r) }
        else if (r.status >= 400) pg = { known: true, found: false, detail: `source page answered HTTP ${r.status}`, ev: evidenceOf(r) }
        else {
          const hit = pageHasEmail(r.body, email.address)
          pg = { known: true, found: hit.found, detail: hit.found ? `address on the source page (${hit.how})` : `address not on the source page${r.truncated ? ' (page truncated at the size cap)' : ''}`, ev: { ...evidenceOf(r), how: hit.how } }
        }
      } catch (e) {
        pg = e instanceof BlockedUrl ? { known: true, found: false, detail: `source URL refused by the SSRF guard: ${e.message}`, ev: { refused: e.message } } : { known: false, found: false, detail: `could not fetch the source page: ${(e as Error).message}`, ev: {} }
      }

      // 2) the domain accepts mail
      const mx = await hasMx(email.domain)

      const evidence = {
        to: email.address,
        email_source_url: srcRaw,
        claimed_verified: claim,
        page: { known: pg.known, found: pg.found, detail: pg.detail, ...pg.ev },
        mx: { domain: email.domain, has_mx: mx.result, via: mx.via },
      }
      const ev = await ctx.saveEvidence('lead_verification', `${email.address}: page ${pg.known ? (pg.found ? 'yes' : 'no') : '?'}, mx ${mx.result ?? '?'}`, evidence)
      const why = [pg.detail, mx.result !== null ? `${email.domain} ${mx.result ? 'has' : 'has no'} MX records` : `MX lookup for ${email.domain} inconclusive`].join('; ')

      // A definite negative on either side means the platform cannot verify the lead.
      const definitelyNot = (pg.known && !pg.found) || mx.result === false
      const definitelyYes = pg.known && pg.found && mx.result === true
      if (definitelyYes) return claim ? out('pass', `verified: ${why}`, ev) : out('fail', `the unit claims the lead is NOT verified, but the platform verified it: ${why}`, ev)
      if (definitelyNot) return claim ? out('fail', `not verified: ${why}`, ev) : out('pass', `honest rejection confirmed: ${why}`, ev)
      return out('error', `inconclusive (${why}); no verdict either way`, ev)
    },
  }

  const httpClaimHolds: CheckImpl = {
    def: {
      id: 'http_claim_holds',
      title: 'HTTP claim holds',
      description:
        "The platform re-fetches unit.url (public http(s) only, up to 3 redirects, 2 MB) and re-checks what the unit claims: unit.meta.expected_status (the final status, or any hop's status when 3xx is expected), " +
        'unit.meta.must_contain (string or list; case-insensitive, searched in the page text and the raw body) and unit.meta.must_not_contain (same, must be absent). At least one claim is required; all must hold.',
      params: { type: 'object', properties: { timeout_ms: timeoutParam }, additionalProperties: false },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return out('error', 'http_claim_holds runs per delivered unit')
      const url = ctx.unit.url
      if (!url) return out('fail', 'unit has no url')
      const meta = ctx.unit.meta
      const expected = meta.expected_status
      const list = (v: unknown): string[] | null => (typeof v === 'string' ? (v ? [v] : []) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).filter(Boolean) : v === undefined ? [] : null)
      const must = list(meta.must_contain)
      const mustNot = list(meta.must_not_contain)
      if (expected !== undefined && !(Number.isInteger(expected) && (expected as number) >= 100 && (expected as number) <= 599)) return out('fail', 'unit.meta.expected_status must be an HTTP status code')
      if (must === null || mustNot === null) return out('fail', 'must_contain and must_not_contain must be a string or a list of strings')
      if (expected === undefined && !must.length && !mustNot.length) return out('fail', 'the unit makes no checkable claim (set expected_status, must_contain or must_not_contain in unit.meta)')

      let r: FetchResult
      try {
        r = await get(url, ctx.test.params.timeout_ms as number | undefined)
      } catch (e) {
        if (e instanceof BlockedUrl) return out('fail', `URL refused by the SSRF guard: ${e.message}`)
        return out('fail', `fetch failed: ${(e as Error).message}`)
      }
      const problems: string[] = []
      const facts: string[] = [`HTTP ${r.status}`]
      if (expected !== undefined) {
        const e = expected as number
        const hit = r.status === e || (e >= 300 && e < 400 && r.hops.some((h) => h.status === e))
        if (!hit) problems.push(`expected status ${e}, got ${r.status}`)
      }
      const text = looksHtml(r) ? htmlToText(r.body) : r.body
      const hayText = text.toLowerCase()
      const hayRaw = r.body.toLowerCase()
      const seen = (n: string) => hayText.includes(n.toLowerCase()) || hayRaw.includes(n.toLowerCase())
      const missing = must.filter((n) => !seen(n))
      if (missing.length) problems.push(`missing: ${missing.map((m) => `"${m.slice(0, 60)}"`).join(', ')}${r.truncated ? ' (page truncated at the size cap)' : ''}`)
      const present = mustNot.filter(seen)
      if (present.length) problems.push(`must not contain but does: ${present.map((m) => `"${m.slice(0, 60)}"`).join(', ')}`)
      const ev = await ctx.saveEvidence('http_claim', `${url} -> ${r.status}${problems.length ? `: ${problems.join('; ')}` : ': claim holds'}`, { ...evidenceOf(r), claimed: { expected_status: expected ?? null, must_contain: must, must_not_contain: mustNot }, problems, text_head: text.slice(0, 400) })
      return problems.length ? out('fail', problems.join('; '), ev) : out('pass', `claim holds (${facts.join(', ')}${must.length ? `, found ${must.length} required string(s)` : ''}${mustNot.length ? `, ${mustNot.length} forbidden string(s) absent` : ''})`, ev)
    },
  }

  const emailLint: CheckImpl = {
    def: {
      id: 'email_lint',
      title: 'Cold email passes the linter',
      description:
        'Deterministic rules on unit.meta.subject and unit.meta.body: subject 1-60 characters; body 50-150 words; at most one question mark in the body; no unfilled {placeholders} or [brackets]; ' +
        'the recipient company (unit.meta.company) is named in the subject or body (full name, or the name without a trailing "Capital", "Ventures", "Inc"...); no spam-trigger phrase ("act now", "guaranteed", "click here", ...); ' +
        'no ALL-CAPS word longer than 4 letters except known acronyms and brands (params.allow_caps adds more, the recipient company name is always allowed).',
      params: { type: 'object', properties: { allow_caps: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 2, maxLength: 40 } } }, additionalProperties: false },
      per_unit: true,
      delayed: false,
    },
    async run(ctx: CheckContext) {
      if (!ctx.unit) return out('error', 'email_lint runs per delivered unit')
      const m = ctx.unit.meta
      if (typeof m.subject !== 'string' || typeof m.body !== 'string') return out('fail', 'unit.meta.subject and unit.meta.body must be strings')
      const res = lintEmail({ subject: m.subject, body: m.body, company: typeof m.company === 'string' ? m.company : '' }, { allowCaps: ctx.test.params.allow_caps as string[] | undefined })
      const ev = await ctx.saveEvidence('email_lint', res.ok ? 'lint passed' : `${res.violations.length} violation(s)`, res)
      return res.ok
        ? out('pass', `lint passed (${res.stats.subject_chars} char subject, ${res.stats.body_words} words, ${res.stats.question_marks} question)`, ev)
        : out('fail', res.violations.map((v) => `${v.rule}: ${v.message}`).join('; '), ev)
    },
  }

  lib.register(leadVerified)
  lib.register(httpClaimHolds)
  lib.register(emailLint)
  registerDnsChecks(lib, { dns: opts.dns })
  registerLinkChecks(lib, { safeFetch: fetcher, allowHosts })
  registerExtractChecks(lib, { safeFetch: fetcher, allowHosts })
}
