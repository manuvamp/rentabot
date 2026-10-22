// Shared bits for the open-jobs pages: phase logic, live countdown, the job "tag" card and labels.
import { Link } from 'react-router'
import { Gavel, Users } from 'lucide-react'
import type { AwardMode, OpenJob } from '../../api/types'
import { Stamp } from '../../components/ui'
import { usd } from '../../lib/format'
import { useNow } from '../jobs/sidebar/useNow'

export { useNow }

/** bidding: taking bids. choosing: window closed, manual award still possible. awarded / expired: closed for good. */
export type Phase = 'bidding' | 'choosing' | 'awarded' | 'expired'

export function phaseOf(oj: OpenJob, now: number): Phase {
  if (oj.state === 'awarded') return 'awarded'
  if (oj.state === 'expired') return 'expired'
  if (now < Date.parse(oj.bid_until)) return 'bidding'
  if (oj.award === 'manual' && now < Date.parse(oj.award_until)) return 'choosing'
  // the platform has not swept it yet: treat an auto-award job past its window as closing
  return oj.award === 'manual' ? 'expired' : 'choosing'
}

export const AWARD_LABEL: Record<AwardMode, string> = {
  manual: 'Buyer picks',
  lowest_price: 'Lowest price wins',
  best_record: 'Best record wins',
}
export const AWARD_HINT: Record<AwardMode, string> = {
  manual: 'The buyer compares the bids and awards one by hand.',
  lowest_price: 'When the window closes, the platform awards the cheapest standing bid.',
  best_record: 'When the window closes, the platform awards the bot with the best verified record.',
}

/** "1h 12m left", "4m 09s left", "closed" */
export function timeLeft(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (ms <= 0) return 'closed'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d >= 1) return `${d}d ${h}h left`
  if (h >= 1) return `${h}h ${m}m left`
  if (m >= 10) return `${m}m left`
  return `${m}m ${String(s % 60).padStart(2, '0')}s left`
}

/** Unique acceptance check ids across every deliverable. */
export function checksOf(oj: OpenJob): string[] {
  return [...new Set(oj.spec.deliverables.flatMap((d) => d.acceptance.map((a) => a.check)))]
}

export const unitsOf = (oj: OpenJob) => oj.spec.deliverables.reduce((n, d) => n + d.quantity, 0)

export function CheckChip({ id, onPaper = true }: { id: string; onPaper?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-[5px] border px-1.5 py-px font-mono text-[10.5px] ${onPaper ? 'border-pink/30 bg-white/40 text-pink/85' : 'border-line bg-ink-2 text-soft'}`}>
      {id.replace(/_/g, ' ')}
    </span>
  )
}

export function PhaseStamp({ phase, size = 'xs', on = 'paper', animate = false }: { phase: Phase; size?: 'xs' | 'sm' | 'md'; on?: 'paper' | 'ink'; animate?: boolean }) {
  if (phase === 'bidding')
    return (
      <Stamp kind="verified" size={size} on={on} rotate={-4} animate={animate}>
        Taking bids
      </Stamp>
    )
  if (phase === 'choosing')
    return (
      <Stamp kind="held" size={size} on={on} rotate={-4} animate={animate}>
        Bids closed
      </Stamp>
    )
  if (phase === 'awarded')
    return (
      <Stamp kind="ruled" size={size} on={on} rotate={-6} animate={animate}>
        Awarded
      </Stamp>
    )
  return (
    <Stamp kind="voided" size={size} on={on} rotate={-6} animate={animate}>
      Expired
    </Stamp>
  )
}

const NOTE: Record<Phase, string> = { bidding: '', choosing: 'note-lav', awarded: 'note-mint', expired: 'note-sand' }

/** One open job on the board, as a pinned sticky note. */
export function OpenJobTag({ oj, now, rotate = 0, index = 0 }: { oj: OpenJob; now: number; rotate?: number; index?: number }) {
  const phase = phaseOf(oj, now)
  const checks = checksOf(oj)
  return (
    <Link
      to={`/explore/${oj.id}`}
      className={`note note-hover pin block !p-5 ${phase === 'bidding' ? ['', 'note-pink', 'note-lav'][index % 3] : NOTE[phase]} ${phase === 'expired' ? 'opacity-80' : ''}`}
      style={{ ['--r' as string]: `${rotate}deg` }}
      aria-label={`${oj.title}. Budget up to ${usd(oj.spec.budget_cap)}. ${oj.bids_count} bids. Open the job.`}
    >
      <div className="flex items-start justify-between gap-3">
        <PhaseStamp phase={phase} />
        <p className="num font-mono text-[17px] font-bold leading-none">{usd(oj.spec.budget_cap)}</p>
      </div>
      <h3 className="hand mt-3 line-clamp-3 text-[1.85rem] font-bold leading-[0.95]">{oj.title}</h3>
      {checks.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1" aria-label="Acceptance checks">
          {checks.slice(0, 4).map((c) => (
            <CheckChip key={c} id={c} />
          ))}
          {checks.length > 4 && <span className="font-mono text-[10.5px] opacity-70">+{checks.length - 4}</span>}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-pink/20 pt-2.5 font-mono text-[11.5px]">
        <span className="inline-flex items-center gap-1">
          <Gavel className="size-3.5" aria-hidden /> <strong className="num">{oj.bids_count}</strong> / {oj.matching_bots}
          <Users className="size-3.5" aria-hidden />
        </span>
        <span className="num truncate font-bold">
          {phase === 'bidding'
            ? timeLeft(oj.bid_until, now)
            : phase === 'awarded' && oj.awarded_to
              ? `${oj.awarded_to.bot_name} · ${usd(oj.awarded_to.price)}`
              : phase === 'choosing'
                ? 'Buyer choosing'
                : 'Expired'}
        </span>
      </div>
      <p className="mt-1 font-mono text-[10.5px] opacity-70">{AWARD_LABEL[oj.award]}</p>
    </Link>
  )
}

/** Query string for the post page, so "Repost" and other entry points can prefill it. */
export function postHref(p: { goal?: string; skill?: string; budget?: string }): string {
  const q = new URLSearchParams()
  if (p.goal) q.set('goal', p.goal.slice(0, 1000))
  if (p.skill) q.set('skill', p.skill)
  if (p.budget) q.set('budget', p.budget)
  const s = q.toString()
  return s ? `/post?${s}` : '/post'
}
