// Broken Link Hunter (live mode): a polite crawl of ONE site that reports every broken link with its source page, anchor text and status.
// Manners: it reads robots.txt first (a disallowed start page, or a robots.txt it cannot read, means no crawl), stays on the one host,
// never exceeds the page cap, sends at most 2 requests per second, announces itself in its User-Agent, and checks other sites' links with a
// single HEAD (then a GET only when the HEAD does not say "fine"), never crawling them. Page fetches go through the same polite fetcher
// as the other live bots (SSRF guard; IPv4-only hosts through the web egress Worker). No headless browser: links that only exist after
// JavaScript runs are not seen, and the report says so.
//
// A link is reported only after a second look (a blip is not a break), by the definition the platform's broken_link_confirmed check
// uses (server/src/housebots/link-logic.ts). Two units: each confirmed broken link (D1: ref link-<hash>, meta source page, anchor text,
// status) and, when the contract asks for it, the crawl report (D2: pays a flat fee, so a clean site still settles).
import { createHash } from 'node:crypto'
import { amount, cents, type Quote } from '@rentabot/shared'
import { asString, badAsk, needsSchema, primary, sleep, str } from '../common.ts'
import { createPoliteWeb, parseRobots, type PoliteWeb } from '../web.ts'
import { canonicalUrl, classifyError, classifyStatus, extractLinks, isPage, type LinkResult } from '../server-shared.ts'
import { buildQuote, extraPriceCents, MIN_JOB_PRICE_CENTS, type SkillCard, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'
import type { Deliverable, JobSpec } from '@rentabot/shared'

export const LINK_USER_AGENT = 'Mozilla/5.0 (compatible; RentABotLinkChecker/1.0; +https://rentabot.tech)'
export const LINK_ROBOTS_TOKEN = 'RentABotLinkChecker'
/** The flat price of the crawl report deliverable when the skill card does not declare it (cards that predate `pricing.extras`): it alone reaches the $5.00 minimum settlement, so a clean site still settles. */
export const REPORT_PRICE_CENTS = 500
/** The skill declares the crawl report as the extra `crawl_report` (server/src/seed/bots.ts); its price is the report's price. */
export const REPORT_EXTRA_ID = 'crawl_report'
const reportCents = (skill: SkillCard) => extraPriceCents(skill, REPORT_EXTRA_ID, REPORT_PRICE_CENTS)
const DEFAULT_PAGES = 40
const MAX_PAGES = 100
const MAX_LINKS = 300

export interface BrokenLinkHunterOptions {
  web?: PoliteWeb
  /** Hosts that skip the public-address guard (local fixtures in tests). */
  allowHosts?: string[]
  /** Pause before the second look at a suspect link (default 2 s). */
  retryDelayMs?: number
  /** Wall-clock cap for one crawl (default 20 minutes). */
  maxCrawlMs?: number
}

export interface BrokenLink {
  source_page: string
  url: string
  text: string
  status: number | null
  kind: string
  detail: string
}

export interface CrawlResult {
  start: string
  /** Set when nothing was crawled: the reason. */
  refused: string | null
  pages: { url: string; status: number | null }[]
  linksChecked: number
  broken: BrokenLink[]
  skippedRobots: string[]
  notChecked: number
  externalChecked: number
  requests: number
  stoppedEarly: string | null
}

const html = (r: { headers: Record<string, string>; body: string }) => /html/i.test(r.headers['content-type'] ?? '') || /^\s*<(!doctype|html)/i.test(r.body.slice(0, 500))
const unitRef = (source: string, url: string) => `link-${createHash('sha1').update(`${source}\n${url}`).digest('hex').slice(0, 10)}`

/** The crawl itself, separated from the bot so it can be tested against a fixture site. */
export async function crawlSite(siteUrl: string, web: PoliteWeb, o: { maxPages: number; maxLinks?: number; checkExternal: boolean; retryDelayMs: number; deadline: number; signal?: AbortSignal }): Promise<CrawlResult> {
  const start = canonicalUrl(siteUrl) ?? siteUrl
  const result: CrawlResult = { start, refused: null, pages: [], linksChecked: 0, broken: [], skippedRobots: [], notChecked: 0, externalChecked: 0, requests: 0, stoppedEarly: null }
  const begin = web.requests
  const u0 = new URL(start)
  const host = u0.host
  const over = () => (o.signal?.aborted ? 'the job was stopped' : Date.now() > o.deadline ? 'the time cap for one crawl was reached' : null)

  // robots.txt first. 4xx = no rules; a robots.txt that cannot be read at all (5xx, network) is treated as "disallow", as RFC 9309 says.
  let rules = parseRobots('')
  try {
    const r = await web.get(`${u0.origin}/robots.txt`)
    if (r.status === 200 && !html(r)) rules = parseRobots(r.body)
    else if (r.status >= 500) {
      result.refused = `robots.txt answered HTTP ${r.status}, so nothing was crawled (a robots.txt that cannot be read is treated as disallowing, RFC 9309)`
      return result
    }
  } catch (e) {
    result.refused = `the site could not be reached (${((e as Error).message || 'network error').slice(0, 120)})`
    return result
  }
  const allowed = (url: string) => {
    const u = new URL(url)
    return rules.allowed(LINK_ROBOTS_TOKEN, u.pathname + u.search)
  }
  if (!allowed(start)) {
    result.refused = `robots.txt disallows crawling ${u0.pathname || '/'} for this crawler, so nothing was crawled`
    return result
  }

  // crawl the pages of the one host, breadth first
  const verdicts = new Map<string, LinkResult>()
  const occ: { source: string; url: string; text: string }[] = []
  const queue = [start]
  const seen = new Set([start])
  while (queue.length && result.pages.length < o.maxPages) {
    const why = over()
    if (why) {
      result.stoppedEarly = why
      break
    }
    const url = queue.shift()!
    let res: LinkResult
    let page: { body: string; url: string; ok: boolean } | null = null
    try {
      const r = await web.get(url)
      res = classifyStatus(r.status)
      if (res.verdict === 'ok' && html(r)) page = { body: r.body, url: r.url, ok: true }
    } catch (e) {
      res = classifyError(e)
    }
    verdicts.set(url, res)
    result.pages.push({ url, status: res.status })
    if (!page) continue
    const perPage = new Set<string>()
    for (const l of extractLinks(page.body, page.url)) {
      if (perPage.has(l.url)) continue
      perPage.add(l.url)
      occ.push({ source: url, url: l.url, text: l.text })
      const lu = new URL(l.url)
      if (lu.host === host && isPage(l.url) && !seen.has(l.url) && allowed(l.url)) {
        seen.add(l.url)
        queue.push(l.url)
      }
    }
  }

  // what is left to check: every link target not fetched as a page
  const targets: string[] = []
  for (const x of occ) {
    if (verdicts.has(x.url) || targets.includes(x.url)) continue
    const lu = new URL(x.url)
    if (lu.host === host) {
      if (!allowed(x.url)) {
        if (!result.skippedRobots.includes(x.url)) result.skippedRobots.push(x.url)
        continue
      }
    } else if (!o.checkExternal) continue
    targets.push(x.url)
  }
  const cap = o.maxLinks ?? MAX_LINKS
  result.notChecked = Math.max(0, targets.length - cap)
  // HEAD first; a GET only when the HEAD does not say "fine" (some servers answer HEAD badly), and the GET decides.
  const check = async (url: string, head: boolean): Promise<LinkResult> => {
    if (head) {
      try {
        const r = await web.get(url, { method: 'HEAD', maxBytes: 0 })
        const v = classifyStatus(r.status)
        if (v.verdict === 'ok') return v
      } catch {
        /* the GET below decides */
      }
    }
    try {
      const r = await web.get(url, { maxBytes: 20_000 })
      return classifyStatus(r.status)
    } catch (e) {
      return classifyError(e)
    }
  }
  for (const t of targets.slice(0, cap)) {
    const why = over()
    if (why) {
      result.stoppedEarly = why
      result.notChecked += targets.length - result.linksChecked
      break
    }
    verdicts.set(t, await check(t, true))
    result.linksChecked++
    if (new URL(t).host !== host) result.externalChecked++
  }

  // a second look at everything that looks broken: a blip is not a break
  const suspects = [...verdicts].filter(([, v]) => v.verdict === 'broken' || v.verdict === 'server_error')
  if (suspects.length && !over()) {
    await sleep(o.retryDelayMs)
    for (const [url, first] of suspects) {
      if (over()) break
      const second = await check(url, false)
      const still = second.verdict === 'broken' || second.verdict === 'server_error'
      verdicts.set(url, still ? (second.verdict === 'broken' ? second : first.verdict === 'broken' ? first : second) : { verdict: 'ok', status: second.status, kind: 'recovered', detail: 'it answered on the second look' })
    }
  }
  const seenPair = new Set<string>()
  for (const x of occ) {
    const v = verdicts.get(x.url)
    if (!v || (v.verdict !== 'broken' && v.verdict !== 'server_error')) continue
    const k = `${x.source}\n${x.url}`
    if (seenPair.has(k)) continue
    seenPair.add(k)
    result.broken.push({ source_page: x.source, url: x.url, text: x.text, status: v.status, kind: v.kind, detail: v.detail })
  }
  result.requests = web.requests - begin
  return result
}

export function reportMarkdown(r: CrawlResult, maxPages: number): string {
  const L: string[] = [`# Broken link report: ${r.start}`, '', '## Summary', '']
  L.push(`${r.pages.length} page(s) crawled (cap ${maxPages}), ${r.linksChecked} further link target(s) checked (${r.externalChecked} on other sites), ${r.broken.length} broken link(s) confirmed on a second look.`)
  if (r.stoppedEarly) L.push(`The crawl stopped early: ${r.stoppedEarly}.`)
  if (r.notChecked) L.push(`${r.notChecked} link target(s) were not checked (link cap ${MAX_LINKS}).`)
  L.push('', '## Findings', '')
  if (!r.broken.length) L.push('No broken links found on the pages crawled.')
  for (const b of r.broken) L.push(`- "${b.text || '(no text)'}" on ${b.source_page} links to ${b.url}: ${b.detail}`)
  if (r.skippedRobots.length) L.push('', `Not fetched because robots.txt disallows them: ${r.skippedRobots.slice(0, 20).join(', ')}.`)
  L.push('', '## Pages crawled', '')
  for (const p of r.pages) L.push(`- ${p.url} (${p.status ?? 'no answer'})`)
  L.push('', '## Method', '')
  L.push('- robots.txt was read first and obeyed on the audited host; the crawl stayed on that one host, at most 2 requests per second, announced as RentABotLinkChecker.')
  L.push('- Every link target was checked with a HEAD, then a GET when the HEAD did not say fine; links to other sites were checked, never crawled.')
  L.push('- A link counts as broken for HTTP 400, 404 and 410, a domain that does not resolve, an invalid TLS certificate and redirect loops; a server error counts when it is seen again on a second look. Pages that refuse robots (401, 403, 429) are not reported.')
  L.push('- Links that only exist after JavaScript runs are not seen (no browser is used). The platform re-fetches each reported link and its source page before payment.', '')
  return L.join('\n')
}

type Roles = { links: Deliverable; report: Deliverable | null } | string

/** Which deliverable is the broken links and which (if any) is the crawl report. */
export function rolesOf(spec: JobSpec): Roles {
  const ds = spec.deliverables
  if (ds.length > 2) return 'I deliver at most two deliverables per job: the broken links and, optionally, the crawl report.'
  const links = ds.find((d) => d.acceptance.some((t) => t.check === 'broken_link_confirmed'))
  if (!links) return 'the broken links deliverable needs the broken_link_confirmed acceptance check, which is how the platform verifies each link.'
  const report = ds.find((d) => d.id !== links.id) ?? null
  if (report && report.quantity !== 1) return 'the crawl report deliverable is one report (quantity 1).'
  return { links, report }
}

export function brokenLinkHunter(opts: BrokenLinkHunterOptions = {}): SellerBot {
  const web = opts.web ?? createPoliteWeb({ allowHosts: opts.allowHosts, perSecond: 2, timeoutMs: 15_000, userAgent: LINK_USER_AGENT, maxBytes: 1_500_000 })
  const siteOf = (inputs: Record<string, unknown>) => {
    const raw = asString(inputs.site_url)
    const c = /^https?:\/\//i.test(raw) ? canonicalUrl(raw) : null
    return c
  }
  const pagesOf = (inputs: Record<string, unknown>) => {
    const n = Number(inputs.max_pages)
    return Number.isFinite(n) && n >= 1 ? Math.min(MAX_PAGES, Math.max(5, Math.floor(n))) : DEFAULT_PAGES
  }

  return {
    slug: 'broken-link-hunter',
    name: 'Broken Link Hunter',
    skillId: 'broken_link_audit',
    maxConcurrent: 1,

    scope(spec) {
      const roles = rolesOf(spec)
      if (typeof roles === 'string') return `I cannot take this spec: ${roles}`
      const text = [spec.goal, ...spec.deliverables.map((d) => d.description)].join('\n')
      if (/\b(log ?in|logged[- ]in|behind (a )?(login|paywall)|password|authenticated|private (pages|area))\b/i.test(text) && !/\b(no|not|without|never)\b[^.\n]{0,25}\b(log ?in|password)/i.test(text)) return 'I only crawl public pages: I cannot log in to a site or read pages behind a login.'
      if (/\b(ignore|bypass|disregard|skip)\b[^.\n]{0,25}\brobots(\.txt)?\b/i.test(text)) return 'I obey robots.txt on every crawl; I cannot ignore it.'
      if (/\b(stress|load[- ]test|ddos|hammer|flood)\b/i.test(text)) return 'I crawl politely (at most 2 requests per second); I do not load-test sites.'
      return badAsk(spec)
    },

    requirements(_spec, skill) {
      return {
        inputs_schema: needsSchema(
          {
            site_url: str('The site to crawl: one public http(s) URL, e.g. https://oranoai.com/. The crawl starts here and stays on this host.', { format: 'uri' }),
            max_pages: { type: 'integer', minimum: 5, maximum: MAX_PAGES, description: `Optional: the most pages to crawl (default ${DEFAULT_PAGES}, at most ${MAX_PAGES}).` },
            check_external: { type: 'boolean', description: 'Optional: also check links to other sites (default true). They are checked, never crawled.' },
          },
          ['site_url'],
        ),
        access: [],
        assumptions: [
          'Polite crawl of that one site: robots.txt is read first and obeyed (a robots.txt I cannot read means no crawl), same host only, the page cap you set, at most 2 requests per second, announced as RentABotLinkChecker.',
          'Each link target is checked with a HEAD, then a GET when the HEAD does not say fine; a link is reported only after a second look. Links to other sites are checked, never crawled.',
          'The platform re-fetches each reported link and its source page and confirms the link is on the page and still broken before you pay for it. Pages that refuse robots (401, 403, 429) are not reported as broken.',
          `Pricing when you also ask for the crawl report: $${amount(reportCents(skill))} flat for the report (so a clean site still settles) plus a price per verified broken link. A job asking only for links settles once at least 20 are verified.`,
          'No headless browser: links that only exist after JavaScript runs are not seen, and the report says so.',
        ],
        questions: [],
      }
    },

    quote(spec, skill) {
      const roles = rolesOf(spec)
      if (typeof roles === 'string') return { ok: false, reason: roles }
      const unit = cents(skill.pricing.price)
      const max = skill.pricing.max_units
      if (max && roles.links.quantity > max) return { ok: false, reason: `one job covers at most ${max} broken links; ${roles.links.quantity} were asked for. Please ask for fewer.` }
      if (!roles.report) {
        // Only the links: the per-link price alone must reach the minimum settlement.
        const d = buildQuote(spec, skill, { priced: [roles.links.id] })
        if (!d.ok) return d
        return { ok: true, quote: { ...d.quote, excludes: [...d.quote.excludes, `Paid only per verified broken link: a clean site finds none and settles nothing. Add a crawl report deliverable ($${amount(reportCents(skill))} flat) to guarantee the crawl is paid.`].slice(0, 6).map((x) => x.slice(0, 200)) } }
      }
      const fee = reportCents(skill)
      const cap = cents(spec.budget_cap.value)
      if (cap < fee) return { ok: false, reason: `the budget cap of $${spec.budget_cap.value} is below the $${amount(fee)} crawl report fee.` }
      const room = cap - fee
      const payable = Math.min(roles.links.quantity, Math.floor(room / unit))
      const excludes: string[] = []
      if (payable < roles.links.quantity) excludes.push(`Budget cap $${spec.budget_cap.value}: ${payable === 0 ? 'only the crawl report is charged; broken links are listed but not charged' : `only the first ${payable} of ${roles.links.quantity} broken links can be paid`}. Add $${amount(unit)} per link to pay for more.`.slice(0, 200))
      excludes.push(`The crawl report is a flat $${amount(fee)} and settles even when the site has no broken links.`)
      const lines: Quote['lines'] = spec.deliverables.map((d) =>
        d.id === roles.report!.id
          ? { deliverable_id: d.id, model: 'fixed' as const, unit_price: amount(fee), quantity: d.quantity, max_total: amount(fee) }
          : { deliverable_id: d.id, model: 'per_unit' as const, unit_price: skill.pricing.price, quantity: d.quantity, max_total: amount(payable * unit) },
      )
      const total = fee + payable * unit
      if (total < MIN_JOB_PRICE_CENTS) return { ok: false, reason: 'the total is below the platform minimum job price.' }
      return { ok: true, quote: { lines, total_max: { value: amount(total), currency: 'USD' }, turnaround: skill.turnaround, excludes, valid_until: new Date(Date.now() + 3 * 86_400_000).toISOString() } }
    },

    missingInputs(inputs) {
      return siteOf(inputs) ? [] : ['site_url (a public http(s) URL)']
    },

    clarify(question) {
      if (/robots|polite|rate|speed|how fast/i.test(question)) return 'I read robots.txt first and obey it, stay on the one host, crawl at most 2 requests per second up to your page cap, and announce myself as RentABotLinkChecker.'
      if (/javascript|spa|render|react/i.test(question)) return 'No browser is used, so links that exist only after JavaScript runs are not seen; the report says so. Server-rendered links are all found.'
      return null
    },

    // A redo re-crawls and delivers the named units again; the runtime keeps only the agreed ones. A substitute would need links the first crawl did not find.
    async canAgree(offer, job) {
      const roles = rolesOf(job.spec)
      if (typeof roles === 'string') return false
      return offer.kind === 'redo' && (offer.deliverable_id === roles.links.id || offer.deliverable_id === roles.report?.id)
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const roles = rolesOf(job.spec)
      if (typeof roles === 'string') throw new Error(roles)
      const site = siteOf(job.inputs)!
      const maxPages = pagesOf(job.inputs)
      await tools.progress(5, `reading robots.txt and crawling ${new URL(site).host} (up to ${maxPages} pages)`)
      const crawl = await crawlSite(site, web, { maxPages, checkExternal: job.inputs.check_external !== false, retryDelayMs: opts.retryDelayMs ?? 2000, deadline: Date.now() + (opts.maxCrawlMs ?? 20 * 60_000), signal: tools.signal })
      if (crawl.refused) {
        const note = `Not crawled: ${crawl.refused}. Nothing is delivered and nothing is charged.`
        return { summary: note, delivery: { deliverables: job.spec.deliverables.map((d) => ({ deliverable_id: d.id, units: [], note })), note } }
      }
      await tools.progress(85, `${crawl.pages.length} pages crawled, ${crawl.broken.length} broken link(s) confirmed; writing the report`)
      const md = reportMarkdown(crawl, maxPages)
      const report = await tools.uploadArtifact({ name: 'broken-links-report.md', mime: 'text/markdown', text: md })
      const wanted = roles.links.quantity
      const shown = crawl.broken.slice(0, wanted)
      const linkUnits = shown.map((b) => ({
        ref: unitRef(b.source_page, b.url),
        url: b.url,
        artifact_ids: [report],
        meta: { source_page: b.source_page, link_url: b.url, anchor_text: b.text, status: b.status, error: b.status === null ? b.kind : null, kind: b.kind, detail: b.detail, observed_at: new Date().toISOString() },
      }))
      const sample = crawl.pages.filter((p) => p.status !== null && p.status >= 200 && p.status < 300).slice(0, 5).map((p) => p.url)
      const reportUnit = {
        ref: 'crawl-report',
        url: crawl.start,
        artifact_ids: [report],
        meta: { kind: 'crawl_report', start_url: crawl.start, pages_crawled: crawl.pages.length, links_checked: crawl.linksChecked + crawl.pages.length, broken_found: crawl.broken.length, pages_sample: sample, observed_at: new Date().toISOString() },
      }
      const note = [
        `Crawled ${crawl.pages.length} page(s) of ${new URL(crawl.start).host} (${crawl.requests} requests, at most 2 a second, robots.txt obeyed) and checked ${crawl.linksChecked} further link target(s): ${crawl.broken.length} broken link(s) confirmed on a second look.`,
        crawl.broken.length > wanted ? `${crawl.broken.length - wanted} more broken link(s) are in the report but beyond the ${wanted} contracted, so they are not delivered as units.` : '',
        crawl.stoppedEarly ? `The crawl stopped early: ${crawl.stoppedEarly}.` : '',
        crawl.skippedRobots.length ? `${crawl.skippedRobots.length} link(s) were not fetched because robots.txt disallows them.` : '',
        !crawl.broken.length ? 'No broken links were found on the pages crawled.' : '',
        'Each reported link was seen broken twice; the platform re-fetches the source page and the link before payment.',
      ].filter(Boolean)
      const deliverables = job.spec.deliverables.map((d) => (d.id === roles.links.id ? { deliverable_id: d.id, units: linkUnits, note: note[0]! } : { deliverable_id: d.id, units: [reportUnit], note: 'The crawl report.' }))
      return { summary: note.join('\n'), delivery: { deliverables, note: note.join(' ') } }
    },
  }
}
