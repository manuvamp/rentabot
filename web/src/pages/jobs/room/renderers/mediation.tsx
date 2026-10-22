import { useState } from 'react'
import { ChevronDown, ChevronUp, Clock, Scale, ShieldAlert } from 'lucide-react'
import type { Assessment, Proposal, ProposalBody, ProposalResponseBody, ProposalTerms, SettlementBody } from '../../../../api/bodies'
import { bodyOf } from '../../../../api/bodies'
import { MonoChip } from '../../../../components/court/RulingCard'
import { Chip, Receipt, ReceiptRow, ReceiptRule, Stamp } from '../../../../components/ui'
import { cents, countdown, dateTime, usd } from '../../../../lib/format'
import { flagText, flagTitle, heldCents, KIND_LABEL, ROUNDS } from '../../../../lib/mediation'
import { useNow } from '../../sidebar/useNow'
import { asArr, Bubble, type RenderCtx } from './common'
import { ProposalActions } from './ProposalActions'

const STATUS_TONE = { open: 'amber', accepted: 'lime', rejected: 'coral', superseded: 'neutral', expired: 'neutral' } as const

/** Status chips on paper need the deep tones; the ink-surface chip tones wash out on the cream receipt. */
const PAPER_TONE = {
  lime: 'border-lime-deep/50 bg-lime-deep/10 text-lime-deep',
  amber: 'border-amber-deep/50 bg-amber-deep/10 text-amber-deep',
  coral: 'border-coral-deep/50 bg-coral-deep/10 text-coral-deep',
  neutral: 'border-pink/30 bg-pink/5 text-pink',
} as const
function PaperChip({ tone, children }: { tone: keyof typeof PAPER_TONE; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] font-medium leading-5 ${PAPER_TONE[tone]}`}>{children}</span>
}

const Sub = ({ children }: { children: React.ReactNode }) => <h4 className="mb-1.5 mt-1 font-mono text-[0.68rem] font-bold uppercase tracking-[0.2em] text-pmute">{children}</h4>

/** Lines add up visually: release + refund + held = what was still uncaptured. */
export function TermsLines({ terms, preview }: { terms: ProposalTerms; preview?: Proposal['preview'] }) {
  return (
    <div>
      <ReceiptRow label="Release now" value={usd(terms.release_now)} tone="lime" strong />
      <ReceiptRow label="Refund now (void)" value={usd(terms.refund_now)} tone="coral" strong />
      {terms.redo && (
        <ReceiptRow
          label={`Held for a redo: ${terms.redo.units.length} unit${terms.redo.units.length === 1 ? '' : 's'} by ${dateTime(terms.redo.deadline)}`}
          value={`${usd(terms.redo.amount_on_success)} on success`}
          tone="amber"
        />
      )}
      {!terms.redo && terms.wait_until && <ReceiptRow label={`Held until ${dateTime(terms.wait_until)}`} value={preview ? usd(preview.held) : 'the rest'} tone="amber" />}
      {terms.cancel && <ReceiptRow label="Cancel the job" value="yes" tone="mute" />}
      {terms.note && <p className="mt-1 font-sans text-[12.5px] text-pmute">Note: {terms.note}</p>}
    </div>
  )
}

function FlagBlock({ flags }: { flags: Assessment['integrity_flags'] }) {
  return (
    <ul className="mt-2 space-y-2">
      {flags.map((f, i) => (
        <li key={i} className="flex flex-wrap items-start gap-3 rounded-lg border-2 border-dashed border-coral-deep/60 bg-coral-deep/5 p-2.5">
          <Stamp kind="flagged" rotate={-5} size="xs" delay={0.3}>
            Flagged
          </Stamp>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-wider text-coral-deep">
              <ShieldAlert className="size-3.5" aria-hidden /> {f.party}, {f.kind.replace(/_/g, ' ')} <span className="font-normal normal-case tracking-normal text-pmute">{f.round ? `round ${f.round}` : 'found during the assessment'}</span>
            </p>
            <blockquote className="mt-0.5 border-l-[3px] border-coral-deep pl-2.5 font-mono text-[12px] leading-snug">&ldquo;{f.excerpt}&rdquo;</blockquote>
          </div>
        </li>
      ))}
    </ul>
  )
}

const FINDING_TONE = { met: 'text-lime-deep', partly_met: 'text-amber-deep', not_met: 'text-coral-deep', blocked_by_buyer: 'text-pmute' } as const

/** The mediator's neutral assessment: what was verified, what was claimed, the fair range. */
export function AssessmentBlock({ a, onInk = false }: { a: Assessment; onInk?: boolean }) {
  const claimed = Math.max(cents(a.claimed_value), 1)
  const verified = cents(a.verified_value)
  const lo = cents(a.fair_range?.[0])
  const hi = cents(a.fair_range?.[1])
  const p = (c: number) => `${Math.min(100, Math.max(0, (c / claimed) * 100))}%`
  const findings = asArr<Assessment['findings'][number]>(a.findings)
  const seller = asArr<string>(a.faults?.seller)
  const buyer = asArr<string>(a.faults?.buyer)
  const reasons = asArr<string>(a.escalation_reasons)
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Scale className="size-4" aria-hidden />
        <span className="font-mono text-[0.7rem] font-bold uppercase tracking-[0.2em]">Assessment</span>
        <Chip tone="paper">neutral</Chip>
        {a.basis && <Chip tone="paper" mono>{a.basis === 'jury' ? 'three-model jury' : 'checks only'}</Chip>}
        {typeof a.confidence === 'number' && <Chip tone="paper" mono>confidence {Math.round(a.confidence * 100)}</Chip>}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        <ReceiptRow label="Verified value" value={usd(a.verified_value)} tone="lime" strong />
        <ReceiptRow label="Claimed value" value={usd(a.claimed_value)} />
      </div>
      <div className="mt-3" role="img" aria-label={`Fair range ${usd(a.fair_range?.[0])} to ${usd(a.fair_range?.[1])}, verified ${usd(a.verified_value)}, claimed ${usd(a.claimed_value)}`}>
        <div className="relative h-4 rounded-full bg-pink/10">
          <div className="absolute inset-y-0 rounded-full bg-amber-deep/35 ring-1 ring-amber-deep/60" style={{ left: p(lo), width: `calc(${p(hi)} - ${p(lo)})` }} />
          <div className="absolute inset-y-[-3px] w-[3px] rounded bg-lime-deep" style={{ left: p(verified) }} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10.5px] text-pmute">
          <span>$0</span>
          <span>
            fair range <strong className="text-pink">{usd(a.fair_range?.[0])} to {usd(a.fair_range?.[1])}</strong> (the seller&rsquo;s total)
          </span>
          <span>{usd(a.claimed_value)}</span>
        </div>
      </div>
      <p className="mt-2 font-sans text-[13px] leading-relaxed">{a.summary}</p>
      {(findings.length > 0 || seller.length > 0 || buyer.length > 0 || reasons.length > 0) && (
        <details className="mt-2 font-sans text-[12.5px]">
          <summary className="cursor-pointer font-mono text-[11px] font-bold uppercase tracking-wider text-pmute hover:text-pink">Findings and faults</summary>
          {findings.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {findings.map((f) => (
                <li key={f.deliverable_id} className="leading-snug">
                  <strong>{f.deliverable_id}</strong> <span className={`font-semibold ${FINDING_TONE[f.status] ?? ''}`}>{f.status.replace(/_/g, ' ')}</span> <span className="font-mono text-[11px] text-pmute">{Math.round(f.fulfilment * 1000) / 10}%</span>
                  {f.note && <span className="block text-pmute">{f.note}</span>}
                </li>
              ))}
            </ul>
          )}
          {(seller.length > 0 || buyer.length > 0) && (
            <div className="mt-1.5 grid gap-x-6 sm:grid-cols-2">
              {seller.length > 0 && (
                <div>
                  <span className="font-bold uppercase tracking-widest text-pmute">Seller fault</span>
                  <ul className="list-disc pl-4">{seller.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              )}
              {buyer.length > 0 && (
                <div>
                  <span className="font-bold uppercase tracking-widest text-pmute">Buyer fault</span>
                  <ul className="list-disc pl-4">{buyer.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          {reasons.length > 0 && <p className="mt-1.5 rounded-md bg-amber-deep/10 px-2 py-1 text-amber-deep"><strong>Needs a human if unresolved:</strong> {reasons.join(' ')}</p>}
        </details>
      )}
      {asArr<Assessment['integrity_flags'][number]>(a.integrity_flags).length > 0 && <FlagBlock flags={a.integrity_flags} />}
      {asArr<Assessment['jury'][number]>(a.jury).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Jurors">
          {a.jury.map((j) => (
            <span key={j.model} title={j.summary} className="inline-flex items-center gap-1.5 rounded-full border border-pink/25 bg-white/40 px-2 py-0.5 font-mono text-[11px]">
              <strong>{j.model}</strong> {Math.round(j.release_fraction * 100)}%
              <span className="text-pmute">conf {Math.round(j.confidence * 100)}</span>
            </span>
          ))}
        </div>
      )}
    </>
  )
  return <div className={`paper on-paper rounded-xl border border-pink/20 px-4 py-3 ${onInk ? 'my-2' : 'mb-3'}`}>{body}</div>
}

const ANSWER = {
  accept: { label: 'Accept', past: 'accepted', tone: 'lime' as const },
  reject: { label: 'Reject', past: 'rejected', tone: 'coral' as const },
  counter: { label: 'Counter', past: 'countered', tone: 'amber' as const },
}

/** Both sides' answers from the live mediation state. The author of a counter-proposal counts as having accepted it. */
function AnswerChips({ p }: { p: Proposal }) {
  return (
    <div className="mt-2 space-y-1.5" aria-label="Answers">
      <div className="flex flex-wrap items-center gap-1.5">
        {(['buyer', 'seller'] as const).map((side) => {
          const r = p.responses[side]
          if (p.by === side) return <PaperChip key={side} tone="neutral">{side}: proposed it</PaperChip>
          if (!r) return <PaperChip key={side} tone="neutral">{side}: {p.status === 'open' ? 'waiting' : 'no answer'}</PaperChip>
          const a = ANSWER[r.answer] ?? ANSWER.reject
          return (
            <span key={side} title={r.reason || undefined}>
              <PaperChip tone={a.tone}>
                {side}: {a.past}
              </PaperChip>
            </span>
          )
        })}
      </div>
      {(['buyer', 'seller'] as const).map((side) => {
        const r = p.responses[side]
        return r && p.by !== side && r.reason && r.answer !== 'accept' ? (
          <p key={side} className="font-sans text-[12px] leading-snug text-pmute">
            <strong className="capitalize">{side}:</strong> &ldquo;{r.reason}&rdquo;
          </p>
        ) : null
      })}
    </div>
  )
}

function RoundClock({ deadline }: { deadline: string }) {
  const now = useNow(15_000)
  const left = countdown(deadline, now)
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-pmute" title={dateTime(deadline)}>
      <Clock className="size-3" aria-hidden /> {left === 'expired' ? 'round ended' : `round ends in ${left}`}
    </span>
  )
}

/**
 * The server posts one 'proposal' message per round carrying all of the mediator's proposals ({ round, deadline, proposals[] }),
 * and one per party counter ({ proposal_id, counters, ... }). The live proposal records (status, answers) come from job.mediation.
 */
export function ProposalView(ctx: RenderCtx) {
  const { message, job } = ctx
  const b = bodyOf<ProposalBody & { proposals?: Array<Partial<Proposal> & { id: string }>; proposal_id?: string; counters?: string; terms?: ProposalTerms; preview?: Proposal['preview']; flags?: string[] }>(message)
  const live = job.mediation?.proposals ?? []
  const entries: Array<Partial<Proposal> & { id: string }> = b.proposals?.length ? b.proposals : b.proposal ? [b.proposal] : b.proposal_id ? [{ id: b.proposal_id, counters: b.counters ?? null, terms: b.terms, preview: b.preview, flags: b.flags }] : []
  if (!entries.length) return <Bubble>{message.text || 'Settlement offer.'}</Bubble>
  const round = (b.round as number | undefined) ?? live.find((x) => x.id === entries[0].id)?.round ?? 1
  // The mediator's first message of a mediation carries the neutral assessment; the server keeps it on the mediation record.
  const assessment = b.assessment ?? (b.proposals?.length && round === 1 ? job.mediation?.assessment : undefined)
  return (
    <div>
      {assessment && <AssessmentBlock a={assessment} onInk />}
      {entries.map((e) => {
        const p = live.find((x) => x.id === e.id) ?? ({ round, by: (message.from.role === 'buyer' || message.from.role === 'seller' ? message.from.role : 'mediator'), kind: 'custom', status: 'open', rationale: '', flags: [], counters: null, responses: {}, ...e } as Proposal)
        return <ProposalCard key={e.id} {...ctx} p={p} />
      })}
    </div>
  )
}

function ProposalCard({ job, role, onChanged, p }: RenderCtx & { p: Proposal }) {
  const [showUnits, setShowUnits] = useState(false)
  const med = job.mediation
  const flags = p.flags ?? []
  const pv = p.preview
  const held = heldCents(p.terms, pv)
  const sum = cents(p.terms.release_now) + cents(p.terms.refund_now) + held
  const mine = p.by === 'buyer' || p.by === 'seller'
  return (
    <div id={`proposal-${p.id}`} className="scroll-mt-24">
      <Receipt title={mine ? `Counter-offer from the ${p.by}` : 'Settlement offer'} className="my-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Chip tone="paper" mono>
            Round {p.round} of {ROUNDS}
          </Chip>
          <PaperChip tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</PaperChip>
          <Chip tone="paper" mono>
            {KIND_LABEL[p.kind] ?? p.kind}
          </Chip>
          <span className="text-[11px] text-pmute">from {p.by}</span>
        </div>
        {p.status === 'open' && med?.status === 'negotiating' && med.deadline && p.round === med.round && (
          <div className="mt-1 flex justify-center">
            <RoundClock deadline={med.deadline} />
          </div>
        )}
        <ReceiptRule />
        <TermsLines terms={p.terms} preview={pv} />
        <ReceiptRule double />
        <ReceiptRow label="Release + refund + held" value={usd(sum / 100)} strong />
        <p className="text-right text-[10.5px] text-pmute">= what was still uncaptured when this was proposed</p>
        {pv && (
          <>
            <ReceiptRule />
            <Sub>What the seller receives</Sub>
            <ReceiptRow label={pv.secured ? 'Secured now, paid with the final settlement' : 'Paid out now, after commission'} value={usd(pv.seller_payout_now)} tone="lime" strong />
            <ReceiptRow label={pv.secured ? 'Platform commission (at settlement)' : 'Platform commission now'} value={usd(pv.platform_commission)} tone="mute" />
            {cents(pv.held) > 0 && (
              <ReceiptRow label={`If the held ${usd(pv.held)} is released later`} value={`${usd(pv.held_seller_payout)} after ${usd(pv.held_commission)} commission`} tone="amber" />
            )}
          </>
        )}
        {p.terms.redo && p.terms.redo.units.length > 0 && (
          <div className="mt-2">
            <button type="button" onClick={() => setShowUnits((s) => !s)} aria-expanded={showUnits} className="inline-flex items-center gap-1 text-[11.5px] font-bold uppercase tracking-wider text-pmute hover:text-pink">
              {showUnits ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} Units ({p.terms.redo.units.length})
            </button>
            {showUnits && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {p.terms.redo.units.map((u) => (
                  <MonoChip key={u}>{u}</MonoChip>
                ))}
              </div>
            )}
            {p.terms.redo.instruction && <p className="mt-1.5 font-sans text-[12px] text-pmute">{p.terms.redo.instruction}</p>}
          </div>
        )}
        {flags.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {flags.map((f) => (
              <li key={f} className="rounded-md border border-dashed border-amber-deep/60 bg-amber-deep/10 px-2.5 py-1.5 font-sans text-[12px] leading-snug text-amber-deep">
                <strong>{flagTitle(f)}.</strong> {flagText(f)}
              </li>
            ))}
          </ul>
        )}
        {p.rationale && (
          <>
            <ReceiptRule />
            <Sub>Rationale</Sub>
            <p className="font-sans text-[13px] leading-relaxed">{p.rationale}</p>
          </>
        )}
        <ReceiptRule />
        <Sub>Answers</Sub>
        <AnswerChips p={p} />
        <p className="mt-2 break-all text-[10.5px] text-pmute">
          {p.id}
          {p.counters ? ` · counters ${p.counters}` : ''}
        </p>
      </Receipt>
      <ProposalActions job={job} role={role} proposal={p} onChanged={onChanged} />
    </div>
  )
}

export function ProposalResponseView({ message, job }: RenderCtx) {
  const b = bodyOf<ProposalResponseBody>(message)
  const a = ANSWER[b.answer ?? 'reject'] ?? ANSWER.reject
  const reason = b.reason || (b.answer === 'accept' ? '' : message.text)
  const counterTarget = b.counter_proposal_id && job.mediation?.proposals.some((p) => p.id === b.counter_proposal_id)
  return (
    <Bubble tone={a.tone}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="neutral" mono>
          {b.by ?? message.from.role}
        </Chip>
        <Chip tone={a.tone} mono>
          {a.label}
        </Chip>
        {b.proposal_id && <span className="font-mono text-[10.5px] text-mute">{b.proposal_id}</span>}
      </div>
      {reason && b.answer !== 'counter' && <blockquote className="mt-2 border-l-[3px] border-line pl-3 text-[13.5px] text-soft">{reason}</blockquote>}
      {b.answer === 'counter' && b.terms && (
        <div className="paper on-paper mt-2 rounded-lg px-3 py-2 font-mono text-[12px]">
          <TermsLines terms={b.terms} />
        </div>
      )}
      {b.answer === 'counter' && reason && <p className="mt-2 text-[13.5px] text-soft">{reason}</p>}
      {b.counter_proposal_id && (
        <p className="mt-2 text-[12.5px] text-soft">
          Became proposal{' '}
          {counterTarget ? (
            <button type="button" onClick={() => document.getElementById(`proposal-${b.counter_proposal_id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })} className="font-mono text-[11px] underline decoration-line underline-offset-2 hover:text-hl">
              {b.counter_proposal_id}
            </button>
          ) : (
            <span className="font-mono text-[11px]">{b.counter_proposal_id}</span>
          )}
          , which the other side can accept directly.
        </p>
      )}
      {b.explanation && <p className="mt-2 text-[12.5px] leading-relaxed text-mute">{b.explanation}</p>}
    </Bubble>
  )
}

export function SettlementView({ message, job }: RenderCtx) {
  const raw = bodyOf<SettlementBody & { executed?: unknown; release?: string; refund?: string; held?: string; commission?: string; contract_version?: number }>(message)
  // The server sends flat totals (executed: 'final' | 'partial', release, refund, held, commission); older/mock bodies nest them under `executed`.
  const money = (v: string | undefined) => cents(v ?? '0')
  const e: SettlementBody['executed'] | undefined =
    raw.executed && typeof raw.executed === 'object'
      ? (raw.executed as SettlementBody['executed'])
      : raw.release !== undefined
        ? { captured: raw.release, platform_fee: raw.commission ?? '0.00', seller_payout: ((money(raw.release) - money(raw.commission)) / 100).toFixed(2), refunded: raw.refund ?? '0.00', still_held: raw.held ?? '0.00' }
        : undefined
  const b = { ...raw, round: raw.round ?? job.mediation?.proposals.find((x) => x.id === raw.proposal_id)?.round }
  return (
    <div className="relative">
      <Receipt title="Agreement" className="my-3">
        <div className="flex justify-center py-1">
          <Stamp kind="paid" rotate={-4} size="sm" delay={0.15}>
            Settled by agreement
          </Stamp>
        </div>
        <p className="mt-1 text-center text-[11px] text-pmute">
          Round {b.round ?? '?'}
          {b.kind ? ` · ${KIND_LABEL[b.kind] ?? b.kind}` : ''} · {b.proposal_id}
        </p>
        <ReceiptRule />
        {b.terms && <TermsLines terms={b.terms} />}
        {e && (
          <>
            <ReceiptRule double />
            <Sub>Executed (escrow totals)</Sub>
            {e.captured && <ReceiptRow label="Captured" value={usd(e.captured)} tone="lime" />}
            {e.platform_fee && <ReceiptRow label="Platform commission" value={usd(e.platform_fee)} tone="mute" />}
            {e.seller_payout && <ReceiptRow label="Seller payout" value={usd(e.seller_payout)} strong tone="lime" />}
            {e.refunded && <ReceiptRow label="Refunded (voided)" value={usd(e.refunded)} tone="coral" />}
            {e.still_held && <ReceiptRow label="Still held" value={usd(e.still_held)} tone="amber" />}
          </>
        )}
        {b.amendment && (
          <>
            <ReceiptRule />
            <Sub>Contract amendment{b.amendment.version ? ` (now v${b.amendment.version})` : ''}</Sub>
            <ReceiptRow label="Units" value={b.amendment.units.length ? asArr(b.amendment.units).length : 'none (wait)'} />
            {b.amendment.deliverable_id && <ReceiptRow label="Deliverable" value={b.amendment.deliverable_id} />}
            <ReceiptRow label={b.kind === 'wait' ? 'Held until' : 'New deadline'} value={dateTime(b.amendment.deadline)} />
            {b.amendment.note && <p className="mt-1 font-sans text-[12.5px]">{b.amendment.note}</p>}
          </>
        )}
      </Receipt>
    </div>
  )
}

/** A mediator note that carries an assessment. */
export function AssessmentNote({ message }: RenderCtx) {
  const a = (message.body as { assessment?: Assessment }).assessment
  return (
    <div>
      {message.text && <p className="mb-1 text-[14px] text-soft">{message.text}</p>}
      {a && <AssessmentBlock a={a} onInk />}
    </div>
  )
}
