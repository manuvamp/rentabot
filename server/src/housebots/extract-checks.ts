// page_extraction_verified: the platform's acceptance check for the Web Data Extractor. Per delivered unit (one page) it fetches the page
// itself and re-runs the rules the bot used (extract-logic.ts): the page must be one of the contract's URLs, every non-null value
// must be inside its quote and the quote must be on the page, the built-in fields must have the right shape, and enough of the requested
// fields must be filled. Anything the bot made up is therefore found out; a page that cannot be fetched now is pending, never a free pass.
import type { CheckImpl, CheckLibrary, CheckOutcome } from '../intelligence/types.ts'
import { safeFetch as defaultSafeFetch, type SafeFetch } from '../intelligence/checks/safe-fetch.ts'
import { fetchRetrying } from '../intelligence/checks/transient.ts'
import { canonicalUrl } from './link-logic.ts'
import { checkRow, minFilled, pageFacts, parseFields, parseUrls } from './extract-logic.ts'

const out = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({ status, detail: detail.length > 1000 ? `${detail.slice(0, 999)}…` : detail, evidence_id })
const asStr = (v: unknown) => (typeof v === 'string' ? v : '')

export interface ExtractCheckOptions {
  safeFetch?: SafeFetch
  allowHosts?: string[]
}

export function registerExtractChecks(lib: CheckLibrary, opts: ExtractCheckOptions = {}): void {
  const fetcher = opts.safeFetch ?? defaultSafeFetch
  const allowHosts = opts.allowHosts ?? []

  const pageExtractionVerified: CheckImpl = {
    def: {
      id: 'page_extraction_verified',
      title: 'Extracted values are on the page',
      description:
        'The platform fetches the unit\'s page itself (it must be one of the contract\'s urls) and checks the unit\'s row: every non-null value in unit.meta.data must be inside its source quote in unit.meta.quotes, ' +
        'the quote must be a contiguous passage of the page (visible text, title, meta and og descriptions, mailto/tel targets; compared after normalising case, spacing, quotes, dashes and thousands commas), ' +
        'the built-in fields (title, h1, description, emails, phones, prices) must have the right shape, no field outside the contract\'s fields may appear, and at least half of the requested fields (at least one) must be filled. ' +
        'A value that is not on the page fails the whole unit. A page that cannot be fetched right now (timeout, 429, 5xx) is pending and re-checked once.',
      params: { type: 'object', properties: {}, additionalProperties: false },
      per_unit: true,
      delayed: true,
    },
    async run(ctx) {
      if (!ctx.unit) return out('error', 'page_extraction_verified runs per delivered unit (one page)')
      const m = ctx.unit.meta
      const { urls } = parseUrls(ctx.contract.inputs.urls)
      const { fields } = parseFields(ctx.contract.inputs.fields)
      if (!urls.length || !fields.length) return out('fail', 'the contract has no valid urls and fields inputs to check the unit against')
      const url = canonicalUrl(asStr(m.url || ctx.unit.url))
      if (!url) return out('fail', 'unit.meta.url is missing or not an http(s) URL')
      if (!urls.includes(url)) return out('fail', `the page ${url.slice(0, 120)} is not one of the contract's urls`)

      const later = (why: string, ev: string | null = null) => (ctx.attempt < 2 ? out('pending', `${why}; it will be looked at again`, ev) : out('fail', `${why}, and still after a second look`, ev))
      const got = await fetchRetrying(fetcher, url, { allowHosts, timeoutMs: 10_000, maxBytes: 1_500_000, maxRedirects: 3 })
      if (got.transient) return later(`the page could not be fetched cleanly (${got.transient})`)
      if (!got.result) return out('fail', `the page cannot be fetched (${((got.error as Error)?.message ?? 'network error').slice(0, 160)})`)
      const r = got.result
      if (r.status >= 500) return later(`the page answered HTTP ${r.status}`)
      if (r.status < 200 || r.status >= 300) return out('fail', `the page answers HTTP ${r.status}, so the platform cannot see the values the unit claims`)
      const type = (r.headers['content-type'] ?? '').toLowerCase()
      if (type && !/html|xml|text\//.test(type)) return out('fail', `the page is ${type.slice(0, 60)}, not a web page the extraction rules read`)

      const facts = pageFacts(r.body)
      const row = checkRow({ data: m.data, quotes: m.quotes }, fields, facts)
      const ev = await ctx.saveEvidence('extraction', `${url}: ${row.filled.length}/${fields.length} fields verified${row.ok ? '' : `, ${row.problems.length} problem(s)`}`, {
        url,
        final_url: r.url,
        status: r.status,
        truncated: r.truncated,
        filled: row.filled,
        problems: row.problems.slice(0, 20),
        need: minFilled(fields),
      })
      if (!row.ok) return out('fail', `the unit's row does not hold up against the page: ${row.problems.slice(0, 3).join('; ')}${row.problems.length > 3 ? ` (+${row.problems.length - 3} more)` : ''}${r.truncated ? ' (page truncated at the size cap)' : ''}`, ev)
      return out('pass', `${row.filled.length} of ${fields.length} fields verified on ${url}: ${row.filled.join(', ')}`, ev)
    },
  }
  lib.register(pageExtractionVerified)
}
