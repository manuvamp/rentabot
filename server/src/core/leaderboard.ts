// Seller track records for get_leaderboard, computed from the same job records stats() reads (fulfilment, escrow, mediation).
import type { BotCard, OpOutput } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { Domain } from './domain.ts'
import type { JobRecord } from './model.ts'
import { toAmount } from './util.ts'

export type LeaderboardSort = 'verified_units' | 'pass_rate' | 'on_time_rate' | 'dispute_rate' | 'agreement_share' | 'released'
export type LeaderboardRow = OpOutput<'get_leaderboard'>['rows'][number]

const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null)

/** What a seller was paid for on one job: captured money minus the buyer-side mediation fee, as in stats().released_total. */
const releasedCents = (j: JobRecord) => Math.max(0, j.escrow.captured - j.escrow.platform_extra)

export function leaderboard(d: Domain, sort: LeaderboardSort, limit: number): OpOutput<'get_leaderboard'> {
  const bots = d.db.all<{ data: string }>("SELECT data FROM bots WHERE status = 'listed' ORDER BY created_at").map((r) => json<BotCard>(r.data))
  const jobs = d.db.all<{ data: string }>('SELECT data FROM jobs').map((r) => json<JobRecord>(r.data))
  const byBot = new Map<string, JobRecord[]>()
  for (const j of jobs) byBot.set(j.seller_bot_id, [...(byBot.get(j.seller_bot_id) ?? []), j])

  const rows = bots.map((b) => {
    const mine = byBot.get(b.id) ?? []
    const funded = mine.filter((j) => j.escrow.funded_at)
    const settled = mine.filter((j) => j.state === 'SETTLED')
    const passed = mine.reduce((s, j) => s + j.fulfilment.reduce((a, f) => a + f.passed_units, 0), 0)
    const failed = mine.reduce((s, j) => s + j.fulfilment.reduce((a, f) => a + f.failed_units, 0), 0)
    const timed = settled.filter((j) => j.on_time !== null)
    const disputed = mine.filter((j) => j.mediation)
    const agreed = disputed.filter((j) => j.mediation?.state.agreed_proposal_id).length
    const row: Omit<LeaderboardRow, 'rank'> = {
      bot_id: b.id,
      name: b.name,
      tagline: b.tagline,
      mode: b.mode,
      jobs_settled: settled.length,
      jobs_funded: funded.length,
      verified_units: passed,
      units_checked: passed + failed,
      pass_rate: ratio(passed, passed + failed),
      on_time_rate: ratio(timed.filter((j) => j.on_time).length, timed.length),
      dispute_rate: ratio(disputed.length, funded.length),
      disputes: disputed.length,
      settled_by_agreement: agreed,
      agreement_share: ratio(agreed, disputed.length),
      released: toAmount(mine.reduce((s, j) => s + releasedCents(j), 0)),
    }
    return row
  })

  const value = (r: Omit<LeaderboardRow, 'rank'>): number | null => {
    switch (sort) {
      case 'verified_units':
        return r.verified_units
      case 'released':
        return Number(r.released)
      case 'pass_rate':
        return r.pass_rate
      case 'on_time_rate':
        return r.on_time_rate
      case 'dispute_rate':
        return r.dispute_rate
      case 'agreement_share':
        return r.agreement_share
    }
  }
  const dir = sort === 'dispute_rate' ? 1 : -1 // fewest disputes first
  rows.sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1 // no data ranks last
    return x === y ? b.verified_units - a.verified_units || a.name.localeCompare(b.name) : (x - y) * dir
  })

  return { sort_by: sort, payment_rail: d.rail.kind, rows: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })) }
}
