// broken_link_confirmed: the platform's acceptance check for the Broken Link Hunter. Per delivered unit it does the bot's work again
// itself, never trusting the claim: it re-fetches the source page and confirms the link (and its anchor text) is on it, then
// re-fetches the link and confirms it is still broken, by the same definition the bot uses (link-logic.ts). Transient trouble is
// handled sensibly: a timeout or a server error is `pending` on the first run (the verify window re-runs it) and only counts on the
// second look; a link that works again, or that the site merely blocks robots from (401/403/429...), fails the unit.
import type { CheckContext, CheckImpl, CheckLibrary, CheckOutcome } from '../intelligence/types.ts'
import { safeFetch as defaultSafeFetch, type FetchResult, type SafeFetch } from '../intelligence/checks/safe-fetch.ts'
import { canonicalUrl, classifyError, classifyStatus, extractLinks, type LinkResult } from './link-logic.ts'

const out = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({ status, detail: detail.length > 1000 ? `${detail.slice(0, 999)}…` : detail, evidence_id })

export interface LinkCheckOptions {
  safeFetch?: SafeFetch
  allowHosts?: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const asStr = (v: unknown) => (typeof v === 'string' ? v : '')

export function registerLinkChecks(lib: CheckLibrary, opts: LinkCheckOptions = {}): void {
  const fetcher = opts.safeFetch ?? defaultSafeFetch
  const allowHosts = opts.allowHosts ?? []
  const get = (url: string, maxBytes: number) => fetcher(url, { allowHosts, timeoutMs: 10_000, maxBytes, maxRedirects: 3 })

  /** One fetch, as a classified result (the page, when it answered). */
  async function look(url: string, maxBytes: number): Promise<{ res: LinkResult; page: FetchResult | null }> {
    try {
      const page = await get(url, maxBytes)
      return { res: classifyStatus(page.status), page }
    } catch (e) {
      return { res: classifyError(e), page: null }
    }
  }

  const siteHost = (ctx: CheckContext) => {
    const raw = ctx.contract.inputs.site_url
    const u = typeof raw === 'string' ? canonicalUrl(raw) : null
    return u ? new URL(u).host : null
  }

  /** Not decidable yet: pending on the first run, a failure with the reason on the second. */
  const later = (ctx: CheckContext, why: string, ev: string | null): CheckOutcome => (ctx.attempt < 2 ? out('pending', `${why}; it will be looked at again`, ev) : out('fail', `${why}, and still after a second look`, ev))

  const brokenLinkConfirmed: CheckImpl = {
    def: {
      id: 'broken_link_confirmed',
      title: 'Broken link confirmed',
      description:
        'The platform re-does the crawl step itself for each unit. unit.meta.source_page must be on the contract\'s site_url host and (re-fetched, 2xx) its HTML must contain an anchor to unit.meta.link_url (and, if unit.meta.anchor_text is given, that anchor text, ignoring case and spacing). ' +
        'Then the platform fetches the link (HEAD-equivalent GET, at most 3 redirects, SSRF guard) and passes only if it is still broken: HTTP 400, 404 or 410, a domain that does not resolve, an invalid TLS certificate or a redirect loop; a server error (5xx, connection refused) counts when the unit claims it too, else on a second look. ' +
        'A link that works, or that merely refuses robots (401, 403, 405, 429), fails. A server error that the unit also claims (status 5xx or a refused connection) passes; a server error where the unit claimed something else, and any timeout, is `pending` on the first run and re-checked once. A unit with unit.meta.kind "crawl_report" is checked by re-fetching up to 3 of the pages it says it crawled (all must answer 2xx and be on the contract\'s site).',
      params: { type: 'object', properties: {}, additionalProperties: false },
      per_unit: true,
      delayed: true,
    },
    async run(ctx) {
      if (!ctx.unit) return out('error', 'broken_link_confirmed runs per delivered unit')
      const m = ctx.unit.meta
      const host = siteHost(ctx)
      if (!host) return out('fail', 'the contract has no valid site_url input to check the unit against')

      if (m.kind === 'crawl_report') {
        const start = canonicalUrl(asStr(m.start_url))
        const sample = (Array.isArray(m.pages_sample) ? m.pages_sample : []).map((x) => canonicalUrl(asStr(x))).filter((x): x is string => !!x).slice(0, 3)
        if (!start || new URL(start).host !== host) return out('fail', 'the report\'s start_url is not on the contract\'s site')
        if (!sample.length) return out('fail', 'the report names no crawled pages to re-fetch')
        if (sample.some((u) => new URL(u).host !== host)) return out('fail', 'the report names crawled pages outside the contract\'s site')
        const rs = await Promise.all(sample.map((u) => look(u, 200_000)))
        const ev = await ctx.saveEvidence('crawl_sample', `${rs.filter((r) => r.res.verdict === 'ok').length}/${sample.length} sampled pages answer`, { sample, results: rs.map((r) => ({ verdict: r.res.verdict, status: r.res.status, detail: r.res.detail })) })
        const bad = rs.map((r, i) => ({ r, u: sample[i]! })).filter((x) => x.r.res.verdict !== 'ok')
        if (!bad.length) return out('pass', `the platform re-fetched ${sample.length} page(s) the crawl reported and all answer`, ev)
        if (bad.every((x) => x.r.res.verdict === 'transient' || x.r.res.verdict === 'server_error')) return later(ctx, `${bad.length} sampled page(s) did not answer cleanly (${bad[0]!.r.res.detail})`, ev)
        return out('fail', `a page the crawl reported does not answer: ${bad[0]!.u} (${bad[0]!.r.res.detail})`, ev)
      }

      const source = canonicalUrl(asStr(m.source_page))
      const link = canonicalUrl(asStr(m.link_url || ctx.unit.url))
      if (!source) return out('fail', 'unit.meta.source_page is missing or not an http(s) URL')
      if (!link) return out('fail', 'unit.meta.link_url is missing or not an http(s) URL')
      if (new URL(source).host !== host) return out('fail', `the source page ${source.slice(0, 120)} is not on the contract's site (${host})`)

      // 1) the link is really on the source page
      const src = await look(source, 1_500_000)
      if (!src.page) {
        if (src.res.verdict === 'transient' || src.res.verdict === 'server_error') return later(ctx, `could not fetch the source page (${src.res.detail})`, null)
        return out('fail', `the source page cannot be fetched (${src.res.detail}), so the link cannot be confirmed on it`)
      }
      if (src.res.verdict !== 'ok') {
        if (src.res.verdict === 'transient' || src.res.verdict === 'server_error') return later(ctx, `the source page answered ${src.res.detail}`, null)
        return out('fail', `the source page now answers ${src.res.detail}, so it no longer serves the link`)
      }
      const found = extractLinks(src.page.body, src.page.url).filter((l) => canonicalUrl(l.url) === link)
      if (!found.length) return out('fail', `the link is not on the source page${src.page.truncated ? ' (page truncated at the size cap)' : ''}`)
      const claimedText = asStr(m.anchor_text)
      if (claimedText && !found.some((l) => norm(l.text) === norm(claimedText))) return out('fail', `the anchor text on the page is ${found.map((l) => `"${l.text.slice(0, 60)}"`).join(' / ')}, not "${claimedText.slice(0, 60)}"`)

      // 2) and it is still broken
      const dst = await look(link, 64_000)
      const ev = await ctx.saveEvidence('broken_link', `${link} -> ${dst.res.detail}`, {
        source_page: source,
        link_url: link,
        anchor_text_on_page: found[0]!.text,
        claimed: { status: m.status ?? null, error: m.error ?? null },
        now: { verdict: dst.res.verdict, status: dst.res.status, kind: dst.res.kind, detail: dst.res.detail, final_url: dst.page?.url ?? null, hops: dst.page?.hops.length ?? 0 },
      })
      switch (dst.res.verdict) {
        case 'broken':
          return out('pass', `confirmed: the link is on ${source} (${found.length === 1 ? 'once' : `${found.length} times`}) and ${dst.res.detail}`, ev)
        case 'ok':
          return out('fail', `the link works now (${dst.res.detail})`, ev)
        case 'restricted':
          return out('fail', `the link answers ${dst.res.detail}: the site refuses robots or needs a login, which is not a broken link`, ev)
        case 'server_error': {
          // The unit says it saw a server error (twice, the bot only reports after a second look) and the platform sees one now: that agrees.
          // A unit that claimed something else (a 404) and a server that errors now is not the same claim: look again before it counts.
          const claimedServerError = (typeof m.status === 'number' && m.status >= 500) || m.kind === 'refused'
          if (claimedServerError) return out('pass', `confirmed: the link is on ${source} and the platform also gets ${dst.res.detail}, as the unit says`, ev)
          return ctx.attempt < 2 ? out('pending', `the link answers ${dst.res.detail}, not what the unit claims; it will be looked at again before it counts`, ev) : out('pass', `confirmed on a second look: the link is on ${source} and still ${dst.res.detail}`, ev)
        }
        default:
          return later(ctx, `the link could not be judged (${dst.res.detail})`, ev)
      }
    },
  }
  lib.register(brokenLinkConfirmed)
}
