// Small pure helpers for the negotiation-first mediation UI. No zod here: the runtime schemas load lazily with the counter form.
import type { Job, Proposal, ProposalKind, ProposalTerms, Role, SettlementPreview } from '../api/types'
import { cents } from './format'

/** Mirrors MAX_ROUNDS in shared/src/mediation.ts (importing the shared runtime here would pull zod into the main bundle). */
export const ROUNDS = 3

/** Money still uncaptured on the escrow: what a settlement can still release, refund or hold (cents). */
export const uncapturedCents = (job: Job) => Math.max(cents(job.escrow.authorized.value) - cents(job.escrow.captured.value) - cents(job.escrow.voided.value) - cents(job.escrow.refunded.value), 0)

/** What the terms keep held: the redo amount, or the remainder under a wait (taken from the preview when there is one). Cents. */
export function heldCents(t: ProposalTerms, preview?: SettlementPreview | null): number {
  if (t.redo) return cents(t.redo.amount_on_success)
  if (t.wait_until && preview) return cents(preview.held)
  return 0
}

/** The server rule: only buyer or seller, job DISPUTED, mediation negotiating, proposal open, not your own, not answered by you yet. */
export function canAnswer(job: Job, role: Role, p: Proposal): boolean {
  if (role !== 'buyer' && role !== 'seller') return false
  return job.state === 'DISPUTED' && job.mediation?.status === 'negotiating' && p.status === 'open' && p.by !== role && !p.responses[role]
}

export const KIND_LABEL: Record<ProposalKind, string> = { split: 'split', redo: 'redo', substitute: 'substitute work', wait: 'wait', cancel: 'cancel', custom: 'custom' }

const FLAG_TEXT: Record<string, string> = {
  outside_fair_range_high: 'Pays the seller more than the evidence supports. The other side can still accept it, but the mediator will not carry it into the next round.',
  outside_fair_range_low: 'Pays the seller less than the checks verified. The other side can still accept it, but the mediator will not carry it into the next round.',
}
export const flagText = (f: string) => FLAG_TEXT[f] ?? f.replace(/_/g, ' ')
export const flagTitle = (f: string) => (f === 'outside_fair_range_high' ? 'Above the fair range' : f === 'outside_fair_range_low' ? 'Below the fair range' : f.replace(/_/g, ' '))

export const MEDIATION_STATUS_TEXT: Record<string, string> = {
  investigating: 'The mediator is re-running the checks.',
  proposing: 'The mediator is writing the first proposals.',
  negotiating: 'Answer each open proposal: accept, reject with a reason, or counter.',
  agreed: 'Both sides agreed. The terms were executed.',
  no_agreement: 'No agreement. The mediator\'s last fair proposal became a recommended ruling.',
}

/** "a, b\nc" -> ["a","b","c"] */
export const splitList = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

/** ISO -> value for <input type="datetime-local"> in the viewer's zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "5", "5.5", "$5.50" -> "5.50"; null when it is not an amount the schema would accept. */
export function toAmountString(s: string): string | null {
  const t = s.trim().replace(/^\$/, '')
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null
  return Number(t).toFixed(2)
}
