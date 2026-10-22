// Email-authentication DNS audit logic, shared by the Deliverability Doctor bot and the platform's dns_claims_hold check, so both
// apply exactly the same rules. Everything that decides a finding or a DNS record to add is deterministic code here: the bot's AI
// (if any) only words the explanation. Facts come from two resolvers (the system resolver and DNS-over-HTTPS); a record counts only
// where they agree, and a name they disagree on is reported as such, never guessed.
import dns from 'node:dns/promises'
import { createHash } from 'node:crypto'
import net from 'node:net'

// ---------- resolvers ----------

export type RType = 'MX' | 'TXT'
export type DnsStatus = 'ok' | 'nodata' | 'nxdomain' | 'error'
export interface DnsAnswer {
  status: DnsStatus
  /** MX: "10 mail.example.com" (lower case, no trailing dot). TXT: the record, its strings joined. */
  records: string[]
}
export interface Resolver {
  id: 'system' | 'doh'
  resolve(name: string, type: RType): Promise<DnsAnswer>
}
export interface DnsResolvers {
  system: Resolver
  doh: Resolver
}

const NO_ANSWER: DnsAnswer = { status: 'error', records: [] }
const host = (s: string) => s.trim().toLowerCase().replace(/\.$/, '')

/** The operating system's resolver (c-ares through node:dns). */
export function systemResolver(): Resolver {
  const r = new dns.Resolver({ timeout: 4000, tries: 2 })
  return {
    id: 'system',
    async resolve(name, type) {
      try {
        if (type === 'MX') {
          const mx = await r.resolveMx(name)
          return { status: mx.length ? 'ok' : 'nodata', records: mx.map((m) => `${m.priority} ${host(m.exchange)}`) }
        }
        const txt = await r.resolveTxt(name)
        return { status: txt.length ? 'ok' : 'nodata', records: txt.map((chunks) => chunks.join('')) }
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'ENODATA') return { status: 'nodata', records: [] }
        if (code === 'ENOTFOUND') return { status: 'nxdomain', records: [] }
        return NO_ANSWER
      }
    },
  }
}

const DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']

/** Parse the data of a DoH TXT answer: one or more quoted strings that are joined. */
export function dohTxtData(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'))
  return parts.length ? parts.join('') : data
}

/** DNS-over-HTTPS (JSON API) through Cloudflare, then Google when the first one cannot answer. */
export function dohResolver(opts: { fetchImpl?: typeof fetch; endpoints?: string[]; timeoutMs?: number } = {}): Resolver {
  const doFetch = opts.fetchImpl ?? fetch
  const endpoints = opts.endpoints ?? DOH_ENDPOINTS
  return {
    id: 'doh',
    async resolve(name, type) {
      for (const ep of endpoints) {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 6000)
        try {
          const res = await doFetch(`${ep}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: ctl.signal })
          if (!res.ok) continue
          const j = (await res.json()) as { Status?: number; Answer?: { type: number; data?: string }[] }
          if (j.Status === 3) return { status: 'nxdomain', records: [] }
          if (j.Status !== 0) continue // SERVFAIL and friends: ask the next resolver
          const code = type === 'MX' ? 15 : 16
          const recs = (j.Answer ?? []).filter((a) => a.type === code && typeof a.data === 'string').map((a) => (type === 'MX' ? mxNormal(a.data!) : dohTxtData(a.data!)))
          return { status: recs.length ? 'ok' : 'nodata', records: recs }
        } catch {
          /* next endpoint */
        } finally {
          clearTimeout(timer)
        }
      }
      return NO_ANSWER
    },
  }
}

function mxNormal(data: string): string {
  const m = data.trim().match(/^(\d+)\s+(\S+)$/)
  return m ? `${Number(m[1])} ${host(m[2]!)}` : data.trim().toLowerCase()
}

export const defaultResolvers = (): DnsResolvers => ({ system: systemResolver(), doh: dohResolver() })

// ---------- combining the two resolvers ----------

export interface Fact {
  status: DnsStatus
  /** Sorted. Where the resolvers disagreed: only the records both returned. */
  records: string[]
}
interface Merged extends Fact {
  agree: boolean
}

const sorted = (xs: string[]) => [...xs].sort()
const same = (a: string[], b: string[]) => a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i])

/** What the two resolvers say about one name. One that cannot answer is ignored; both silent means "unknown" (status error). */
export async function resolveBoth(res: DnsResolvers, name: string, type: RType): Promise<Merged> {
  const ask = (r: Resolver) => r.resolve(name, type).catch((): DnsAnswer => NO_ANSWER)
  const [a, b] = await Promise.all([ask(res.system), ask(res.doh)])
  const usable = [a, b].filter((x) => x.status !== 'error')
  if (usable.length === 0) return { status: 'error', records: [], agree: false }
  if (usable.length === 1) return { status: usable[0]!.status, records: sorted(usable[0]!.records), agree: true }
  if (a.status === b.status && same(a.records, b.records)) return { status: a.status, records: sorted(a.records), agree: true }
  const both = a.records.filter((x) => b.records.includes(x))
  // "Absent" is absent whether the resolver said NODATA or NXDOMAIN; a real difference is one side having records the other lacks.
  const bothAbsent = a.records.length === 0 && b.records.length === 0
  if (bothAbsent) return { status: a.status === 'nxdomain' && b.status === 'nxdomain' ? 'nxdomain' : 'nodata', records: [], agree: true }
  return { status: both.length ? 'ok' : 'nodata', records: sorted(both), agree: false }
}

// ---------- the facts ----------

/** Selectors tried for every domain, in addition to the ones the buyer names. Part of the contract of the check: a delivery must have tried all of them. */
export const COMMON_DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 'k2', 'k3', 's1', 's2', 'mail', 'dkim', 'smtp', 'mandrill', 'mxvault', 'zoho', 'cm', 'sendgrid', 'ses']

export interface SpfLookups {
  count: number
  exceeded: boolean
  errors: string[]
}
export interface Facts {
  domain: string
  mx: Fact
  /** Apex TXT records that start with v=spf1. */
  spf: Fact
  dmarc: Fact
  mta_sts: Fact
  tls_rpt: Fact
  bimi: Fact
  /** Per selector: the TXT records at <selector>._domainkey that look like a DKIM key. */
  dkim: Record<string, Fact>
  /** DNS lookups the (single) SPF record causes; null with no SPF record or when it could not be counted. */
  spf_lookups: SpfLookups | null
  /** Names the two resolvers disagreed on. */
  unstable: string[]
}

const startsWithTag = (tag: string) => (r: string) => new RegExp(`^\\s*${tag}\\s*(;|$|\\s)`, 'i').test(r)
const isSpf = (r: string) => /^v=spf1(\s|$)/i.test(r.trim())
const isDmarc = startsWithTag('v=DMARC1')
const isSts = startsWithTag('v=STSv1')
const isTlsRpt = startsWithTag('v=TLSRPTv1')
const isBimi = startsWithTag('v=BIMI1')
const isDkim = (r: string) => /(^|;)\s*(v=DKIM1|k=rsa|k=ed25519|p=)/i.test(r)

/** The domain name rules for anything that becomes a DNS query: a plain public host name, no IP, no internal suffix. */
export function parseDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const d = raw.trim().toLowerCase().replace(/\.$/, '')
  if (d.length < 4 || d.length > 253) return null
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(d)) return null
  if (/\.(local|localhost|internal|invalid|test|example|lan|home|corp|onion)$/.test(d)) return null
  if (net.isIP(d)) return null
  return d
}

/** "a.com, b.com\nc.com" or an array: the valid domains (deduplicated, in order) and the entries that were not domains. */
export function parseDomains(input: unknown): { domains: string[]; rejected: string[] } {
  const raw = Array.isArray(input) ? input.map((x) => String(x ?? '')) : typeof input === 'string' ? input.split(/[\s,;]+/) : []
  const domains: string[] = []
  const rejected: string[] = []
  for (const t of raw.map((x) => x.trim()).filter(Boolean)) {
    const d = parseDomain(t.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    if (!d) rejected.push(t.slice(0, 60))
    else if (!domains.includes(d)) domains.push(d)
  }
  return { domains, rejected }
}

/** Selector names that may be put into a DNS query: labels only. */
export function parseSelectors(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map((x) => String(x ?? '')) : typeof input === 'string' ? input.split(/[\s,;]+/) : []
  return [...new Set(raw.map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/.test(x)))].slice(0, 20)
}

/** The selectors a delivery must have tried: the common ones plus the buyer's. */
export const selectorsFor = (buyer: string[]) => [...new Set([...COMMON_DKIM_SELECTORS, ...buyer])]

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

/** Resolve everything the audit looks at for one domain. */
export async function collectFacts(domain: string, selectors: string[], res: DnsResolvers): Promise<Facts> {
  const unstable: string[] = []
  const note = (name: string, m: Merged) => {
    if (!m.agree) unstable.push(name)
  }
  const txtOf = async (name: string, keep: (r: string) => boolean): Promise<Fact> => {
    const m = await resolveBoth(res, name, 'TXT')
    note(name, m)
    return { status: m.status, records: sorted(m.records.filter(keep)) }
  }
  const mxP = resolveBoth(res, domain, 'MX').then((m): Fact => (note(domain, m), { status: m.status, records: m.records }))
  const apex = await resolveBoth(res, domain, 'TXT')
  note(`${domain} TXT`, apex)
  const [mx, dmarc, mta_sts, tls_rpt, bimi, dkimList] = await Promise.all([
    mxP,
    txtOf(`_dmarc.${domain}`, isDmarc),
    txtOf(`_mta-sts.${domain}`, isSts),
    txtOf(`_smtp._tls.${domain}`, isTlsRpt),
    txtOf(`default._bimi.${domain}`, isBimi),
    pool(selectors, 6, async (s) => [s, await txtOf(`${s}._domainkey.${domain}`, isDkim)] as const),
  ])
  const spf: Fact = { status: apex.status, records: sorted(apex.records.filter(isSpf)) }
  const facts: Facts = { domain, mx, spf, dmarc, mta_sts, tls_rpt, bimi, dkim: Object.fromEntries(dkimList), spf_lookups: null, unstable: [] }
  if (spf.records.length === 1) {
    facts.spf_lookups = await countSpfLookups(domain, spf.records[0]!, async (name) => {
      const r = await res.system.resolve(name, 'TXT')
      return r.status === 'error' ? null : r.records
    })
  }
  facts.unstable = [...new Set(unstable)].sort()
  return facts
}

// ---------- SPF ----------

export interface SpfTerm {
  qualifier: '+' | '-' | '~' | '?'
  kind: 'all' | 'include' | 'a' | 'mx' | 'ptr' | 'ip4' | 'ip6' | 'exists' | 'redirect' | 'exp' | 'modifier'
  raw: string
}
export interface SpfParse {
  ok: boolean
  errors: string[]
  terms: SpfTerm[]
  /** The all mechanism with its qualifier ("-all"), if any. */
  all: string | null
  /** Terms after "all" (ignored by receivers). */
  afterAll: string[]
  redirect: string | null
  hasPtr: boolean
  includes: string[]
}

const MECH = /^([+\-~?])?(all|include|a|mx|ptr|ip4|ip6|exists)(?::(\S+?))?((?:\/\d{1,3})?(?:\/\/\d{1,3})?)$/i

export function parseSpf(record: string): SpfParse {
  const out: SpfParse = { ok: true, errors: [], terms: [], all: null, afterAll: [], redirect: null, hasPtr: false, includes: [] }
  const tokens = record.trim().split(/\s+/)
  if (!/^v=spf1$/i.test(tokens[0] ?? '')) {
    out.ok = false
    out.errors.push('the record does not start with "v=spf1"')
    return out
  }
  for (const raw of tokens.slice(1)) {
    const mod = raw.match(/^([a-z][a-z0-9_.-]*)=(\S*)$/i)
    if (mod) {
      const name = mod[1]!.toLowerCase()
      if (name === 'redirect') {
        if (!mod[2]) out.errors.push('"redirect=" has no domain')
        else if (out.redirect) out.errors.push('more than one "redirect=" modifier')
        out.redirect = mod[2]!.toLowerCase()
        out.terms.push({ qualifier: '+', kind: 'redirect', raw })
      } else out.terms.push({ qualifier: '+', kind: name === 'exp' ? 'exp' : 'modifier', raw })
      continue
    }
    const m = raw.match(MECH)
    if (!m) {
      out.errors.push(`unknown term "${raw.slice(0, 40)}"`)
      continue
    }
    const qualifier = (m[1] ?? '+') as SpfTerm['qualifier']
    const kind = m[2]!.toLowerCase() as SpfTerm['kind']
    const arg = m[3]
    if ((kind === 'include' || kind === 'exists') && !arg) out.errors.push(`"${kind}" needs a domain`)
    if (kind === 'ip4' && !(arg && net.isIPv4(arg.split('/')[0]!) && (arg.split('/')[1] === undefined || Number(arg.split('/')[1]) <= 32))) out.errors.push(`"${raw.slice(0, 40)}" is not a valid ip4`)
    if (kind === 'ip6' && !(arg && net.isIPv6(arg.split('/')[0]!))) out.errors.push(`"${raw.slice(0, 40)}" is not a valid ip6`)
    if (kind === 'all' && arg) out.errors.push('"all" takes no argument')
    if (out.all && kind !== 'all') out.afterAll.push(raw)
    if (kind === 'all' && !out.all) out.all = `${qualifier === '+' ? '' : qualifier}all`.toLowerCase()
    if (kind === 'ptr') out.hasPtr = true
    if (kind === 'include' && arg) out.includes.push(arg.toLowerCase())
    out.terms.push({ qualifier, kind, raw })
  }
  out.ok = out.errors.length === 0
  return out
}

/** DNS lookups an SPF record causes (RFC 7208: include, a, mx, ptr, exists and redirect count, recursively). `txt` returns null when a name cannot be resolved at all. */
export async function countSpfLookups(domain: string, record: string, txt: (name: string) => Promise<string[] | null>): Promise<SpfLookups> {
  let count = 0
  const errors: string[] = []
  const seen = new Set<string>()
  const walk = async (name: string, rec: string, depth: number): Promise<void> => {
    const p = parseSpf(rec)
    for (const t of p.terms) {
      if (['include', 'a', 'mx', 'ptr', 'exists', 'redirect'].includes(t.kind)) count++
      if (count > 30) return
    }
    for (const target of [...p.includes, ...(p.redirect ? [p.redirect] : [])]) {
      if (depth >= 10) {
        errors.push(`include depth over 10 at ${target}`)
        continue
      }
      if (seen.has(target)) {
        errors.push(`${target} is included more than once or loops`)
        continue
      }
      seen.add(target)
      const recs = await txt(target)
      if (recs === null) {
        errors.push(`could not read the SPF record of ${target}`)
        continue
      }
      const spf = recs.filter(isSpf)
      if (spf.length !== 1) {
        errors.push(spf.length === 0 ? `${target} has no SPF record` : `${target} has ${spf.length} SPF records`)
        continue
      }
      await walk(target, spf[0]!, depth + 1)
      if (count > 30) return
    }
  }
  seen.add(domain)
  await walk(domain, record, 0)
  return { count, exceeded: count > 10, errors: errors.slice(0, 6) }
}

// ---------- DMARC ----------

export function parseTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const part of record.split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim().toLowerCase()
    if (k && !(k in tags)) tags[k] = part.slice(i + 1).trim()
  }
  return tags
}

const serializeDmarc = (tags: Record<string, string>) => {
  const order = ['v', 'p', 'sp', 'rua', 'ruf', 'pct', 'adkim', 'aspf', 'fo', 'ri']
  const keys = [...order.filter((k) => k in tags), ...Object.keys(tags).filter((k) => !order.includes(k))]
  return keys.map((k) => `${k}=${tags[k]}`).join('; ')
}

/** Rough RSA key size from a DKIM p= value (the DER length of the public key). */
export function dkimKeyBits(p: string): number | null {
  const b64 = p.replace(/\s+/g, '')
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null
  const bytes = Buffer.from(b64, 'base64').length
  if (bytes < 60) return null
  if (bytes < 100) return 512
  if (bytes < 200) return 1024
  if (bytes < 400) return 2048
  return 4096
}

// ---------- findings and the records to add ----------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
}
export interface Fix {
  action: 'add' | 'replace'
  type: 'TXT'
  /** Fully-qualified record name, no trailing dot. */
  name: string
  value: string
  why: string
}
export interface Analysis {
  findings: Finding[]
  fixes: Fix[]
  /** MX hosts, for the MTA-STS policy text. */
  mx_hosts: string[]
}

const present = (f: Fact) => f.records.length > 0
const known = (f: Fact) => f.status !== 'error'
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export function analyze(facts: Facts): Analysis {
  const d = facts.domain
  const findings: Finding[] = []
  const fixes: Fix[] = []
  const add = (id: string, severity: Severity, title: string, detail: string) => findings.push({ id, severity, title, detail })
  const mxHosts = facts.mx.records.map((r) => r.split(' ')[1] ?? '').filter((h) => h && h !== '.')
  const nullMx = facts.mx.records.length > 0 && facts.mx.records.every((r) => /^\d+ \.?$/.test(r))
  const exists = facts.mx.status === 'nxdomain' && facts.spf.status === 'nxdomain' ? false : facts.mx.status === 'error' && facts.spf.status === 'error' ? null : true

  if (exists === false) {
    add('domain_not_found', 'critical', 'The domain does not exist in DNS', `Both resolvers answer NXDOMAIN for ${d}. Mail to it bounces and nothing can be authenticated.`)
    return { findings, fixes, mx_hosts: [] }
  }
  const mailEnabled = present(facts.mx) && !nullMx

  // MX
  if (!known(facts.mx)) add('mx_inconclusive', 'info', 'MX records could not be read', 'Neither resolver answered the MX query; nothing is claimed about the mail servers.')
  else if (nullMx) add('mx_null', 'info', 'The domain declares that it accepts no mail', `The MX is a null MX (${facts.mx.records[0]}), so inbound mail is refused by design.`)
  else if (!present(facts.mx)) add('mx_missing', 'high', 'No MX records', `${d} has no MX record, so senders fall back to its A record and most mail cannot be delivered. Add MX records for your mail provider.`)
  else if (facts.mx.records.length === 1) add('mx_single', 'low', 'Only one MX record', `All inbound mail goes to ${mxHosts[0]}; a second MX would keep mail flowing when it is down.`)

  // SPF
  if (known(facts.spf)) {
    if (facts.spf.records.length === 0) {
      add('spf_missing', mailEnabled ? 'high' : 'medium', 'No SPF record', mailEnabled ? `${d} has no SPF record: receivers cannot tell which servers may send for it, and anyone can spoof it.` : `${d} sends no mail but has no SPF record, so it can still be spoofed.`)
      fixes.push({
        action: 'add',
        type: 'TXT',
        name: d,
        value: mailEnabled ? 'v=spf1 mx ~all' : 'v=spf1 -all',
        why: mailEnabled ? 'Allows the servers named in your MX records to send, soft-fails everything else. Add every other service that sends mail for you (include:...) before relying on it.' : 'Declares that no server may send mail for this domain.',
      })
    } else if (facts.spf.records.length > 1) {
      add('spf_multiple', 'high', 'More than one SPF record', `${d} publishes ${facts.spf.records.length} SPF records; receivers treat that as a permanent error and ignore SPF entirely. Merge them into one.`)
      const merged = mergeSpf(facts.spf.records)
      fixes.push({ action: 'replace', type: 'TXT', name: d, value: merged, why: 'One SPF record holding every mechanism of the existing ones. Delete the other SPF records.' })
    } else {
      const rec = facts.spf.records[0]!
      const p = parseSpf(rec)
      if (p.errors.length) add('spf_syntax', 'high', 'SPF syntax error', `${p.errors.slice(0, 4).join('; ')}. A record that does not parse is a permanent error for receivers.`)
      if (p.afterAll.length) add('spf_after_all', 'low', 'Terms after "all" are ignored', `${p.afterAll.slice(0, 4).join(' ')} come after the all mechanism and have no effect.`)
      if (p.hasPtr) add('spf_ptr', 'low', 'The deprecated ptr mechanism is used', 'RFC 7208 says not to use ptr: it is slow and unreliable. Replace it with ip4/ip6 or include.')
      const setAll = (q: string) => {
        const terms = rec.trim().split(/\s+/)
        const i = terms.findIndex((t) => /^[+\-~?]?all$/i.test(t))
        if (i >= 0) terms[i] = q
        return terms.join(' ')
      }
      if (p.all === 'all' || p.all === '+all') {
        add('spf_all_plus', 'critical', 'SPF allows every sender (+all)', 'The record ends in +all (or all), which authorizes any server in the world to send as this domain. It is worse than having no SPF.')
        fixes.push({ action: 'replace', type: 'TXT', name: d, value: setAll('~all'), why: 'Changes the final qualifier to ~all so only the listed senders pass.' })
      } else if (p.all === '?all') {
        add('spf_all_neutral', 'medium', 'SPF ends in ?all (neutral)', 'A neutral result tells receivers nothing: spoofed mail is not treated differently.')
        fixes.push({ action: 'replace', type: 'TXT', name: d, value: setAll('~all'), why: 'Changes the final qualifier to ~all.' })
      } else if (p.all === '~all') add('spf_all_soft', 'info', 'SPF ends in ~all (soft fail)', 'Acceptable; move to -all once every legitimate sender is listed.')
      else if (p.all === '-all') add('spf_all_hard', 'info', 'SPF ends in -all (hard fail)', 'The strictest setting; spoofed mail fails SPF.')
      else if (!p.redirect) {
        add('spf_no_all', 'medium', 'SPF has no all mechanism', 'Without a final all (or a redirect=) the result for unlisted senders is neutral.')
        fixes.push({ action: 'replace', type: 'TXT', name: d, value: `${rec.trim()} ~all`, why: 'Appends ~all so unlisted senders soft-fail.' })
      }
      const lk = facts.spf_lookups
      if (lk?.exceeded) add('spf_lookup_limit', 'high', `SPF needs ${lk.count} DNS lookups (limit 10)`, `Receivers stop at 10 lookups and report a permanent error, so SPF fails for everyone. Remove includes you no longer use or replace some with ip4/ip6 ranges.${lk.errors.length ? ` Also: ${lk.errors.join('; ')}.` : ''}`)
      else if (lk && lk.count >= 9) add('spf_lookup_near', 'low', `SPF uses ${lk.count} of 10 DNS lookups`, 'One more include and SPF breaks. Consider flattening some includes.')
    }
  } else add('spf_inconclusive', 'info', 'SPF could not be read', 'Neither resolver answered the TXT query for the domain.')

  // DMARC
  let dmarcEnforcing = false
  if (known(facts.dmarc)) {
    const rua = `mailto:dmarc-reports@${d}`
    if (facts.dmarc.records.length === 0) {
      add('dmarc_missing', mailEnabled ? 'high' : 'medium', 'No DMARC record', `${d} publishes no DMARC policy, so receivers have no instruction for mail that fails SPF and DKIM, and you get no reports.`)
      fixes.push({ action: 'add', type: 'TXT', name: `_dmarc.${d}`, value: `v=DMARC1; p=none; rua=${rua}`, why: `Starts in monitoring mode (p=none) and sends aggregate reports to ${rua.slice(7)}: create that mailbox or change the address. Move to p=quarantine, then p=reject, once the reports look clean.` })
    } else if (facts.dmarc.records.length > 1) add('dmarc_multiple', 'high', 'More than one DMARC record', `${d} publishes ${facts.dmarc.records.length} DMARC records; receivers ignore DMARC when there is more than one. Keep one.`)
    else {
      const tags = parseTags(facts.dmarc.records[0]!)
      const policy = (tags.p ?? '').toLowerCase()
      if (!['none', 'quarantine', 'reject'].includes(policy)) add('dmarc_syntax', 'high', 'DMARC has no valid policy', `The p= tag is ${tags.p === undefined ? 'missing' : `"${tags.p.slice(0, 20)}"`}; it must be none, quarantine or reject, so the record is ignored.`)
      const desired = { ...tags }
      if (policy === 'none') {
        add('dmarc_p_none', 'medium', 'DMARC is in monitoring mode (p=none)', 'Mail that fails authentication is still delivered. Once your reports show only legitimate senders, move to p=quarantine and then p=reject.')
        desired.p = 'quarantine'
      }
      dmarcEnforcing = (policy === 'quarantine' || policy === 'reject') && (tags.pct === undefined || Number(tags.pct) === 100)
      if (!tags.rua) {
        add('dmarc_no_rua', 'low', 'DMARC sends no aggregate reports', 'Without rua= you never see who sends mail as your domain or what fails.')
        desired.rua = rua
      }
      if (tags.pct !== undefined && Number(tags.pct) < 100 && policy !== 'none') add('dmarc_pct', 'low', `DMARC applies to only ${Number(tags.pct)}% of mail`, 'pct below 100 leaves the rest unprotected; raise it to 100 once the policy is proven.')
      if (tags.sp && tags.sp.toLowerCase() === 'none' && (policy === 'quarantine' || policy === 'reject')) add('dmarc_sp_weak', 'low', 'Subdomains are not protected (sp=none)', 'Spoofed mail from subdomains of the domain is delivered even though the domain itself is enforced.')
      const next = serializeDmarc({ ...desired, v: 'DMARC1' })
      const current = serializeDmarc({ ...tags, v: tags.v ?? 'DMARC1' })
      if (next !== current && ['none', 'quarantine', 'reject'].includes(policy)) fixes.push({ action: 'replace', type: 'TXT', name: `_dmarc.${d}`, value: next, why: 'The same record with the policy raised and/or aggregate reports added.' })
    }
  } else add('dmarc_inconclusive', 'info', 'DMARC could not be read', 'Neither resolver answered the TXT query for _dmarc.')

  // DKIM
  const selectors = Object.keys(facts.dkim).sort()
  const found = selectors.filter((s) => present(facts.dkim[s]!))
  if (found.length) {
    add('dkim_found', 'info', `DKIM keys found for ${found.length} selector${found.length === 1 ? '' : 's'}`, `Found at: ${found.map((s) => `${s}._domainkey`).join(', ')}.`)
    for (const s of found) {
      const rec = facts.dkim[s]!.records[0]!
      const tags = parseTags(rec)
      if (tags.p !== undefined && tags.p.trim() === '') add(`dkim_revoked:${s}`, 'high', `The DKIM key for selector ${s} is revoked`, `${s}._domainkey.${d} has an empty p= tag, so mail signed with it fails.`)
      else if ((tags.k ?? 'rsa').toLowerCase() === 'rsa') {
        const bits = dkimKeyBits(tags.p ?? '')
        if (bits !== null && bits <= 1024) add(`dkim_key_weak:${s}`, 'medium', `The DKIM key for selector ${s} is about ${bits} bits`, 'Keys of 1024 bits or less are considered weak; rotate to 2048 bits.')
      }
    }
  } else if (mailEnabled && selectors.length) add('dkim_none_found', 'medium', 'No DKIM key found on the selectors tried', `None of the ${selectors.length} selectors tried (${selectors.slice(0, 8).join(', ')}${selectors.length > 8 ? ', ...' : ''}) has a DKIM key. This only proves those names are unused: if you sign mail, give the selector so it can be checked.`)

  // MTA-STS and TLS-RPT only matter to a domain that receives mail.
  if (mailEnabled) {
    if (known(facts.mta_sts)) {
      if (!present(facts.mta_sts)) {
        const id = createHash('sha256').update(`${d}|${mxHosts.join(',')}`).digest('hex').slice(0, 12)
        add('mta_sts_missing', 'low', 'No MTA-STS record', 'MTA-STS makes sending servers require TLS when they deliver to you, which blocks downgrade attacks.')
        fixes.push({ action: 'add', type: 'TXT', name: `_mta-sts.${d}`, value: `v=STSv1; id=${id}`, why: `Also publish the policy at https://mta-sts.${d}/.well-known/mta-sts.txt: version: STSv1, mode: testing, ${mxHosts.map((h) => `mx: ${h}`).join(', ')}, max_age: 86400 (one per line).` })
      } else add('mta_sts_present', 'info', 'MTA-STS is published', facts.mta_sts.records[0]!)
    }
    if (known(facts.tls_rpt)) {
      if (!present(facts.tls_rpt)) {
        add('tls_rpt_missing', 'low', 'No TLS-RPT record', 'TLS-RPT sends you reports when other servers cannot deliver to you over TLS.')
        fixes.push({ action: 'add', type: 'TXT', name: `_smtp._tls.${d}`, value: `v=TLSRPTv1; rua=mailto:tls-reports@${d}`, why: `Reports go to tls-reports@${d}: create that mailbox or change the address.` })
      } else add('tls_rpt_present', 'info', 'TLS-RPT is published', facts.tls_rpt.records[0]!)
    }
  }

  // BIMI
  if (known(facts.bimi)) {
    if (present(facts.bimi) && !dmarcEnforcing) add('bimi_needs_dmarc', 'medium', 'BIMI is published but DMARC is not enforcing', 'Mailbox providers show a BIMI logo only for domains whose DMARC policy is quarantine or reject at 100%.')
    else if (!present(facts.bimi) && dmarcEnforcing) add('bimi_missing', 'info', 'No BIMI record', 'DMARC is enforcing, so you qualify to show your logo in inboxes. BIMI needs an SVG logo URL (and usually a certificate), so no record is generated here.')
    else if (present(facts.bimi)) add('bimi_present', 'info', 'BIMI is published', facts.bimi.records[0]!)
  }

  if (facts.unstable.length) add('resolvers_disagree', 'low', 'The two resolvers disagree', `The system resolver and DNS-over-HTTPS returned different answers for: ${facts.unstable.slice(0, 6).join(', ')}${facts.unstable.length > 6 ? ', ...' : ''}. This is usually a change still propagating; only what both agree on is used.`)

  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id))
  return { findings, fixes, mx_hosts: mxHosts }
}

function mergeSpf(records: string[]): string {
  const terms: string[] = []
  let all: string | null = null
  for (const r of records) {
    for (const t of r.trim().split(/\s+/).slice(1)) {
      if (/^[+\-~?]?all$/i.test(t)) all ??= /^[+?]?all$/i.test(t) ? '~all' : t.toLowerCase() // never carry a permissive all into the merged record
      else if (!terms.includes(t)) terms.push(t)
    }
  }
  return ['v=spf1', ...terms, all ?? '~all'].join(' ')
}

// ---------- comparing a claim with what was found ----------

const key = (f: Fact) => `${f.status === 'error' ? 'error' : f.records.length ? 'present' : 'absent'}|${f.records.join('\n')}`

/** Differences between the facts a unit claims and the facts the platform found now. Empty: they agree. */
export function factsDiff(claimed: unknown, actual: Facts): string[] {
  const diffs: string[] = []
  const c = claimed as Partial<Facts> | null
  if (!c || typeof c !== 'object') return ['the unit has no facts']
  const cmp = (name: string, a: unknown, b: Fact) => {
    const f = a as Fact | undefined
    if (!f || !Array.isArray(f.records) || typeof f.status !== 'string') diffs.push(`${name}: not claimed`)
    else if (key({ status: f.status, records: f.records.map(String) }) !== key(b)) diffs.push(`${name}: the unit says ${describe(f)}, DNS says ${describe(b)}`)
  }
  cmp('MX', c.mx, actual.mx)
  cmp('SPF', c.spf, actual.spf)
  cmp('DMARC', c.dmarc, actual.dmarc)
  cmp('MTA-STS', c.mta_sts, actual.mta_sts)
  cmp('TLS-RPT', c.tls_rpt, actual.tls_rpt)
  cmp('BIMI', c.bimi, actual.bimi)
  const cd = (c.dkim && typeof c.dkim === 'object' ? c.dkim : {}) as Record<string, Fact>
  for (const s of Object.keys(actual.dkim)) cmp(`DKIM ${s}`, cd[s], actual.dkim[s]!)
  for (const s of Object.keys(cd)) if (!(s in actual.dkim)) diffs.push(`DKIM ${s}: claimed for a selector that was not asked for`)
  const lk = c.spf_lookups
  if ((lk?.count ?? null) !== (actual.spf_lookups?.count ?? null)) diffs.push(`SPF lookups: the unit says ${lk ? lk.count : 'none'}, the count is ${actual.spf_lookups ? actual.spf_lookups.count : 'none'}`)
  return diffs
}

function describe(f: Fact): string {
  if (f.status === 'error') return 'unknown'
  return f.records.length ? f.records.map((r) => `"${r.slice(0, 80)}"`).join(' + ') : 'nothing'
}

/** The set of finding ids with severity, and the set of fixes, as comparable strings. */
export const findingKeys = (fs: { id: string; severity: string }[]) => fs.map((f) => `${f.id}:${f.severity}`).sort()
export const fixKeys = (fs: { action: string; type: string; name: string; value: string }[]) => fs.map((f) => `${f.action}|${f.type}|${f.name.toLowerCase()}|${f.value}`).sort()
