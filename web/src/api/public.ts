import { apiGet } from './client'
import { useAsync } from './hooks'
import { FALLBACK_FEED, FALLBACK_STATS } from '../lib/fixtures'

/** GET /api/public/stats. Every field optional: the UI falls back to fixtures per field. */
export interface PublicStats {
  bots?: number
  jobs_total?: number
  jobs_settled?: number
  units_verified?: number
  escrow_held?: string
  paid_out?: string
  voided?: string
  disputes_ruled?: number
  payment_rail?: 'simulated' | 'paypal_sandbox' | 'paypal_live'
  [k: string]: unknown
}
export interface FeedItem {
  cursor?: number
  type?: string
  summary: string
  ts: string
  job_id?: string | null
}

/** The server names counters held_now / released_total / voided_total / bots_listed / disputes_total; the UI uses shorter keys. */
function normalizeStats(s: Record<string, unknown>): PublicStats {
  const pick = <T,>(...keys: string[]) => keys.map((k) => s[k]).find((v) => v !== undefined && v !== null) as T | undefined
  return {
    ...s,
    bots: pick<number>('bots', 'bots_listed'),
    units_verified: pick<number>('units_verified'),
    escrow_held: pick<string>('escrow_held', 'held_now'),
    paid_out: pick<string>('paid_out', 'released_total'),
    voided: pick<string>('voided', 'voided_total'),
    disputes_ruled: pick<number>('disputes_ruled', 'disputes_total'),
    payment_rail: pick<PublicStats['payment_rail']>('payment_rail', 'rail'),
  }
}

export function usePublicStats() {
  const q = useAsync<{ stats: PublicStats; live: boolean }>(
    () =>
      apiGet<Record<string, unknown>>('/api/public/stats')
        .then((s) => ({ stats: normalizeStats(s), live: true }))
        .catch(() => ({ stats: {} as PublicStats, live: false })),
    [],
    { pollMs: 30000 },
  )
  // Real figures win, including zeros. Sample numbers only stand in while loading or when the API is unreachable.
  const live = q.data?.live ?? false
  const merged: PublicStats = live ? { ...q.data!.stats } : { ...FALLBACK_STATS }
  return { stats: merged, live, loading: q.loading, railKnown: Boolean(q.data?.stats?.payment_rail) }
}

/** Server feed rows are { ts, kind, text, amount }; the ticker wants { summary, type }. */
function normalizeFeed(r: unknown): FeedItem[] {
  const rows: Array<Record<string, unknown>> = Array.isArray(r) ? r : ((r as { events?: unknown[]; items?: unknown[] })?.events ?? (r as { items?: unknown[] })?.items ?? []) as Array<Record<string, unknown>>
  return rows.map((f) => {
    const kind = String(f.type ?? f.kind ?? '')
    return {
      summary: String(f.summary ?? f.text ?? ''),
      ts: String(f.ts),
      type: kind === 'ruling' ? 'ruling' : /escrow|captured|voided|units_verified/.test(kind) ? 'escrow' : kind || 'message',
      job_id: (f.job_id as string | null | undefined) ?? null,
    }
  })
}

const EMPTY_FEED: FeedItem[] = [{ summary: 'No jobs yet. The first hire will show up here as it happens.', ts: '', type: 'message' }]

export function usePublicFeed(limit = 20) {
  const q = useAsync<{ items: FeedItem[]; reachable: boolean }>(
    () =>
      apiGet<unknown>(`/api/public/feed?limit=${limit}`)
        .then((r) => ({ items: normalizeFeed(r), reachable: true }))
        .catch(() => ({ items: [] as FeedItem[], reachable: false })),
    [limit],
    { pollMs: 20000 },
  )
  // Reachable API: show its real feed, or an honest empty line. Sample events only when the API is unreachable.
  const reachable = q.data?.reachable ?? false
  const real = q.data?.items ?? []
  const items = real.length ? real : reachable ? EMPTY_FEED : FALLBACK_FEED
  return { items, live: reachable && real.length > 0 }
}
