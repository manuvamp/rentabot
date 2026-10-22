// Transient fetch outcomes for web checks: rate limits (429), gateway errors (502/503/504, Cloudflare 52x), timeouts
// and dropped connections are retried within the check's own time budget. A check that is still transient after the
// retries must not be a final 'fail' (a seller would lose pay for good work); url_live and page_mentions report
// 'pending' instead, which the delayed-check re-runs pick up, and a unit still pending at the final settlement is simply
// not paid (flows.ts settleEarned: only earned units are captured, the rest is voided).
import { BlockedUrl, type FetchOptions, type FetchResult, type SafeFetch } from './safe-fetch.ts'

const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504, 520, 521, 522, 523, 524])
/** Errors that say the page does not exist (no retry): unknown host, refused by the SSRF guard. */
const PERMANENT_ERROR = /ENOTFOUND|EAI_NONAME|not a valid URL|not allowed|not public|non-public|redirects/i

export const isTransientStatus = (status: number) => TRANSIENT_STATUS.has(status)
export const isTransientError = (e: unknown) => !(e instanceof BlockedUrl) && !PERMANENT_ERROR.test((e as Error)?.message ?? String(e))

/** Retry-After in ms (seconds or an HTTP date), or null. */
export function retryAfterMs(v: string | undefined, now = Date.now()): number | null {
  if (!v) return null
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - now) : null
}

export interface RetryingFetch {
  /** The last response (also for a transient status such as 503). */
  result?: FetchResult
  /** The last thrown error, when no response came back. */
  error?: unknown
  /** Why the outcome is still transient after the retries ("HTTP 429", "timed out"…), or null when it is final. */
  transient: string | null
  attempts: number
}

export interface RetryOptions {
  retries?: number
  /** Longest wait honoured from Retry-After. */
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const BACKOFF_MS = [300, 900]

/** GET with up to `retries` (default 2) retries of transient outcomes, all inside opts.timeoutMs (default 8000 ms). */
export async function fetchRetrying(fetch: SafeFetch, url: string, opts: FetchOptions = {}, ro: RetryOptions = {}): Promise<RetryingFetch> {
  const now = ro.now ?? Date.now
  const sleep = ro.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const retries = ro.retries ?? 2
  const budget = opts.timeoutMs ?? 8000
  const end = now() + budget
  for (let attempt = 1; ; attempt++) {
    const timeoutMs = attempt === 1 ? budget : Math.max(1000, end - now())
    let last: RetryingFetch
    let wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
    try {
      const r = await fetch(url, { ...opts, timeoutMs })
      if (!isTransientStatus(r.status)) return { result: r, transient: null, attempts: attempt }
      last = { result: r, transient: `HTTP ${r.status}`, attempts: attempt }
      wait = retryAfterMs(r.headers['retry-after'], now()) ?? wait
    } catch (e) {
      if (!isTransientError(e)) return { error: e, transient: null, attempts: attempt }
      last = { error: e, transient: ((e as Error)?.message ?? String(e)).slice(0, 160), attempts: attempt }
    }
    wait = Math.min(wait, ro.maxWaitMs ?? 3000)
    // Out of retries, or no time left for another real attempt (at least 1 s) inside the check's budget.
    if (attempt > retries || now() + wait + 1000 > end) return last
    await sleep(wait)
  }
}
