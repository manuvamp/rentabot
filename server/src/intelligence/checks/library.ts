// The acceptance-check library. Each check is code with a precise params schema; the runner in the
// core calls run() and stores the outcome. Registered checks are wrapped so params are validated
// first and any thrown error becomes an `error` outcome instead of crashing the runner.
import { createHash } from 'node:crypto'
import type { CheckDefinition } from '@rentabot/shared'
import type { CheckContext, CheckImpl, CheckLibrary, CheckOutcome } from '../types.ts'
import { BlockedUrl, safeFetch, type FetchResult, type SafeFetch } from './safe-fetch.ts'
import { validateJson } from './schema.ts'
import { fetchRetrying } from './transient.ts'

export interface CheckLibraryOptions {
  allowHosts?: string[]
  fetch?: SafeFetch
}

const MAX_DETAIL = 1000
const clip = (s: string, n = MAX_DETAIL) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const outcome = (status: CheckOutcome['status'], detail: string, evidence_id: string | null = null): CheckOutcome => ({
  status,
  detail: clip(detail),
  evidence_id,
})

const timeoutParam = { type: 'integer', minimum: 1000, maximum: 15000, description: 'Fetch timeout in ms (default 8000).' }

/** Visible-ish text of an HTML page: drops scripts, styles, comments and tags; decodes common entities. */
export function htmlToText(html: string): string {
  return markupToText(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ')

const RAW_TEXT_ELEMENTS = /^<(script|style|noscript|template)(?=[\s/>])/i

/**
 * Walks HTML at the tag level the way a browser does: a tag ends at the first ">" that is not inside a quoted attribute value, and a
 * comment ends at "-->". (Regexes that stop a tag at the first ">" leak attribute text into the page text: Wikipedia puts JSON that
 * contains ">" and "<!--" into data-mw attributes.) Linear time; an unclosed quote falls back to the first ">".
 * `keepTags` copies tags as they are and drops only the comments; otherwise tags become spaces and script/style/noscript/template
 * elements are dropped with their content.
 */
function walkMarkup(html: string, keepTags: boolean): string {
  const n = html.length
  const out: string[] = []
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out.push(html.slice(i))
      break
    }
    if (lt > i) out.push(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4)
      out.push(' ')
      i = e < 0 ? n : e + 3
      continue
    }
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) {
      out.push('<') // a "<" in running text
      i = lt + 1
      continue
    }
    let j = lt + 1
    let quote = ''
    let prev = ''
    for (; j < n; j++) {
      const c = html[j]!
      if (quote) {
        if (c === quote) quote = ''
      } else if ((c === '"' || c === "'") && prev === '=') quote = c
      else if (c === '>') break
      if (!/\s/.test(c)) prev = c
    }
    if (j >= n && quote) j = html.indexOf('>', lt + 1) < 0 ? n : html.indexOf('>', lt + 1)
    const end = Math.min(j + 1, n)
    if (keepTags) {
      out.push(html.slice(lt, end))
      i = end
      continue
    }
    const raw = RAW_TEXT_ELEMENTS.exec(html.slice(lt, lt + 12))
    i = end
    if (raw && html[end - 2] !== '/') {
      const close = new RegExp(`</${raw[1]}\\s*>`, 'ig')
      close.lastIndex = end
      const m = close.exec(html)
      i = m ? m.index + m[0].length : n
    }
    out.push(' ')
  }
  return out.join('')
}

const markupToText = (html: string) => walkMarkup(html, false)
/** The HTML without its comments; tags (and any "<!--" inside a quoted attribute value) are left untouched. */
export const stripComments = (html: string) => walkMarkup(html, true)

const normHeading = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Headings in markdown (ATX and setext) or HTML text. */
export function extractHeadings(text: string): string[] {
  const out: string[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (atx) out.push(atx[1]!)
    else if (i + 1 < lines.length && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]!)) out.push(line.trim())
  }
  for (const m of text.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)) out.push(htmlToText(m[1]!))
  return out
}

function fetchEvidence(r: FetchResult) {
  return {
    final_url: r.url,
    status: r.status,
    ms: r.ms,
    hops: r.hops,
    content_type: r.headers['content-type'] ?? null,
    content_length: r.headers['content-length'] ?? null,
    body_truncated: r.truncated,
  }
}

function fetchFailure(e: unknown): CheckOutcome {
  if (e instanceof BlockedUrl) return outcome('fail', `URL refused by SSRF guard: ${e.message}`)
  return outcome('fail', `fetch failed: ${(e as Error).message}`)
}

async function unitArtifacts(ctx: CheckContext) {
  const ids = ctx.unit?.artifact_ids ?? []
  const found = await Promise.all(ids.map((id) => ctx.artifact(id)))
  return ids.map((id, i) => ({ id, a: found[i] ?? null }))
}

const isTextMime = (mime: string, name: string) =>
  /^text\//i.test(mime) || /(markdown|json|xml|html)/i.test(mime) || /\.(md|markdown|txt|html?|json)$/i.test(name)

function builtins(opts: { allowHosts: string[]; fetch: SafeFetch }): CheckImpl[] {
  const { allowHosts } = opts
  const get = (url: string, timeoutMs?: number, maxBytes?: number) => opts.fetch(url, { allowHosts, timeoutMs, maxBytes, maxRedirects: 3 })
  // Rate limits, gateway errors and timeouts are retried inside the check's timeout; still transient = 'pending' (re-run later), never a final 'fail'.
  const getRetrying = (url: string, timeoutMs?: number, maxBytes?: number) => fetchRetrying(opts.fetch, url, { allowHosts, timeoutMs, maxBytes, maxRedirects: 3 })
  const stillTransient = async (ctx: CheckContext, url: string, t: { result?: FetchResult; transient: string | null; attempts: number }) => {
    const ev = t.result ? await ctx.saveEvidence('http_transcript', `GET ${url} -> ${t.result.status}`, fetchEvidence(t.result)) : null
    return outcome('pending', `transient: ${t.transient} after ${t.attempts} attempt(s); checked again later`, ev)
  }

  const urlLive: CheckImpl = {
    def: {
      id: 'url_live',
      title: 'URL is live',
      description:
        "The unit's url answers with the expected HTTP status (default 200) within the timeout, following at most 3 redirects. Private, loopback and metadata addresses are refused.",
      params: {
        type: 'object',
        properties: { status: { type: 'integer', minimum: 200, maximum: 299, default: 200 }, timeout_ms: timeoutParam },
        additionalProperties: false,
      },
      per_unit: true,
      delayed: true,
    },
    async run(ctx) {
      const url = ctx.unit?.url
      if (!url) return outcome('fail', 'unit has no url')
      const expected = (ctx.test.params.status as number | undefined) ?? 200
      const t = await getRetrying(url, ctx.test.params.timeout_ms as number | undefined, 64_000)
      if (t.transient) return stillTransient(ctx, url, t)
      if (!t.result) return fetchFailure(t.error)
      const r = t.result
      const ev = await ctx.saveEvidence('http_transcript', `GET ${url} -> ${r.status}`, fetchEvidence(r))
      return r.status === expected
        ? outcome('pass', `HTTP ${r.status} in ${r.ms} ms${r.hops.length > 1 ? ` after ${r.hops.length - 1} redirect(s)` : ''}`, ev)
        : outcome('fail', `HTTP ${r.status}, expected ${expected}`, ev)
    },
  }

  const pageMentions: CheckImpl = {
    def: {
      id: 'page_mentions',
      title: 'Page mentions required text',
      description:
        "The page at the unit's url (2xx) contains every string in must_include, case-insensitive, in its visible text. An excerpt around each match is stored as evidence.",
      params: {
        type: 'object',
        properties: {
          must_include: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
          timeout_ms: timeoutParam,
        },
        required: ['must_include'],
        additionalProperties: false,
      },
      per_unit: true,
      delayed: true,
    },
    async run(ctx) {
      const url = ctx.unit?.url
      if (!url) return outcome('fail', 'unit has no url')
      const needles = ctx.test.params.must_include as string[]
      const t = await getRetrying(url, ctx.test.params.timeout_ms as number | undefined, 2_000_000)
      if (t.transient) return stillTransient(ctx, url, t)
      if (!t.result) return fetchFailure(t.error)
      const r = t.result
      if (r.status < 200 || r.status > 299) {
        const ev = await ctx.saveEvidence('http_transcript', `GET ${url} -> ${r.status}`, fetchEvidence(r))
        return outcome('fail', `HTTP ${r.status}; page not readable`, ev)
      }
      const text = /html/i.test(r.headers['content-type'] ?? '') || /<html|<body/i.test(r.body.slice(0, 2000)) ? htmlToText(r.body) : r.body
      const lower = text.toLowerCase()
      const excerpts: Record<string, string> = {}
      const missing: string[] = []
      for (const n of needles) {
        const at = lower.indexOf(n.toLowerCase())
        if (at < 0) missing.push(n)
        else excerpts[n] = text.slice(Math.max(0, at - 80), at + n.length + 80)
      }
      const ev = await ctx.saveEvidence('page_excerpt', `${url}: ${needles.length - missing.length}/${needles.length} terms found`, {
        ...fetchEvidence(r),
        found: excerpts,
        missing,
        text_head: text.slice(0, 500),
      })
      return missing.length === 0
        ? outcome('pass', `page mentions ${needles.map((n) => `"${n}"`).join(', ')}`, ev)
        : outcome('fail', `page does not mention ${missing.map((n) => `"${n}"`).join(', ')}${r.truncated ? ' (page truncated at size cap)' : ''}`, ev)
    },
  }

  const artifactAttached: CheckImpl = {
    def: {
      id: 'artifact_attached',
      title: 'Artifacts attached',
      description: 'The unit carries at least min_count stored artifacts whose MIME type starts with mime_prefix (e.g. "image/" for screenshots).',
      params: {
        type: 'object',
        properties: {
          min_count: { type: 'integer', minimum: 1, maximum: 50, default: 1 },
          mime_prefix: { type: 'string', maxLength: 100, default: '' },
        },
        additionalProperties: false,
      },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return outcome('error', 'artifact_attached needs a delivered unit')
      const min = (ctx.test.params.min_count as number | undefined) ?? 1
      const prefix = String(ctx.test.params.mime_prefix ?? '').toLowerCase()
      const arts = await unitArtifacts(ctx)
      const matching = arts.filter((x) => x.a && x.a.meta.mime.toLowerCase().startsWith(prefix))
      const missing = arts.filter((x) => !x.a).map((x) => x.id)
      const ev = await ctx.saveEvidence('artifact_list', `${matching.length} matching artifact(s)`, {
        artifacts: arts.map((x) => ({ id: x.id, mime: x.a?.meta.mime ?? null, bytes: x.a?.meta.bytes ?? null, found: !!x.a })),
        mime_prefix: prefix,
        min_count: min,
      })
      const what = prefix ? `${prefix}* artifact(s)` : 'artifact(s)'
      return matching.length >= min
        ? outcome('pass', `${matching.length} ${what} attached`, ev)
        : outcome('fail', `${matching.length} of ${min} required ${what} attached${missing.length ? `; ${missing.length} id(s) not found` : ''}`, ev)
    },
  }

  const jsonSchemaValid: CheckImpl = {
    def: {
      id: 'json_schema_valid',
      title: 'JSON matches schema',
      description:
        "The unit's meta (source: meta) or its first JSON artifact (source: artifact) validates against params.schema (JSON Schema 2020-12).",
      params: {
        type: 'object',
        properties: {
          schema: { type: 'object' },
          source: { enum: ['meta', 'artifact'], default: 'meta' },
        },
        required: ['schema'],
        additionalProperties: false,
      },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return outcome('error', 'json_schema_valid needs a delivered unit')
      const source = (ctx.test.params.source as string | undefined) ?? 'meta'
      let data: unknown = ctx.unit.meta
      let from = 'unit.meta'
      if (source === 'artifact') {
        const arts = await unitArtifacts(ctx)
        const json = arts.find((x) => x.a && (/json/i.test(x.a.meta.mime) || /\.json$/i.test(x.a.meta.name)))
        if (!json?.a) return outcome('fail', 'no JSON artifact on the unit')
        if (json.a.bytes.length > 2_000_000) return outcome('fail', 'JSON artifact larger than 2 MB')
        try {
          data = JSON.parse(Buffer.from(json.a.bytes).toString('utf8'))
        } catch (e) {
          return outcome('fail', `artifact ${json.id} is not valid JSON: ${(e as Error).message.slice(0, 120)}`)
        }
        from = json.id
      }
      const res = validateJson(ctx.test.params.schema, data)
      if (res.errors[0]?.startsWith('invalid schema') || res.errors[0]?.startsWith('schema larger')) return outcome('error', res.errors[0]!)
      const ev = await ctx.saveEvidence('schema_validation', `${from}: ${res.ok ? 'valid' : `${res.errors.length} error(s)`}`, { from, errors: res.errors })
      return res.ok ? outcome('pass', `${from} matches the schema`, ev) : outcome('fail', `${from} invalid: ${res.errors.join('; ')}`, ev)
    },
  }

  const sha256Matches: CheckImpl = {
    def: {
      id: 'sha256_matches',
      title: 'File hash matches',
      description: "One of the unit's artifacts has exactly the expected SHA-256 (computed from the stored bytes, not the uploader's claim).",
      params: {
        type: 'object',
        properties: { sha256: { type: 'string', pattern: '^(sha256:)?[a-fA-F0-9]{64}$' } },
        required: ['sha256'],
        additionalProperties: false,
      },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return outcome('error', 'sha256_matches needs a delivered unit')
      const want = String(ctx.test.params.sha256).toLowerCase().replace(/^sha256:/, '')
      const arts = await unitArtifacts(ctx)
      const hashes = arts.filter((x) => x.a).map((x) => ({ id: x.id, sha256: createHash('sha256').update(x.a!.bytes).digest('hex') }))
      const hit = hashes.find((h) => h.sha256 === want)
      const ev = await ctx.saveEvidence('hashes', hit ? `match on ${hit.id}` : 'no match', { expected: want, computed: hashes })
      return hit
        ? outcome('pass', `artifact ${hit.id} has sha256:${want.slice(0, 12)}…`, ev)
        : outcome('fail', `no artifact matches sha256:${want.slice(0, 12)}… (${hashes.length} checked)`, ev)
    },
  }

  const reportSections: CheckImpl = {
    def: {
      id: 'report_sections_present',
      title: 'Report has required sections',
      description:
        "A markdown, text or HTML artifact on the unit has a heading containing each string in headings (case- and punctuation-insensitive).",
      params: {
        type: 'object',
        properties: { headings: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 120 } } },
        required: ['headings'],
        additionalProperties: false,
      },
      per_unit: true,
      delayed: false,
    },
    async run(ctx) {
      if (!ctx.unit) return outcome('error', 'report_sections_present needs a delivered unit (the report)')
      const required = ctx.test.params.headings as string[]
      const arts = (await unitArtifacts(ctx)).filter((x) => x.a && isTextMime(x.a.meta.mime, x.a.meta.name))
      if (arts.length === 0) return outcome('fail', 'no text/markdown report artifact on the unit')
      let best = { id: '', found: [] as string[], missing: required, headings: [] as string[] }
      for (const x of arts) {
        const headings = extractHeadings(Buffer.from(x.a!.bytes.subarray(0, 2_000_000)).toString('utf8'))
        const normed = headings.map(normHeading)
        const found = required.filter((r) => normed.some((h) => h.includes(normHeading(r))))
        if (found.length > best.found.length || !best.id) best = { id: x.id, found, missing: required.filter((r) => !found.includes(r)), headings }
      }
      const ev = await ctx.saveEvidence('report_outline', `${best.id}: ${best.found.length}/${required.length} sections`, {
        artifact_id: best.id,
        headings: best.headings.slice(0, 100),
        missing: best.missing,
      })
      return best.missing.length === 0
        ? outcome('pass', `all ${required.length} sections present in ${best.id}`, ev)
        : outcome('fail', `missing section(s): ${best.missing.map((m) => `"${m}"`).join(', ')}`, ev)
    },
  }

  const scopeProof: CheckImpl = {
    def: {
      id: 'scope_proof_valid',
      title: 'Scope proof published',
      description:
        "https://<target>/.well-known/rentabot-scope.txt exists and contains this job's id, proving the buyer controls the target. target defaults to contract.inputs.target.",
      params: {
        type: 'object',
        properties: { target: { type: 'string', maxLength: 300, description: 'Hostname (optionally host:port) of the system to be tested.' } },
        additionalProperties: false,
      },
      per_unit: false,
      delayed: false,
    },
    async run(ctx) {
      const raw = String(ctx.test.params.target ?? ctx.contract.inputs.target ?? ctx.contract.inputs.target_domain ?? '').trim()
      if (!raw) return outcome('error', 'no target: set params.target or contract.inputs.target')
      let origin: URL
      try {
        // Accept a bare host or a URL; only the origin is used. Plain http only for allow-listed hosts (Sandbox Web).
        origin = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
      } catch {
        return outcome('fail', `target "${raw.slice(0, 80)}" is not a hostname`)
      }
      const host = origin.host.toLowerCase()
      const allowed = allowHosts.some((a) => a.toLowerCase() === host || a.toLowerCase() === origin.hostname.toLowerCase())
      const scheme = origin.protocol === 'http:' && allowed ? 'http:' : 'https:'
      const url = `${scheme}//${origin.host}/.well-known/rentabot-scope.txt`
      let r: FetchResult
      try {
        r = await get(url, 8000, 64_000)
      } catch (e) {
        return fetchFailure(e)
      }
      const hasId = new RegExp(`(^|[^A-Za-z0-9_])${ctx.job_id}([^A-Za-z0-9_]|$)`).test(r.body)
      const ev = await ctx.saveEvidence('scope_proof', `${url} -> ${r.status}${hasId ? ', job id present' : ''}`, {
        ...fetchEvidence(r),
        body_head: r.body.slice(0, 500),
      })
      if (r.status !== 200) return outcome('fail', `${url} returned HTTP ${r.status}`, ev)
      return hasId ? outcome('pass', `${url} lists ${ctx.job_id}`, ev) : outcome('fail', `${url} does not contain ${ctx.job_id}`, ev)
    },
  }

  const stub = (id: string, title: string, description: string): CheckImpl => ({
    def: { id, title, description, params: { type: 'object' }, per_unit: true, delayed: true },
    async run() {
      return outcome('error', `${id} is provided by Sandbox Web, which has not registered it on this server`)
    },
  })

  return [
    urlLive,
    pageMentions,
    artifactAttached,
    jsonSchemaValid,
    sha256Matches,
    reportSections,
    scopeProof,
    stub('email_delivered', 'Email delivered', 'The email (by Message-ID) reached the recipient mailbox. Provided by Sandbox Web.'),
    stub('finding_reproduces', 'Finding reproduces', 'The check runner replays the finding against the target and sees the same result. Provided by Sandbox Web.'),
  ]
}

/** Validate a test's params against a check definition. Returns error strings (empty = valid). */
export function checkParamsErrors(def: CheckDefinition, params: Record<string, unknown>): string[] {
  return validateJson(def.params, params).errors
}

function guard(impl: CheckImpl): CheckImpl {
  return {
    def: impl.def,
    async run(ctx) {
      const errs = checkParamsErrors(impl.def, ctx.test.params ?? {})
      if (errs.length) return outcome('error', `invalid params for ${impl.def.id}: ${errs.join('; ')}`)
      try {
        return await impl.run(ctx)
      } catch (e) {
        return outcome('error', `${impl.def.id} crashed: ${(e as Error).message}`)
      }
    },
  }
}

export function createCheckLibrary(opts: CheckLibraryOptions = {}): CheckLibrary {
  const allowHosts = opts.allowHosts ?? []
  const fetch = opts.fetch ?? safeFetch
  const impls = new Map<string, CheckImpl>()
  const lib: CheckLibrary = {
    list: () => [...impls.values()].map((i) => i.def),
    get: (id) => impls.get(id),
    register(impl) {
      if (!/^[a-z][a-z0-9_]{2,40}$/.test(impl.def.id)) throw new Error(`bad check id ${impl.def.id}`)
      impls.set(impl.def.id, guard(impl)) // later registrations (Sandbox Web) replace the stubs
    },
  }
  for (const impl of builtins({ allowHosts, fetch })) lib.register(impl)
  return lib
}
