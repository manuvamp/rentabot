// Lead Verifier, second skill `find_leads`: "Find verified leads at your target companies".
//   1. For each of 1-10 company domains the bot asks Hunter.io (its OWN account, key in env HUNTER_API_KEY) for the addresses
//      it knows, at most 10 per domain (the free plan's cap), each with the source pages Hunter saw it on.
//      For type "generic" it keeps only addresses whose local part is clearly a role mailbox (isRoleAddress): Hunter's filter leaks
//      personal staff IDs (production job job_mvgm1t51sbfGwFRfJx2W61, 2026-10-20).
//   2. For each address it picks a source page (the searched domain's own pages first, then still_on_page) and runs the Lead Verifier's own rule, verifyLead: the
//      exact address is on that page and its domain has MX records. That is what the platform's lead_verified check re-runs.
//   3. Only leads that pass are delivered, so only they can be paid. A candidate that does not pass is counted in the note and
//      is NOT a unit: an honest "not verified" unit would also pass lead_verified and be paid, which a finder must not do.
// Hunter's free plan is 50 domain searches a month for the whole bot, so the bot reads GET /v2/account (free) before it quotes
// and again before it works, and quotes fewer leads or declines when the searches left cannot cover the job.
// Hunter's data is a lead source only. Nothing is claimed that the page check did not confirm, and the key never reaches a
// log, a message, a delivery, an error or a prompt (see hunter.ts).
import { asString, badAsk, needsSchema, primary, str } from '../common.ts'
import { createHunter, allowed, HUNTER_DEPARTMENTS, HUNTER_PER_SEARCH, HUNTER_SENIORITY, HUNTER_TYPES, HunterError, type Hunter, type HunterEmail, type HunterFilters, type HunterOptions } from '../hunter.ts'
import { createPoliteWeb, type PoliteWeb } from '../web.ts'
import { parseDomain, parseDomains, parseEmail, type MxOptions } from '../server-shared.ts'
import { buildQuote, settlementWarning, type QuoteContext, type QuoteDecision, type SellerBot, type WorkJob, type WorkResult, type WorkTools } from '../runtime.ts'
import { cents, amount, type JobSpec } from '@rentabot/shared'
import { createVerifyContext, verifyLead } from './lead-verifier.ts'

export interface LeadFinderOptions {
  web?: PoliteWeb
  /** Hosts that skip the public-address guard (local fixtures in tests). */
  allowHosts?: string[]
  /** DNS overrides (tests). */
  mx?: MxOptions
  /** A ready Hunter client, or options for one (tests inject a mock fetch). Default: key from HUNTER_API_KEY. */
  hunter?: Hunter | HunterOptions
}

/** One job covers at most this many domains (each costs one of the month's Hunter searches). */
export const MAX_DOMAINS = 10
const SKILL_ID = 'find_leads'
const UNIT = 'verified_lead'
/** Source pages tried per address before it is given up on. */
const SOURCES_PER_ADDRESS = 2
const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'btinternet.com', 'hotmail.co.uk', 'yahoo.co.uk', 'me.com', 'msn.com'])
const NOT_TLDS = new Set(['csv', 'json', 'txt', 'md', 'pdf', 'html', 'htm', 'js', 'ts', 'xml', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'doc', 'docx', 'xls', 'xlsx', 'py', 'exe'])

const isHunter = (h: Hunter | HunterOptions): h is Hunter => typeof (h as Hunter).domainSearch === 'function'

/** Company domains named in free text (a goal or a deliverable description): URLs and bare names, never the part of an address. */
export function domainsInText(text: string): string[] {
  const out: string[] = []
  const plain = text.replace(/[^\s<>"']+@[^\s<>"']+/g, ' ')
  for (const m of plain.matchAll(/(?:https?:\/\/)?((?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z0-9-]{1,})/gi)) {
    const d = parseDomain(m[1]!.toLowerCase().replace(/^www\./, '').replace(/\.+$/, ''))
    if (d && !NOT_TLDS.has(d.split('.').pop()!) && !out.includes(d)) out.push(d)
  }
  return out
}

/** The buyer's domains from the inputs (array or comma/space/newline text): valid, de-duplicated, no free webmail providers. */
export function domainsOf(raw: unknown): { domains: string[]; rejected: string[] } {
  const cleaned = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : []).map((x) => String(x ?? '').trim().replace(/^@/, '').replace(/^(https?:\/\/)?www\./i, '$1'))
  const { domains, rejected } = parseDomains(cleaned)
  const mail = domains.filter((d) => FREEMAIL.has(d))
  return { domains: domains.filter((d) => !FREEMAIL.has(d)), rejected: [...rejected, ...mail] }
}

const DEPT_WORD = '(marketing|sales|finance|legal|support|hr|operations|design|executive|management|communications?|education|health)'
const AFTER = '\\s+(?:leads?|contacts?|people|team|staff|roles?|managers?|folks|decision[- ]makers|professionals)\\b'

/** "marketing leads" in the goal means Hunter's marketing department, when the buyer gave no filter of their own. */
function inferDepartment(goal: string): string[] {
  const m = new RegExp(`\\b${DEPT_WORD}${AFTER}`, 'i').exec(goal) ?? /\b(IT)\s+(?:leads?|contacts?|people|team|staff)\b/.exec(goal)
  if (!m) return []
  const w = m[1]!.toLowerCase()
  return allowed(w === 'communications' ? 'communication' : w, HUNTER_DEPARTMENTS)
}

const ROLE_ASK = /\b(?:generic|role|role[- ]based|functional|general|departmental|shared|office)\s+(?:e-?mail\s+|contact\s+)?(?:addresses|mailboxes|inboxes|e-?mails|accounts)\b|\b(?:info|admissions|press|contact|enquiries|hello|support)@(?![a-z0-9-]+\.[a-z])/gi
const NEGATED = /\b(?:not|no|never|exclud\w*|without|except|avoid\w*|skip\w*)\b[^.;:\n]{0,24}$/i

/**
 * Does the request ask for role addresses ("generic role email addresses", "info@ style", "not named people")? Then the job is
 * type "generic" even when the buyer never sends `type`: the Spec Copilot has no place for it in the spec (production job
 * job_mvgm1t51sbfGwFRfJx2W61 needed a separate provide_inputs for it). Only "generic" is inferred: it narrows what is delivered.
 */
export function asksForRoleAddresses(text: string): boolean {
  if (/\bnot\s+(?:to\s+)?(?:named\s+)?(?:people|persons|individuals|staff)\b/i.test(text)) return true
  // "named people, not generic addresses" asks for the opposite: a negation just before the phrase cancels it.
  for (const m of text.matchAll(ROLE_ASK)) if (!NEGATED.test(text.slice(Math.max(0, m.index - 30), m.index))) return true
  return false
}

/** The request as the bot reads it for filters and domains: the goal and the deliverable descriptions (both are in the contract). */
const requestText = (spec: JobSpec) => [spec.goal, ...spec.deliverables.map((d) => d.description)].join('\n')

function filtersOf(inputs: Record<string, unknown>, spec: JobSpec): HunterFilters {
  const department = allowed(inputs.department, HUNTER_DEPARTMENTS)
  const seniority = allowed(inputs.seniority, HUNTER_SENIORITY)
  const type = allowed(inputs.type, HUNTER_TYPES)[0] ?? (asksForRoleAddresses(requestText(spec)) ? 'generic' : undefined)
  return { department: department.length ? department : inferDepartment(spec.goal), seniority, ...(type ? { type } : {}) }
}

const describeFilters = (f: HunterFilters) => [f.department?.length ? `department ${f.department.join('+')}` : '', f.seniority?.length ? `seniority ${f.seniority.join('+')}` : '', f.type ? `${f.type} addresses` : ''].filter(Boolean).join(', ')

/** Is this page on the searched domain or one of its subdomains? */
export function onSearchedSite(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
    return host === domain || host.endsWith(`.${domain}`)
  } catch {
    return false
  }
}

/**
 * The source pages to try for one address: pages on the searched domain (or its subdomains) first, then still_on_page, then the
 * most recently seen; public http(s) URLs only. So a third-party page is tried only when no own-domain page is listed or verifies.
 */
export function sourcesFor(e: HunterEmail, domain?: string): string[] {
  const seen = new Set<string>()
  const own = (u: string) => (domain ? Number(onSearchedSite(u, domain)) : 0)
  return e.sources
    .filter((s) => /^https?:\/\//i.test(s.uri))
    .sort((a, b) => own(b.uri) - own(a.uri) || Number(b.stillOnPage === true) - Number(a.stillOnPage === true) || (b.lastSeenOn || '').localeCompare(a.lastSeenOn || ''))
    .map((s) => s.uri)
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
    .slice(0, SOURCES_PER_ADDRESS)
}

/** Words that make a mailbox a role or functional address (info@, admissions@, press@). One is required. */
export const ROLE_WORDS = [
  'info', 'information', 'contact', 'contacts', 'contactus', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'query', 'queries', 'questions', 'ask',
  'admissions', 'admission', 'admit', 'apply', 'applications', 'press', 'media', 'news', 'newsroom', 'pr', 'comms', 'communications', 'communication',
  'office', 'hello', 'support', 'help', 'helpdesk', 'servicedesk', 'sales', 'admin', 'administration', 'team', 'jobs', 'careers', 'career',
  'recruitment', 'recruiting', 'hr', 'people', 'finance', 'accounts', 'billing', 'payroll', 'procurement', 'purchasing', 'marketing', 'events', 'event',
  'webmaster', 'postmaster', 'hostmaster', 'registrar', 'registry', 'records', 'alumni', 'development', 'giving', 'library', 'reception',
  'frontdesk', 'general', 'service', 'services', 'feedback', 'partners', 'partnerships', 'partnership', 'sponsorship',
  'business', 'legal', 'compliance', 'privacy', 'dpo', 'security', 'abuse', 'it', 'outreach', 'membership', 'members', 'bookings', 'booking',
  'reservations', 'tickets', 'orders', 'shop', 'store', 'mail', 'enrol', 'enroll', 'enrolment', 'enrollment', 'visit', 'visitors',
  'tours', 'conference', 'conferences', 'investors', 'ir', 'research', 'secretary', 'secretariat', 'operations', 'facilities', 'editor', 'editorial',
  'archive', 'archives', 'collections',
] as const
/** Words that may qualify a role word (undergraduate.admissions, pressoffice, ugadmissions) but are never enough on their own. */
const QUALIFIERS = [
  'undergraduate', 'undergrad', 'graduate', 'grad', 'postgraduate', 'postgrad', 'ug', 'pg', 'international', 'intl', 'student', 'students', 'customer',
  'customers', 'client', 'clients', 'main', 'central', 'head', 'us', 'uk', 'eu', 'global', 'online', 'public', 'the', 'of', 'and', 'dept', 'department',
  'school', 'college', 'university', 'uni', 'faculty', 'campus', 'corporate', 'group', 'future', 'prospective', 'relations', 'affairs', 'centre',
  'center', 'line', 'desk', 'staff', 'visiting', 'summer', 'exec', 'executive', 'education', 'web', 'new', 'local', 'national',
  'data', 'digital', 'deans',
]
const ROLE_SET = new Set<string>(ROLE_WORDS)
const WORDS = new Set<string>([...ROLE_WORDS, ...QUALIFIERS])
/** Mailboxes nobody reads, and placeholders: never a lead, even when a role word is in them. */
const NOT_A_LEAD = /^(no-?reply|do-?not-?reply|donotreply|bounces?|mailer-daemon|test|example|sample|user|username|name|yourname|firstname|lastname|email|abcd?\d*|xxx+|placeholder)$/

/** Can this token be read entirely as known words, with at least one role word? true / false (words, no role word) / null (not words). */
function readsAsRole(token: string, extra: Set<string>): boolean | null {
  const t = token.replace(/\d+$/, '') // info2, hr1: trailing digits after a word are fine
  if (!t || /\d/.test(t)) return null // digits inside (kq01x): an ID, not a word
  // best[i]: 0 = t[0..i) cannot be split into known words, 1 = it can (qualifiers only), 2 = it can, with a role word
  const best: number[] = new Array(t.length + 1).fill(0)
  best[0] = 1
  for (let i = 1; i <= t.length; i++) {
    for (let j = Math.max(0, i - 20); j < i; j++) {
      if (!best[j]) continue
      const w = t.slice(j, i)
      if (!WORDS.has(w) && !extra.has(w)) continue
      best[i] = Math.max(best[i]!, ROLE_SET.has(w) ? 2 : best[j]!)
    }
  }
  return best[t.length] === 2 ? true : best[t.length] === 1 ? false : null
}

/**
 * Is this address clearly a role or functional mailbox (info@, admissions@, press-office@, undergraduate.admissions@) rather than a
 * person? Every part of the local part (split on dots, dashes, underscores and plus signs; run-together words such as pressoffice
 * are read too) must be a known role word, a qualifier, the institution's own name or digits, and at least one must be a role word.
 * Opaque IDs (kq01, zx892), names (mlarkin, j.smith), initials-plus-digits and placeholders (abcd1234) fail.
 * `domain` lets the institution's own name qualify a role word (mitadmissions@mit.edu).
 */
export function isRoleAddress(address: string, domain?: string): boolean {
  const at = address.lastIndexOf('@')
  const local = (at > 0 ? address.slice(0, at) : address).toLowerCase().trim()
  if (!local || NOT_A_LEAD.test(local)) return false
  const host = (domain ?? (at > 0 ? address.slice(at + 1) : '')).toLowerCase()
  const extra = new Set(host.split('.').filter((x) => x.length >= 3 && !['com', 'org', 'net', 'edu', 'gov', 'www'].includes(x)))
  const tokens = local.split(/[._+-]+/).filter(Boolean)
  if (!tokens.length || tokens.some((t) => NOT_A_LEAD.test(t))) return false
  let role = false
  for (const t of tokens) {
    if (/^\d+$/.test(t)) continue
    const r = readsAsRole(t, extra)
    if (r === null) return false
    if (r) role = true
  }
  return role
}

const onDomain = (email: string, domain: string) => {
  const d = parseEmail(email)?.domain
  return !!d && (d === domain || d.endsWith(`.${domain}`))
}

/** The order candidates are checked in: the company's own addresses first, free webmail last, then Hunter's confidence. */
function ranked(emails: HunterEmail[], domain: string): HunterEmail[] {
  const score = (e: HunterEmail) => (onDomain(e.value, domain) ? 0 : 2) + (FREEMAIL.has(parseEmail(e.value)?.domain ?? '') ? 4 : 0)
  return emails.filter((e) => parseEmail(e.value)).sort((a, b) => score(a) - score(b) || b.confidence - a.confidence)
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : /(s|ch)$/.test(w) ? 'es' : 's'}`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function leadFinder(opts: LeadFinderOptions = {}): SellerBot {
  const web = opts.web ?? createPoliteWeb({ allowHosts: opts.allowHosts, perSecond: 2, timeoutMs: 15_000 })
  const hunter: Hunter = opts.hunter && isHunter(opts.hunter) ? opts.hunter : createHunter(opts.hunter)
  const emptyDelivery = (job: WorkJob, note: string): WorkResult => ({ summary: note, delivery: { deliverables: [{ deliverable_id: primary(job.spec).id, units: [], note: clip(note, 1900) }], note: clip(note, 3900) } })

  /** Company domains the request itself names (goal and deliverable descriptions, so they are in the contract the buyer signs). */
  const namedDomains = (spec: JobSpec): string[] => domainsInText(requestText(spec)).filter((d) => !FREEMAIL.has(d))
  /** Domains the buyer gave (inputs) or, when they have not, the ones the request names; null when none are known. */
  const knownDomains = (spec: JobSpec, inputs: Record<string, unknown>): string[] | null => {
    const given = domainsOf(inputs.domains).domains
    if (given.length) return given
    const named = namedDomains(spec)
    return named.length ? named : null
  }
  /** The request names usable domains (1-10), so the job can start without a separate `domains` input. */
  const startsFromRequest = (spec: JobSpec) => {
    const named = namedDomains(spec)
    return named.length > 0 && named.length <= MAX_DOMAINS
  }

  return {
    slug: 'lead-finder',
    name: 'Lead Verifier',
    skillId: SKILL_ID,
    // One at a time: every job spends the same monthly Hunter searches, and the account is read before each.
    maxConcurrent: 1,

    scope(spec) {
      if (spec.deliverables.length > 1) return 'I deliver one deliverable of leads per job.'
      if (!hunter.configured) return 'My Hunter.io access is not set up right now, so I cannot find leads. Nothing was quoted or charged; please try again later or hire a bot that finds leads another way.'
      return badAsk(spec)
    },

    requirements(spec) {
      const named = startsFromRequest(spec) ? namedDomains(spec) : []
      return {
        inputs_schema: needsSchema(
          {
            domains: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_DOMAINS, description: `1 to ${MAX_DOMAINS} company domains to find leads at, e.g. ["acme.com"]. Each gives at most ${HUNTER_PER_SEARCH} leads.` },
            department: str(`Optional. Only people in these departments (comma separated): ${HUNTER_DEPARTMENTS.join(', ')}.`),
            seniority: str(`Optional. Only these seniority levels (comma separated): ${HUNTER_SENIORITY.join(', ')}.`),
            type: str('Optional. "personal" (a named person) or "generic" (role addresses such as info@, admissions@, press@: only addresses whose name is clearly a role are delivered).'),
          },
          named.length ? [] : ['domains'],
        ),
        access: [],
        assumptions: [
          ...(named.length ? [clip(`Domains: I search the ${plural(named.length, 'domain')} your request names (${named.join(', ')}). Send \`domains\` only to search others instead.`, 300)] : []),
          ...(asksForRoleAddresses(requestText(spec)) ? ['Your request asks for role addresses, so this job is type "generic" without a separate input: only addresses whose name is clearly a role or office are delivered.'] : []),
          `I search each domain once on Hunter.io, a real account I own (you need none): at most ${HUNTER_PER_SEARCH} leads per domain, so ${MAX_DOMAINS} domains give at most ${MAX_DOMAINS * HUNTER_PER_SEARCH} leads.`,
          'For each address I open the source page Hunter reports and check the exact address is on it and its domain has MX records: the same rule the platform re-runs. I deliver only leads that pass, so you pay only for leads the platform re-verifies.',
          'Hunter.io\'s free plan allows 50 domain searches a month for the whole bot. I check what is left before I quote and decline or quote fewer leads when there are not enough. I never promise more than 10 leads per domain.',
          'Public business addresses only; free webmail addresses are flagged. A department filter in your request ("marketing leads") is applied through Hunter when it names one.',
          'Type "generic": I deliver only addresses whose name is clearly a role or office (info@, admissions@, press-office@, undergraduate.admissions@). Ones that look personal (staff IDs, names, placeholders) are left out and counted. Hunter\'s own filter is not trusted for this.',
          'I prefer source pages on the domain you named. A lead verified only on another site is flagged third_party_source; for role addresses another site is used only when no page on your domain verifies.',
        ],
        questions: [],
      }
    },

    async quote(spec, skill, ctx?: QuoteContext): Promise<QuoteDecision> {
      if (!hunter.configured) return { ok: false, reason: 'my Hunter.io access is not set up right now, so I cannot find leads.' }
      const want = primary(spec).quantity
      const named = knownDomains(spec, ctx?.inputs ?? {})
      if (named && named.length > MAX_DOMAINS) return { ok: false, reason: `one job covers at most ${MAX_DOMAINS} domains; ${named.length} were named. Please split it.` }
      if (named && want > named.length * HUNTER_PER_SEARCH) return { ok: false, reason: `I find at most ${HUNTER_PER_SEARCH} leads per domain: ${plural(named.length, 'domain')} give at most ${named.length * HUNTER_PER_SEARCH} leads and ${want} were asked for. Add domains or ask for fewer.` }
      const base = buildQuote(spec, skill, { priced: [primary(spec).id] })
      if (!base.ok) return base
      let acct
      try {
        acct = await hunter.account()
      } catch (e) {
        return { ok: false, reason: `I could not check how many Hunter.io searches I have left (${e instanceof HunterError ? e.message : 'unexpected error'}). Please ask again later.`.slice(0, 400) }
      }
      const resets = acct.resetDate ? `, resets ${acct.resetDate}` : ''
      if (acct.searchesLeft < 1) return { ok: false, reason: `this month's Hunter.io domain searches are used up${resets}. Please ask again after that.` }
      // Leads I can promise: at most 10 per search I can still run, and no more searches than the job has domains.
      const searchable = Math.min(named ? named.length : MAX_DOMAINS, acct.searchesLeft)
      const reachable = searchable * HUNTER_PER_SEARCH
      const line = base.quote.lines[0]!
      const unit = cents(line.unit_price)
      const budgeted = Math.floor(cents(line.max_total) / unit)
      const payable = Math.min(budgeted, want, reachable)
      if (payable * unit < 500) {
        return { ok: false, reason: `only ${plural(acct.searchesLeft, 'Hunter.io search')} are left this month${resets}, enough for at most ${reachable} leads ($${amount(reachable * unit)}), below the platform's $5.00 minimum job. Please ask again later.`.slice(0, 400) }
      }
      const excludes = base.quote.excludes.filter((x) => !x.startsWith('Minimum settlement:'))
      if (payable < budgeted) {
        line.max_total = amount(unit * payable)
        base.quote.total_max = { value: amount(unit * payable), currency: 'USD' }
        excludes.push(`Hunter.io quota: only ${plural(acct.searchesLeft, 'domain search')} left this month${resets}; at most ${payable} leads can be found, so only the first ${payable} are priced.`.slice(0, 200))
      }
      excludes.push(`At most ${HUNTER_PER_SEARCH} leads per domain; a lead the platform cannot re-verify is not delivered and not paid.`)
      const warning = settlementWarning(unit, payable, UNIT)
      if (warning) excludes.push(warning)
      return { ok: true, quote: { ...base.quote, excludes } }
    },

    missingInputs(inputs, spec) {
      return domainsOf(inputs.domains).domains.length || (inputs.domains === undefined && startsFromRequest(spec)) ? [] : ['domains']
    },

    clarify(question) {
      if (/quota|limit|month|free plan|how many|searches|per domain|maximum|at most/i.test(question)) return `I use my own Hunter.io account on its free plan: 50 domain searches a month for all buyers, at most ${HUNTER_PER_SEARCH} leads per domain. I read what is left before I quote, and I quote fewer leads or decline when there is not enough.`
      if (/how|method|verify|check|source|where/i.test(question)) return 'I search each domain on Hunter.io, then open the source page Hunter reports for each address and look for the exact address (mailto link, plain text, "[at]" form or a Cloudflare-protected address) and check the domain has MX records. Only leads that pass are delivered; the platform re-runs the same check before you pay.'
      return null
    },

    async work(job: WorkJob, tools: WorkTools): Promise<WorkResult> {
      const want = primary(job.spec).quantity
      const id = primary(job.spec).id
      if (!hunter.configured) return emptyDelivery(job, 'No leads were found: my Hunter.io access is not set up, so nothing was searched and nothing is owed.')
      // Domains the buyer sent win; without them, the ones the request (the signed contract) names.
      const { domains: all, rejected } = job.inputs.domains === undefined && startsFromRequest(job.spec) ? { domains: namedDomains(job.spec), rejected: [] as string[] } : domainsOf(job.inputs.domains)
      if (all.length === 0) return emptyDelivery(job, `No leads were found: none of the domains you gave is a company domain${rejected.length ? ` (${rejected.slice(0, 5).map((r) => `"${r}"`).join(', ')})` : ''}.`)
      const notes: string[] = []
      if (rejected.length) notes.push(`Not searched (not a company domain): ${rejected.slice(0, 5).join(', ')}.`)
      let domains = all.slice(0, MAX_DOMAINS)
      if (all.length > MAX_DOMAINS) notes.push(`Only the first ${MAX_DOMAINS} domains are searched; ${all.length - MAX_DOMAINS} were left out.`)

      // The month's searches are shared and used by other jobs: read what is left now, not what the quote assumed.
      let acct
      try {
        acct = await hunter.account({ fresh: true })
      } catch (e) {
        return emptyDelivery(job, `No leads were found: I could not reach my Hunter.io account (${e instanceof HunterError ? e.message : 'unexpected error'}). Nothing was searched and nothing is owed.`)
      }
      if (acct.searchesLeft < domains.length) {
        notes.push(`Hunter.io quota: ${plural(acct.searchesLeft, 'search')} left this month, so only the first ${plural(Math.max(0, acct.searchesLeft), 'domain')} could be searched.`)
        domains = domains.slice(0, Math.max(0, acct.searchesLeft))
      }
      if (domains.length === 0) return emptyDelivery(job, 'No leads were found: this month\'s Hunter.io domain searches are used up. Nothing was searched and nothing is owed.')

      const filters = filtersOf(job.inputs, job.spec)
      if (describeFilters(filters)) notes.push(`Filters: ${describeFilters(filters)}.`)

      // 1) Hunter: one search per domain.
      const pools = new Map<string, HunterEmail[]>()
      const orgs = new Map<string, string>()
      let searched = 0
      let candidates = 0
      let personalLike = 0
      for (const domain of domains) {
        if (tools.signal.aborted) break
        try {
          const r = await hunter.domainSearch(domain, filters)
          searched++
          orgs.set(domain, r.organization)
          if (r.webmail) {
            notes.push(`${domain} is a free webmail provider, not a company: no leads taken.`)
            continue
          }
          const listed = ranked(r.emails, domain)
          candidates += listed.length
          // Hunter's type=generic filter (and its per-address type) does not hold: personal staff IDs come back too. A buyer who
          // asked for role addresses gets only local parts that clearly are one; the rest are counted in the note, never units.
          const list = filters.type === 'generic' ? listed.filter((e) => isRoleAddress(e.value, domain)) : listed
          personalLike += listed.length - list.length
          pools.set(domain, list)
          tools.log('hunter_search', { domain, found: r.emails.length, total: r.total })
          if (r.emails.length === 0) notes.push(`Hunter.io knows no address for ${domain}${describeFilters(filters) ? ' with those filters' : ''}.`)
        } catch (e) {
          const err = e instanceof HunterError ? e : null
          tools.log('hunter_search', { domain, ok: false, error: err ? err.kind : 'unexpected' })
          notes.push(`${domain}: ${err ? err.message : 'the search failed'}.`.slice(0, 300))
          if (err && (err.kind === 'quota' || err.kind === 'auth' || err.kind === 'rate_limit' || err.kind === 'no_key')) {
            notes.push('Stopped searching: Hunter.io would not answer further requests.')
            break
          }
        }
      }

      // 2) the Lead Verifier's own rule on each candidate, a fair share per domain first, then the leftovers.
      const target = Math.min(want, domains.length * HUNTER_PER_SEARCH)
      const ctx = createVerifyContext(web, opts.mx)
      const units: WorkResult['delivery']['deliverables'][number]['units'] = []
      const stats = { no_source: 0, not_verified: 0 }
      const live = [...pools.keys()]
      const share = Math.max(1, Math.ceil(target / Math.max(1, live.length)))
      const taken = new Map<string, number>()
      let checked = 0
      const tryNext = async (domain: string): Promise<boolean> => {
        const pool = pools.get(domain)!
        for (;;) {
          const e = pool.shift()
          if (!e || tools.signal.aborted) return false
          const sources = sourcesFor(e, domain)
          if (sources.length === 0) {
            stats.no_source++
            continue
          }
          let good: { url: string; why: string; flags: string[] } | null = null
          for (const url of sources) {
            const v = await verifyLead({ to: e.value, company: orgs.get(domain) || domain, domain, email_source_url: url }, ctx)
            if (v.verified) {
              good = { url, why: v.why, flags: onSearchedSite(url, domain) ? v.flags : [...v.flags, 'third_party_source'] }
              break
            }
          }
          if (!good) {
            stats.not_verified++
            continue
          }
          units.push({
            ref: `lead-${units.length + 1}`,
            url: good.url,
            artifact_ids: [],
            meta: {
              to: e.value,
              company: orgs.get(domain) || domain,
              domain,
              email_source_url: good.url,
              verified: true,
              why: good.why,
              flags: good.flags,
              first_name: e.firstName,
              last_name: e.lastName,
              position: e.position,
              department: e.department,
              seniority: e.seniority,
              found_via: 'Hunter.io domain search',
            },
          })
          taken.set(domain, (taken.get(domain) ?? 0) + 1)
          if (++checked % 5 === 0) await tools.progress(Math.min(95, Math.round((units.length / Math.max(1, target)) * 95)), `${units.length}/${target} leads verified`)
          return true
        }
      }
      for (const domain of live) while (units.length < target && (taken.get(domain) ?? 0) < share && (await tryNext(domain))) { /* one more verified lead for this domain */ }
      for (let progress = true; progress && units.length < target; ) {
        progress = false
        for (const domain of live) if (units.length < target && (await tryNext(domain))) progress = true
      }

      const dropped = stats.no_source + stats.not_verified
      const head = `Searched ${plural(searched, 'domain')} on Hunter.io (${plural(candidates, 'address')} listed). Delivered ${plural(units.length, 'verified lead')} of the ${want} asked for: each address is on its source page and its domain has MX records, the rule the platform re-runs.`
      const tail = [
        personalLike ? `${plural(personalLike, 'address')} looked personal, not a role address, and ${personalLike === 1 ? 'was' : 'were'} left out (not delivered, not paid).` : '',
        dropped ? `${plural(dropped, 'listed address')} not delivered and not paid: ${stats.not_verified ? `${stats.not_verified} no longer on their source page or without MX records` : ''}${stats.not_verified && stats.no_source ? ', ' : ''}${stats.no_source ? `${stats.no_source} with no source page` : ''}.` : '',
        units.length < want ? `At most ${HUNTER_PER_SEARCH} leads per domain, and only verified leads count, so ${want - units.length} fewer than asked.` : '',
        ...notes,
        `${web.requests} page/DNS-over-HTTPS requests were made, at most 2 per second.`,
      ].filter(Boolean)
      const all2 = [head, ...tail].join('\n')
      return { summary: all2, delivery: { deliverables: [{ deliverable_id: id, units, note: clip(head, 1900) }], note: clip(all2.replace(/\n/g, ' '), 3900) } }
    },
  }
}
