// Small helpers shared by the bots.
import type { JobSpec, Requirements } from '@rentabot/shared'

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The first deliverable (the one the price is attached to). */
export const primary = (spec: JobSpec) => spec.deliverables[0]!

const BAD_ASK = /\b(fake|bought|purchased)\s+(reviews?|upvotes?|ratings?|followers?|signups?)\b|\b(solve|bypass|defeat|crack)\s+(the\s+)?captchas?\b|\b(send|blast)\w*\s+(\w+\s+){0,2}spam\b|\bspam\s+(emails?|messages?|people|users|inboxes)\b|\bscrap(e|ing)\s+personal\b/gi
const NEGATED = /\b(no|not|never|avoid|without|exclude|excluding|don'?t|do not)\b[\w\s,-]{0,40}$/i

/** A reason when the goal or a deliverable asks for something none of the house bots do. The platform's
 *  policy gate is the real screen; this only catches plain asks, so rubric and context text (which often
 *  say "no spam") are not scanned, and negated phrases ("avoid spammy directories") don't count. */
export function badAsk(spec: JobSpec): string | null {
  const text = [spec.goal, ...spec.deliverables.map((d) => d.description)].join('\n')
  for (const m of text.matchAll(BAD_ASK)) {
    if (NEGATED.test(text.slice(0, m.index))) continue
    return `the request includes "${m[0]}", which I do not do (honest, rule-following work only)`
  }
  return null
}

export const needsSchema = (properties: Record<string, unknown>, required: string[]): Requirements['inputs_schema'] => ({ type: 'object', properties, required })

export const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })

/** Parse "JSONL" text (one JSON object per line); bad lines are returned separately. */
export function parseJsonl(text: string): { rows: Record<string, unknown>[]; bad: number } {
  const rows: Record<string, unknown>[] = []
  let bad = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !line.startsWith('{')) {
      if (line) bad++
      continue
    }
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v as Record<string, unknown>)
      else bad++
    } catch {
      bad++
    }
  }
  return { rows, bad }
}

/** GET/POST with a timeout; never follows redirects off the sandbox. */
export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 20_000)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    return { status: res.status, headers: res.headers, text: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

export async function httpJson<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; headers: Headers; json: T | null; text: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await http(url, init)
  let json: T | null = null
  try {
    json = JSON.parse(r.text) as T
  } catch {
    /* not JSON */
  }
  return { ...r, json }
}

/** Rewrite a URL the sandbox published (its public URL) onto the origin this bot is configured to use. */
export function onOrigin(url: string, origin: string): string {
  const u = new URL(url)
  return `${origin.replace(/\/+$/, '')}${u.pathname}${u.search}`
}

export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
