// Reputation (updated when a job settles), public stats and the anonymized activity feed.
import type { BotCard, EscrowEventKind } from '@rentabot/shared'
import { json } from '../db/index.ts'
import type { Domain } from './domain.ts'
import { heldCents, type JobRecord } from './model.ts'
import type { FeedItem, PublicStats } from './types.ts'
import { toAmount } from './util.ts'

export interface BotStats {
  jobs_completed: number
  on_time: number
  on_time_total: number
  jobs_total: number
  disputes: number
  rulings_lost: number
  integrity_flags: number
  /** Disputes settled by the parties' own agreement in mediation (no ruling). */
  settled_by_agreement: number
  fulfilment_sum: number
  fulfilment_n: number
}
export const emptyStats = (): BotStats => ({ jobs_completed: 0, on_time: 0, on_time_total: 0, jobs_total: 0, disputes: 0, rulings_lost: 0, integrity_flags: 0, settled_by_agreement: 0, fulfilment_sum: 0, fulfilment_n: 0 })

const round2 = (x: number) => Math.round(x * 100) / 100

/** One job's platform P&L in cents. The single definition of "net" used by the ledger and the analytics tables. */
export function jobPnl(j: JobRecord) {
  const commission = j.escrow.platform_fee
  const mediation = j.escrow.platform_extra + j.escrow.seller_fee
  const capture_fee = j.escrow.paypal_fees?.capture ?? 0
  const payout_fee = j.escrow.paypal_fees?.payout ?? 0
  const kept = j.escrow.refund_fee ?? 0
  return { commission, mediation, kept, capture_fee, payout_fee, net: commission + mediation + kept - capture_fee - payout_fee }
}

export class Stats {
  private d: Domain
  constructor(d: Domain) {
    this.d = d
  }

  feedItem(kind: FeedItem['kind'], text: string, cents: number | null = null) {
    this.d.db.run('INSERT INTO feed (ts, kind, text, amount) VALUES (?, ?, ?, ?)', this.d.nowIso(), kind, text.slice(0, 300), cents === null ? null : toAmount(cents))
    this.d.bus.publish('bot', null, { agents: [], public: true }, text.slice(0, 300), { feed: kind, amount: cents === null ? null : toAmount(cents) })
  }

  botName(rec: JobRecord) {
    return this.d.bot(rec.seller_bot_id)?.name ?? 'A bot'
  }
  unitWord(rec: JobRecord) {
    const unit = this.d.bot(rec.seller_bot_id)?.skills.find((s) => s.id === rec.skill_id)?.pricing.unit
    return unit ? unit.replace(/^verified_/, '').replace(/_/g, ' ') + 's' : 'units'
  }

  onMoney(rec: JobRecord, kind: EscrowEventKind, cents: number | null) {
    if (kind === 'authorized' && cents) this.feedItem('escrow_authorized', `${this.botName(rec)}: $${toAmount(cents)} held in escrow for a new job`, cents)
    else if (kind === 'captured' && cents) {
      const passed = rec.fulfilment.reduce((s, f) => s + f.passed_units, 0)
      const expected = rec.fulfilment.reduce((s, f) => s + f.expected_units, 0)
      this.feedItem('captured', `${this.botName(rec)}: ${passed}/${expected} ${this.unitWord(rec)} verified, $${toAmount(cents)} captured`, cents)
    } else if (kind === 'voided' && cents) this.feedItem('voided', `${this.botName(rec)}: $${toAmount(cents)} never charged (voided back to the buyer)`, cents)
  }

  private loadStats(bot_id: string): { bot: BotCard; stats: BotStats } | null {
    const r = this.d.db.get<{ data: string; stats: string }>('SELECT data, stats FROM bots WHERE id = ?', bot_id)
    return r ? { bot: json<BotCard>(r.data), stats: { ...emptyStats(), ...json<BotStats>(r.stats) } } : null
  }

  /** Called once when a job reaches a terminal state. */
  onTerminal(rec: JobRecord) {
    const s = this.loadStats(rec.seller_bot_id)
    if (!s) return
    const st = s.stats
    const funded = !!rec.escrow.funded_at
    if (funded) st.jobs_total += 1
    if (rec.state === 'SETTLED') {
      st.jobs_completed += 1
      if (rec.on_time !== null) {
        st.on_time_total += 1
        if (rec.on_time) st.on_time += 1
      }
      const expected = rec.fulfilment.reduce((a, f) => a + f.expected_units, 0)
      if (expected > 0) {
        st.fulfilment_sum += Math.min(1, rec.fulfilment.reduce((a, f) => a + f.passed_units, 0) / expected)
        st.fulfilment_n += 1
      }
    }
    if (rec.mediation) st.disputes += 1
    if (rec.mediation?.state.agreed_proposal_id) st.settled_by_agreement += 1
    // Integrity flags: the mediation's assessment is the record (it also holds flags raised while negotiating); a ruling
    // without one (older jobs, arbiter-made rulings) falls back to its own list.
    const flags = rec.mediation?.state.assessment?.integrity_flags ?? rec.ruling?.integrity_flags ?? []
    st.integrity_flags += flags.filter((f) => f.party === 'seller').length
    // Actions the seller reported outside the buyer's consent (log_action rejections) are integrity issues too.
    st.integrity_flags += Number(this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM locker_actions WHERE job_id = ? AND accepted = 0', rec.id)?.n ?? 0)
    if (rec.ruling && rec.ruling.seller_fault.length) st.rulings_lost += 1
    s.bot.reputation = {
      jobs_completed: st.jobs_completed,
      on_time_rate: st.on_time_total ? round2(st.on_time / st.on_time_total) : null,
      dispute_rate: st.jobs_total ? round2(st.disputes / st.jobs_total) : null,
      rulings_lost: st.rulings_lost,
      integrity_flags: st.integrity_flags,
      avg_fulfilment: st.fulfilment_n ? round2(st.fulfilment_sum / st.fulfilment_n) : null,
      settled_by_agreement: st.settled_by_agreement,
    }
    this.d.db.run('UPDATE bots SET data = ?, stats = ? WHERE id = ?', JSON.stringify(s.bot), JSON.stringify(st), s.bot.id)
  }

  stats(): PublicStats {
    const jobs = this.d.db.all<{ data: string }>('SELECT data FROM jobs').map((r) => json<JobRecord>(r.data))
    const minutes = jobs
      .filter((j) => j.mediation?.closed_at)
      .map((j) => (Date.parse(j.mediation!.closed_at!) - Date.parse(j.mediation!.opened_at)) / 60_000)
      .sort((a, b) => a - b)
    const median = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2] : (minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2) : null
    return {
      bots_listed: Number(this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bots WHERE status = 'listed'")?.n ?? 0),
      jobs_total: jobs.length,
      jobs_settled: jobs.filter((j) => j.state === 'SETTLED').length,
      units_verified: jobs.reduce((s, j) => s + j.fulfilment.reduce((a, f) => a + f.passed_units, 0), 0),
      held_now: toAmount(jobs.reduce((s, j) => s + heldCents(j.escrow), 0)),
      released_total: toAmount(jobs.reduce((s, j) => s + j.escrow.captured - j.escrow.platform_extra, 0)),
      voided_total: toAmount(jobs.reduce((s, j) => s + j.escrow.voided, 0)),
      disputes_total: jobs.filter((j) => j.mediation).length,
      median_dispute_minutes: median === null ? null : Math.round(median * 10) / 10,
      payment_rail: this.d.rail.kind,
    }
  }

  /** Platform P&L from the ledger: commissions and mediation fees earned vs. PayPal fees actually charged. */
  pnl() {
    const jobs = this.d.db.all<{ data: string }>('SELECT data FROM jobs').map((r) => json<JobRecord>(r.data))
    const commission = jobs.reduce((s, j) => s + j.escrow.platform_fee, 0)
    const mediation = jobs.reduce((s, j) => s + j.escrow.platform_extra + j.escrow.seller_fee, 0)
    const kept = jobs.reduce((s, j) => s + (j.escrow.refund_fee ?? 0), 0)
    const capture = jobs.reduce((s, j) => s + (j.escrow.paypal_fees?.capture ?? 0), 0)
    const payout = jobs.reduce((s, j) => s + (j.escrow.paypal_fees?.payout ?? 0), 0)
    return { commission: toAmount(commission), mediation_fees: toAmount(mediation), refund_fees_kept: toAmount(kept), paypal_capture_fees: toAmount(capture), paypal_payout_fees: toAmount(payout), net: toAmount(commission + mediation + kept - capture - payout) }
  }

  /** Per-job platform P&L (jobs with money movement, newest first) and totals: what get_platform_ledger returns. */
  ledger(limit: number) {
    const rows = this.d.db.all<{ data: string }>('SELECT data FROM jobs ORDER BY updated_at DESC').map((r) => json<JobRecord>(r.data))
    const moved = rows.filter((j) => j.escrow.captured > 0 || j.escrow.platform_fee > 0 || (j.escrow.paypal_fees?.capture ?? 0) > 0 || (j.escrow.paypal_fees?.payout ?? 0) > 0)
    const line = (j: JobRecord) => {
      const p = jobPnl(j)
      return { job_id: j.id, title: j.title, state: j.state, captured: toAmount(j.escrow.captured), commission: toAmount(p.commission), mediation_fees: toAmount(p.mediation), refund_fees_kept: toAmount(p.kept), paypal_capture_fees: toAmount(p.capture_fee), paypal_payout_fees: toAmount(p.payout_fee), net: toAmount(p.net) }
    }
    const t = this.pnl()
    return {
      currency: 'USD' as const,
      totals: { jobs: moved.length, captured: toAmount(moved.reduce((s, j) => s + j.escrow.captured, 0)), ...t },
      jobs: moved.slice(0, limit).map(line),
    }
  }

  feed(limit = 20): FeedItem[] {
    return this.d.db
      .all<{ ts: string; kind: FeedItem['kind']; text: string; amount: string | null }>('SELECT ts, kind, text, amount FROM feed ORDER BY id DESC LIMIT ?', Math.max(1, Math.min(200, limit)))
      .map((r) => ({ ts: r.ts, kind: r.kind, text: r.text, amount: r.amount }))
  }
}
