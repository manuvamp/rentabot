// Small pure helpers: ids, canonical JSON + hashes, ISO durations, money in integer cents.
import { createHash, randomBytes } from 'node:crypto'

// ---------- ids ----------

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz'
/** `job_<time><random>`: sortable by creation time, matches the shared Id regexes (alnum, 6-40). */
export function newId(prefix: string, randomChars = 14): string {
  const bytes = randomBytes(randomChars)
  let r = ''
  for (const b of bytes) r += ALPHA[b % ALPHA.length]
  return `${prefix}_${Date.now().toString(36)}${r}`
}
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url')

// ---------- canonical JSON and hashes ----------

/** JSON with object keys sorted at every level; undefined values dropped. Stable across runs and machines. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortDeep(x)
    }
    return out
  }
  return v
}
export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
export const sha256Tag = (data: string | Uint8Array) => `sha256:${sha256Hex(data)}`
export const hashCanonical = (value: unknown) => sha256Tag(canonicalJson(value))

// ---------- durations ----------

/** ISO-8601 duration (P#DT#H#M, also weeks/seconds) → milliseconds. */
export function durationMs(d: string): number {
  const m = d.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) throw new Error(`bad ISO duration: ${d}`)
  const [, w, dd, h, mi, s] = m.map((x) => Number(x ?? 0))
  return ((((w * 7 + dd) * 24 + h) * 60 + mi) * 60 + s) * 1000
}
export const iso = (ms: number) => new Date(ms).toISOString()

// ---------- money (integer cents; Amount strings only at the edges) ----------

/** "12.50" → 1250. Exact (no float math) for the shared Amount format. */
export function toCents(amount: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(amount)
  if (!m) throw new Error(`invalid amount: ${amount}`)
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'))
}
export function toAmount(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`cents must be an integer: ${cents}`)
  const neg = cents < 0
  const c = Math.abs(cents)
  return `${neg ? '-' : ''}${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`
}
export const usd = (cents: number) => ({ value: toAmount(Math.max(0, cents)), currency: 'USD' as const })
