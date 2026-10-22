// Lead-verification logic shared by the platform's lead_verified check and the Lead Verifier bot, so both
// apply exactly the same rules (a port of our earlier lead-checking script: address on its source page incl.
// Cloudflare-protected emails, domain has MX). Pure helpers; only node:dns is used.
import dns from 'node:dns/promises'

export interface MxRecord {
  exchange: string
  priority: number
}

export interface MxOptions {
  /** MX lookup override (tests). Default: node:dns resolveMx, then DNS-over-HTTPS when the resolver errors. */
  resolveMx?: (domain: string) => Promise<MxRecord[]>
  /** DNS-over-HTTPS fetch override (tests). */
  doh?: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; json(): Promise<unknown> }>
}

const EMAIL_RE = /^[^\s@<>()[\]"',;:\\]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i

/** Parse "name@domain.tld"; returns the lower-cased address and domain, or null. */
export function parseEmail(raw: unknown): { address: string; domain: string } | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(EMAIL_RE)
  return m ? { address: raw.trim().toLowerCase(), domain: m[1]!.toLowerCase() } : null
}

/** Decode one Cloudflare email-protection payload: first byte is the XOR key. */
export function cfDecode(hex: string): string {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return ''
  const key = parseInt(hex.slice(0, 2), 16)
  let s = ''
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key)
  return s
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&commat;|&#64;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
}
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ')

/**
 * Does `address` appear on the page? Accepts a mailto: link, plain text, an HTML-entity or %40 encoded
 * form, the written-out forms "name [at] domain", "name (at) domain" and "name at domain [dot] tld",
 * and Cloudflare-protected addresses (data-cfemail and /cdn-cgi/l/email-protection#...).
 */
export function pageHasEmail(body: string, address: string): { found: boolean; how: string } {
  const want = address.toLowerCase()
  const cf = [...body.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g), ...body.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g)].map((m) => cfDecode(m[1]!).toLowerCase())
  if (cf.some((d) => d.includes(want))) return { found: true, how: 'cloudflare-protected' }
  let raw = body
  try {
    raw = decodeURIComponent(body.replace(/%(?![0-9a-f]{2})/gi, '%25'))
  } catch {
    /* keep the raw body */
  }
  const text = decodeEntities(raw).toLowerCase()
  if (new RegExp(`mailto:\\s*${escapeRe(want)}`).test(text)) return { found: true, how: 'mailto link' }
  if (text.includes(want)) return { found: true, how: 'plain text' }
  const [local, domain] = want.split('@') as [string, string]
  const spelled = new RegExp(`${escapeRe(local)}\\s*(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\}|\\s+at\\s+)\\s*${escapeRe(domain).replace(/\\\./g, '\\s*(?:\\.|\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\s+dot\\s+)\\s*')}`)
  if (spelled.test(text)) return { found: true, how: 'written out ([at])' }
  return { found: false, how: 'not on page' }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function makeMx(opts: MxOptions = {}) {
  const resolveMx = opts.resolveMx ?? ((d: string) => dns.resolveMx(d))
  const doh =
    opts.doh ??
    (async (url: string, signal: AbortSignal) => {
      const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal })
      return { ok: r.ok, json: () => r.json() as Promise<unknown> }
    })
  /** true: accepts mail; false: definitely no MX; null: could not find out. */
  return async function hasMx(domain: string): Promise<{ result: boolean | null; via: string }> {
    try {
      const recs = await resolveMx(domain)
      const real = recs.filter((r) => r.exchange && r.exchange !== '.') // "." is the null-MX "we accept no mail" marker
      return { result: real.length > 0, via: 'dns' }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'ENODATA' || code === 'ENOTFOUND') return { result: false, via: 'dns' }
    }
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 8000)
      try {
        const r = await doh(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, ctl.signal)
        if (!r.ok) return { result: null, via: 'doh' }
        const j = (await r.json()) as { Status?: number; Answer?: { type: number; data?: string }[] }
        if (j.Status === 3) return { result: false, via: 'doh' }
        if (j.Status !== 0) return { result: null, via: 'doh' }
        const answers = (j.Answer ?? []).filter((a) => a.type === 15 && !/\s\.$/.test(a.data ?? ''))
        return { result: answers.length > 0, via: 'doh' }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return { result: null, via: 'doh' }
    }
  }
}

