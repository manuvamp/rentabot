// Page extraction rules, shared by the Web Data Extractor bot and the platform's page_extraction_verified check, so both apply exactly
// the same definition of "this value is really on that page". Pure functions only.
//
// A row is {data: {field: value|null}, quotes: {field: quote|null}} for one page. A non-null value is accepted only when
//   1. its quote is a contiguous passage of the page (visible text, <title>, meta description, og:title/description, mailto: and tel:
//      targets), compared after normalisation (NFKC, curly quotes and dashes, whitespace, case, thousands commas), and
//   2. the value itself is inside that quote, and
//   3. for the built-in fields (title, h1, description, emails, phones, prices) it also has the right shape: the title is the page's
//      title, an email looks like an email, and so on.
// What these rules cannot know is whether a free-form field ("plan name", "author") was given the RIGHT passage: only that the value is
// on the page, in the quote the extractor named. The listing says so.
import { canonicalUrl } from './link-logic.ts'
import { htmlToText, stripComments } from '../intelligence/checks/library.ts'

export const BUILTIN_FIELDS = ['title', 'description', 'h1', 'emails', 'phones', 'prices'] as const
export const MAX_URLS = 300
export const MAX_FIELDS = 12
const MAX_VALUE = 300
const MAX_QUOTE = 400
const MAX_ITEMS = 20

export interface FieldSpec {
  name: string
  /** The buyer's note on what the field means (free text, data for the AI, never instructions to the platform). */
  hint: string
  builtin: boolean
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/

/** The `fields` input: one per line (or comma-separated on one line) as `name` or `name: what it means`. */
export function parseFields(raw: unknown): { fields: FieldSpec[]; rejected: string[] } {
  const lines = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/\r?\n/) : []
  let items = lines.map((l) => l.trim()).filter(Boolean)
  if (items.length === 1 && !items[0]!.includes(':') && items[0]!.includes(',')) items = items[0]!.split(',').map((s) => s.trim()).filter(Boolean)
  const fields: FieldSpec[] = []
  const rejected: string[] = []
  for (const item of items) {
    const i = item.indexOf(':')
    const name = (i < 0 ? item : item.slice(0, i)).trim().toLowerCase().replace(/[\s-]+/g, '_')
    const hint = (i < 0 ? '' : item.slice(i + 1)).trim().slice(0, 200)
    if (!FIELD_NAME.test(name) || fields.some((f) => f.name === name) || fields.length >= MAX_FIELDS) {
      rejected.push(item.slice(0, 60))
      continue
    }
    fields.push({ name, hint, builtin: (BUILTIN_FIELDS as readonly string[]).includes(name) })
  }
  return { fields, rejected }
}

/** The `urls` input: http(s) pages, whitespace-separated, duplicates removed, at most MAX_URLS. */
export function parseUrls(raw: unknown): { urls: string[]; rejected: string[] } {
  const items = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/\s+/) : []
  const urls: string[] = []
  const rejected: string[] = []
  for (const item of items) {
    const t = item.trim().replace(/[,;]+$/, '')
    if (!t) continue
    const u = /^https?:\/\//i.test(t) ? canonicalUrl(t) : null
    if (!u || urls.length >= MAX_URLS) {
      rejected.push(t.slice(0, 80))
      continue
    }
    if (!urls.includes(u)) urls.push(u)
  }
  return { urls, rejected }
}

/** Comparable form of a piece of text. */
export const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** Common named entities htmlToText does not know (it decodes only the basic five and numeric ones). */
const NAMED: Record<string, string> = {
  mdash: '—', ndash: '–', hellip: '…', euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', deg: '°',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ouml: 'ö', uuml: 'ü', auml: 'ä', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß',
}
const decodeNamed = (s: string) => s.replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m)
const entity = (s: string) => htmlToText(decodeNamed(s))
const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? entity(m[1] ?? m[2] ?? m[3] ?? '') : null
}

export interface PageFacts {
  /** Visible text, whitespace collapsed. */
  text: string
  title: string | null
  description: string | null
  h1: string | null
  ogTitle: string | null
  ogDescription: string | null
  mailtos: string[]
  tels: string[]
  /** The comparable text every quote must be found in. */
  corpus: string
}

/** What a page says: visible text plus the head's title and descriptions and the mailto:/tel: targets. */
export function pageFacts(html: string): PageFacts {
  const clean = stripComments(decodeNamed(html))
  const first =(re: RegExp) => {
    const m = clean.match(re)
    const t = m ? entity(m[1]!) : ''
    return t ? t : null
  }
  const metas = [...clean.matchAll(/<meta\b([^>]*)>/gi)].map((m) => m[1]!)
  const meta = (key: 'name' | 'property', value: string) => {
    for (const a of metas) {
      if ((attr(a, key) ?? '').toLowerCase() === value) {
        const c = attr(a, 'content')
        if (c && c.trim()) return c.replace(/\s+/g, ' ').trim()
      }
    }
    return null
  }
  const dec = (v: string) => {
    try {
      return decodeURIComponent(v).trim()
    } catch {
      return v.trim()
    }
  }
  const mailtos = [...new Set([...clean.matchAll(/href\s*=\s*["']?mailto:([^"'?\s>]+)/gi)].map((m) => dec(m[1]!)).filter(Boolean))]
  const tels = [...new Set([...clean.matchAll(/href\s*=\s*["']?tel:([^"'\s>]+)/gi)].map((m) => dec(m[1]!)).filter(Boolean))]
  const text = htmlToText(clean.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' '))
  const f: PageFacts = {
    text,
    title: first(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i),
    description: meta('name', 'description'),
    h1: first(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i),
    ogTitle: meta('property', 'og:title'),
    ogDescription: meta('property', 'og:description'),
    mailtos,
    tels,
    corpus: '',
  }
  f.corpus = norm([f.text, f.title, f.description, f.ogTitle, f.ogDescription, ...mailtos, ...tels].filter(Boolean).join(' '))
  return f
}

const EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}$/i
const PRICE = /(?:[$€£¥₹]\s?\d|\d\s?(?:usd|eur|gbp|inr|dollars?|euros?)\b)/i
const digits = (s: string) => s.replace(/\D/g, '')

/** What `value` has to be for a built-in field (null when it is fine); free-form fields have no shape rule. */
function shapeProblem(name: string, value: string, f: PageFacts): string | null {
  const n = norm(value)
  switch (name) {
    case 'title':
      return [f.title, f.ogTitle, f.h1].some((t) => t && norm(t) === n) ? null : 'is not the page title (<title>, og:title or first <h1>)'
    case 'h1':
      return f.h1 && norm(f.h1) === n ? null : 'is not the first <h1>'
    case 'description':
      return [f.description, f.ogDescription].some((t) => t && norm(t) === n) ? null : 'is not the page description (meta or og:description)'
    case 'emails':
      return EMAIL.test(value.trim()) ? null : 'is not an email address'
    case 'phones':
      return digits(value).length >= 7 && digits(value).length <= 15 && /^[+\d(][\d\s().+-]*$/.test(value.trim()) ? null : 'is not a phone number'
    case 'prices':
      return PRICE.test(value) ? null : 'is not a price (a currency symbol or code with a number)'
    default:
      return null
  }
}

export type Scalar = string | number
export interface Row {
  data: Record<string, unknown>
  quotes: Record<string, unknown>
}

const asItems = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v])
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

/** Why this field's value is not accepted (null when it is, or when it is empty). */
export function fieldProblem(name: string, value: unknown, quote: unknown, f: PageFacts): string | null {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return null
  const values = asItems(value)
  const quotes = Array.isArray(value) ? (Array.isArray(quote) ? quote : null) : quote !== undefined && quote !== null ? [quote] : null
  if (values.length > MAX_ITEMS) return `more than ${MAX_ITEMS} values`
  if (!quotes || quotes.length !== values.length) return Array.isArray(value) ? 'needs one quote per value' : 'has no source quote'
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    const q = quotes[i]
    if (!isScalar(v)) return 'is not text or a number'
    if (typeof q !== 'string' || !q.trim()) return 'has no source quote'
    const sv = String(v).trim()
    if (norm(sv).length < 2) return 'is too short to verify'
    if (sv.length > MAX_VALUE) return `is longer than ${MAX_VALUE} characters`
    if (q.length > MAX_QUOTE) return `has a quote longer than ${MAX_QUOTE} characters`
    const nq = norm(q)
    if (!f.corpus.includes(nq)) return 'has a quote that is not on the page'
    if (!nq.includes(norm(sv))) return 'is not inside its own quote'
    const shape = shapeProblem(name, sv, f)
    if (shape) return shape
  }
  return null
}

export interface RowCheck {
  ok: boolean
  /** Fields with a verified value. */
  filled: string[]
  problems: string[]
}

/** The least number of fields that must be filled for a page to count as extracted: half of them, at least one. */
export const minFilled = (fields: FieldSpec[]) => Math.max(1, Math.ceil(fields.length / 2))

/** Check a whole row: every non-null value must hold up, and enough of the requested fields must be filled. */
export function checkRow(row: unknown, fields: FieldSpec[], f: PageFacts): RowCheck {
  const problems: string[] = []
  const r = row as Partial<Row> | null
  if (!r || typeof r !== 'object' || !r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return { ok: false, filled: [], problems: ['the unit has no data object'] }
  const quotes = r.quotes && typeof r.quotes === 'object' && !Array.isArray(r.quotes) ? r.quotes : {}
  const names = new Set(fields.map((x) => x.name))
  for (const k of Object.keys(r.data)) if (!names.has(k)) problems.push(`"${k.slice(0, 40)}" is not a requested field`)
  const filled: string[] = []
  for (const fd of fields) {
    const v = (r.data as Record<string, unknown>)[fd.name]
    const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) continue
    const p = fieldProblem(fd.name, v, (quotes as Record<string, unknown>)[fd.name], f)
    if (p) problems.push(`${fd.name} ${p}`)
    else filled.push(fd.name)
  }
  const need = minFilled(fields)
  if (!problems.length && filled.length < need) problems.push(`only ${filled.length} of ${fields.length} fields are filled; at least ${need} are needed for a page to count`)
  return { ok: problems.length === 0, filled, problems }
}

// ---------- the rules extractor for the built-in fields (no AI needed) ----------

/** A passage of the page around [at, at+len), cut at word boundaries, at most ~160 characters. */
function snippet(text: string, at: number, len: number): string {
  let s = Math.max(0, at - 60)
  let e = Math.min(text.length, at + len + 60)
  while (s > 0 && s < at && text[s - 1] !== ' ') s++
  while (e < text.length && e > at + len && text[e] !== ' ') e--
  return text.slice(s, e).trim()
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const PHONE_IN_TEXT = /(?<![\w.])\+?\(?\d[\d\s().-]{5,}\d(?![\w])/g
const PRICE_IN_TEXT = /(?:[$€£¥₹]\s?\d+(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:,\d{3})*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR)\b)/g

function listOf(text: string, re: RegExp, accept: (v: string) => boolean): { value: string; quote: string }[] {
  const out: { value: string; quote: string }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(re)) {
    const v = m[0].trim()
    if (seen.has(v.toLowerCase()) || !accept(v)) continue
    seen.add(v.toLowerCase())
    out.push({ value: v, quote: snippet(text, m.index!, m[0].length) })
    if (out.length >= 10) break
  }
  return out
}

/** Read the built-in fields from the page by rules. Fields that are not built in, or not found, are absent from the result. */
export function ruleExtract(fields: FieldSpec[], f: PageFacts): Row {
  const data: Record<string, unknown> = {}
  const quotes: Record<string, unknown> = {}
  const set = (name: string, value: unknown, quote: unknown) => {
    data[name] = value
    quotes[name] = quote
  }
  for (const fd of fields) {
    if (!fd.builtin) continue
    switch (fd.name) {
      case 'title': {
        const t = f.title ?? f.ogTitle ?? f.h1
        if (t) set('title', t, t)
        break
      }
      case 'h1':
        if (f.h1) set('h1', f.h1, f.h1)
        break
      case 'description': {
        const d = f.description ?? f.ogDescription
        if (d) set('description', d, d)
        break
      }
      case 'emails': {
        const fromText = listOf(f.text, EMAIL_IN_TEXT, (v) => EMAIL.test(v))
        const extra = f.mailtos.filter((m) => EMAIL.test(m) && !fromText.some((x) => x.value.toLowerCase() === m.toLowerCase())).map((m) => ({ value: m, quote: m }))
        const all = [...fromText, ...extra].slice(0, 10)
        if (all.length) set('emails', all.map((x) => x.value), all.map((x) => x.quote))
        break
      }
      case 'phones': {
        const fromText = listOf(f.text, PHONE_IN_TEXT, (v) => digits(v).length >= 7 && digits(v).length <= 15 && (/^[+(]/.test(v) || /[\s.-]/.test(v)) && !/^\d{4}-\d{2}-\d{2}$/.test(v) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v))
        const extra = f.tels.filter((t) => digits(t).length >= 7 && digits(t).length <= 15 && !fromText.some((x) => digits(x.value) === digits(t))).map((t) => ({ value: t, quote: t }))
        const all = [...fromText, ...extra].slice(0, 10)
        if (all.length) set('phones', all.map((x) => x.value), all.map((x) => x.quote))
        break
      }
      case 'prices': {
        const all = listOf(f.text, PRICE_IN_TEXT, () => true)
        if (all.length) set('prices', all.map((x) => x.value), all.map((x) => x.quote))
        break
      }
    }
  }
  return { data, quotes }
}
