// Link extraction and the "is this link broken?" rule, shared by the Broken Link Hunter bot and the platform's broken_link_confirmed
// check, so both apply exactly the same definition. Pure functions only.
//
// What counts as broken (judged on the final response, after redirects):
//   - definitely broken: HTTP 400, 404 or 410; a domain that does not resolve; an invalid TLS certificate.
//   - server error (HTTP 5xx, connection refused): broken only if it is seen again on a second look (it may be a blip).
//   - restricted (401, 403, 405, 406, 429, 451, 999): the site may be refusing robots, not broken: never reported.
//   - transient (timeouts, resets, DNS hiccups): inconclusive, never reported.
//   - everything else (2xx, 3xx): fine.

export interface ExtractedLink {
  /** Absolute http(s) URL, no fragment. */
  url: string
  /** Visible anchor text (or the image alt), whitespace collapsed, at most 120 characters. */
  text: string
}

const SKIP_SCHEMES = /^(mailto|tel|sms|javascript|data|ftp|file|blob|whatsapp|skype|callto):/i

const entity = (s: string) =>
  s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => (Number(d) > 0 && Number(d) < 0x110000 ? String.fromCodePoint(Number(d)) : ' '))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => (parseInt(h, 16) > 0 && parseInt(h, 16) < 0x110000 ? String.fromCodePoint(parseInt(h, 16)) : ' '))

const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? entity(m[1] ?? m[2] ?? m[3] ?? '') : null
}

/** One URL in its comparable form: no fragment, default port dropped, host lower-cased. Null when it is not an http(s) URL. */
export function canonicalUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw.trim(), base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}

/** The http(s) links of an HTML page (anchors only), in document order, resolved against the page (or its <base href>). */
export function extractLinks(html: string, pageUrl: string): ExtractedLink[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const baseHref = clean.match(/<base\b([^>]*)>/i)
  const base = (baseHref && attr(baseHref[1]!, 'href') ? canonicalUrl(attr(baseHref[1]!, 'href')!, pageUrl) : null) ?? pageUrl
  const out: ExtractedLink[] = []
  for (const m of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(m[1]!, 'href')
    if (href === null) continue
    const h = href.trim()
    if (!h || h.startsWith('#') || SKIP_SCHEMES.test(h)) continue
    const url = canonicalUrl(h, base)
    if (!url) continue
    // Cloudflare rewrites every mailto: link into /cdn-cgi/l/email-protection#<hash> (a script puts the address back in the
    // browser); /cdn-cgi/ is the CDN's own reserved path, so a plain GET of it is a 404 that says nothing about the site.
    if (/^\/cdn-cgi\//i.test(new URL(url).pathname)) continue
    let text = entity(m[2]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (!text) {
      const alt = m[2]!.match(/<img\b([^>]*)>/i)
      const a = alt ? attr(alt[1]!, 'alt') : null
      text = a ? `[image] ${a.trim()}` : (attr(m[1]!, 'aria-label') ?? '').trim()
    }
    out.push({ url, text: text.replace(/\s+/g, ' ').slice(0, 120) })
  }
  return out
}

export type Verdict = 'ok' | 'broken' | 'server_error' | 'restricted' | 'transient'
export interface LinkResult {
  verdict: Verdict
  status: number | null
  /** A short machine label: "http", "dns", "tls", "refused", "timeout", "network", "blocked". */
  kind: string
  detail: string
}

export function classifyStatus(status: number): LinkResult {
  const at = (verdict: Verdict, kind = 'http'): LinkResult => ({ verdict, status, kind, detail: `HTTP ${status}` })
  if (status >= 200 && status < 400) return at('ok')
  if (status === 400 || status === 404 || status === 410) return at('broken')
  if ([401, 403, 405, 406, 407, 429, 451, 999].includes(status)) return at('restricted')
  if (status === 408) return at('transient')
  if (status >= 500) return at('server_error')
  return at('restricted') // other 4xx: not claimed
}

/** Classify a network-level failure from its code or message. */
export function classifyError(e: unknown): LinkResult {
  const err = e as { code?: string; cause?: { code?: string; message?: string }; message?: string; name?: string }
  const code = String(err?.code ?? err?.cause?.code ?? '')
  const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  const res = (verdict: Verdict, kind: string, detail: string): LinkResult => ({ verdict, status: null, kind, detail })
  if (/blocked|not public|refused by the guard|SSRF|non-public/i.test(msg) && !code) return res('restricted', 'blocked', 'the address is not public, so it was not fetched')
  if (code === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) return res('broken', 'dns', 'the domain does not resolve')
  if (code === 'EAI_AGAIN' || /EAI_AGAIN/.test(msg)) return res('transient', 'dns_temp', 'a temporary DNS failure')
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return res('server_error', 'refused', 'the connection was refused')
  if (/^(CERT_|ERR_TLS_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/.test(code) || /certificate|self[- ]signed|unable to verify/i.test(msg)) return res('broken', 'tls', 'the TLS certificate is invalid')
  if (/more than \d+ redirects|redirect loop/i.test(msg)) return res('broken', 'redirects', 'it redirects in a loop or through too many hops')
  if (/timed out|timeout|aborted/i.test(msg) || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return res('transient', 'timeout', 'the request timed out')
  return res('transient', 'network', (err?.message ?? 'the request failed').slice(0, 100))
}

export const isPage = (u: string): boolean => !/\.(pdf|zip|gz|tgz|tar|rar|7z|dmg|exe|msi|apk|png|jpe?g|gif|svg|webp|ico|avif|bmp|mp3|mp4|mov|avi|webm|wav|css|js|mjs|json|xml|rss|atom|txt|csv|docx?|xlsx?|pptx?|woff2?|ttf|eot)$/i.test(new URL(u).pathname)
