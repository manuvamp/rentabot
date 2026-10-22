import { useState } from 'react'
import { Banknote, Gavel, Handshake, Scale, ShieldAlert, ThumbsDown, ThumbsUp, UserCheck } from 'lucide-react'
import type { Ruling } from '../../../../api/types'
import type { AcceptBody, AppealBody, ArbiterDecisionBody, DisputeBody, MediatorQuestionBody, ReviewBody, RulingBody, SystemBody } from '../../../../api/bodies'
import { bodyOf } from '../../../../api/bodies'
import { RulingCard } from '../../../../components/court/RulingCard'
import { Chip, HashText, Stamp } from '../../../../components/ui'
import { prettyText, usd } from '../../../../lib/format'
import { ArtifactThumbs, asArr, asStr, Bubble, Label, PaperCard, type RenderCtx } from './common'

export function AcceptView({ message, ctx }: RenderCtx & { ctx: RenderCtx }) {
  const b = bodyOf<AcceptBody>(message)
  const role = message.from.role
  const frozen = Boolean(b.frozen)
  void ctx
  return (
    <div className="relative">
      <PaperCard className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[0.65rem] font-bold uppercase tracking-[0.2em] text-pmute">Signed by {role}</p>
          <p className="font-display text-2xl italic leading-tight text-pink" style={{ fontStretch: '85%' }}>
            {role === 'buyer' ? 'Buyer agent' : role === 'seller' ? 'Seller bot' : role}
          </p>
          <p className="mt-1 break-all font-mono text-[11px] text-pmute">
            contract <HashText hash={b.contract_hash} n={12} />
          </p>
        </div>
        {frozen && (
          <Stamp kind="ruled" rotate={-6} size="sm" delay={0.15}>
            Contract frozen
          </Stamp>
        )}
      </PaperCard>
    </div>
  )
}

export function DeclineView({ message }: RenderCtx) {
  return (
    <Bubble tone="coral">
      <p className="mb-1 text-[12px] font-bold uppercase tracking-wider text-coral">Declined</p>
      {message.text}
    </Bubble>
  )
}

export function ReviewView({ message }: RenderCtx) {
  const b = bodyOf<ReviewBody>(message)
  const accept = b.decision === 'accept'
  const rej = asArr<NonNullable<ReviewBody['rejections']>[number]>(b.rejections)
  return (
    <Bubble tone={accept ? 'lime' : 'amber'}>
      <p className={`mb-1 inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider ${accept ? 'text-lime' : 'text-amber'}`}>
        {accept ? <ThumbsUp className="size-4" aria-hidden /> : <ThumbsDown className="size-4" aria-hidden />} Buyer {accept ? 'accepted the delivery' : 'rejected items'}
      </p>
      {message.text && !rej.length && <p>{message.text}</p>}
      {rej.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-[13px]">
          {rej.map((r, i) => (
            <li key={i} className="rounded-lg border border-line bg-ink px-3 py-2">
              <span className="font-mono text-amber">{r.deliverable_id}</span>
              {r.check && <span className="font-mono text-mute"> · {r.check}</span>}
              {asArr<string>(r.unit_refs).length > 0 && <span className="font-mono text-mute"> · {asArr<string>(r.unit_refs).length} units</span>}
              <p className="mt-0.5 text-soft">{r.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </Bubble>
  )
}

export function DisputeView({ message }: RenderCtx) {
  const b = bodyOf<DisputeBody>(message)
  const claims = asArr<string>(b.claims)
  return (
    <div className="rounded-2xl rounded-tl-md border-2 border-coral/60 bg-coral/[0.07] px-4 py-3">
      <p className="mb-1 inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-coral">
        <ShieldAlert className="size-4" aria-hidden /> Dispute opened · escrow frozen
      </p>
      <p className="text-[14px] text-fog">{b.reason ?? message.text}</p>
      {claims.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-soft marker:font-mono marker:text-coral">
          {claims.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function MediatorQuestionView({ message, ctx }: { message: RenderCtx['message']; ctx: RenderCtx }) {
  const b = bodyOf<MediatorQuestionBody>(message)
  const answered = ctx.messages.some((m) => m.type === 'mediator_answer' && (m.body as { question_id?: string }).question_id === b.question_id)
  return (
    <div className="rounded-2xl border border-paper-3/40 bg-ink-2 p-4 shadow-[inset_0_3px_0_0_var(--color-paper)]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Scale className="size-4 text-paper" aria-hidden />
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-paper">From the bench</span>
        <Chip mono>{b.question_id ?? 'question'}</Chip>
        <Chip tone="amber">to {b.to ?? 'party'}</Chip>
        <Chip tone={answered ? 'lime' : 'amber'}>{answered ? 'answered' : 'awaiting answer'}</Chip>
      </div>
      <p className="font-display text-lg font-semibold leading-snug tracking-tight text-paper">{b.question ?? message.text}</p>
    </div>
  )
}

export function MediatorAnswerView({ message, ctx }: { message: RenderCtx['message']; ctx: RenderCtx }) {
  const q = (message.body as { question_id?: string }).question_id
  return (
    <Bubble>
      {q && <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-mute">Answer to {q}</p>}
      <p className="whitespace-pre-wrap break-words">{message.text}</p>
      <ArtifactThumbs ids={message.artifact_ids} job={ctx.job} />
    </Bubble>
  )
}

export function RulingView({ message, ctx }: RenderCtx & { ctx: RenderCtx }) {
  const [full, setFull] = useState(false)
  const ruling = (bodyOf<RulingBody>(message).ruling as Ruling | undefined) ?? ctx.job.ruling
  if (!ruling) return <Bubble>{message.text}</Bubble>
  return (
    <div>
      <p className="mb-1 inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-paper">
        <Gavel className="size-4" aria-hidden /> Mediator ruling
      </p>
      {message.text && <p className="text-[14px] text-soft">{message.text}</p>}
      <RulingCard ruling={ruling} compact={!full} recommended={!ctx.messages.some((m) => (m.type as string) === 'settlement')} />
      <button type="button" onClick={() => setFull((f) => !f)} aria-expanded={full} className="text-[13px] font-medium text-lime underline-offset-4 hover:underline">
        {full ? 'Collapse verdict' : 'Read the full verdict: reasoning and jury summaries'}
      </button>
    </div>
  )
}

export function AppealView({ message }: RenderCtx) {
  const b = bodyOf<AppealBody>(message)
  return (
    <Bubble tone="amber">
      <p className="mb-1 inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-amber">
        <UserCheck className="size-4" aria-hidden /> Appeal to a human arbiter
      </p>
      <p>{b.grounds ?? message.text}</p>
    </Bubble>
  )
}

export function ArbiterDecisionView({ message }: RenderCtx) {
  const b = bodyOf<ArbiterDecisionBody>(message)
  const confirm = b.decision === 'confirm'
  return (
    <div className="relative">
      <PaperCard>
        <p className="font-mono text-[0.65rem] font-bold uppercase tracking-[0.2em] text-pmute">Human arbiter decision</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <p className="font-display text-2xl font-extrabold">{confirm ? 'Ruling confirmed' : 'Ruling overridden'}</p>
          {b.release_to_seller && <span className="font-mono text-sm">release {usd(b.release_to_seller)}</span>}
          <Stamp kind={confirm ? 'ruled' : 'flagged'} rotate={-5} size="sm">
            {confirm ? 'Final' : 'Overridden'}
          </Stamp>
        </div>
        <p className="mt-2 font-sans text-[13.5px] leading-relaxed">{b.note ?? message.text}</p>
      </PaperCard>
    </div>
  )
}

/** One platform line. Used standalone and inside grouped runs. */
export function SystemLine({ message }: { message: RenderCtx['message'] }) {
  const b = bodyOf<SystemBody>(message)
  const flag = Boolean(b.flag) || b.event === 'integrity_flag'
  const money = b.event && ['authorized', 'captured', 'voided', 'refunded', 'payout_sent', 'payout_succeeded'].includes(b.event)
  const Icon = flag ? ShieldAlert : money ? Banknote : b.event === 'appealed' ? Gavel : Handshake
  return (
    <div className={`flex items-start gap-2.5 text-[13px] ${flag ? 'text-coral' : 'text-soft'}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${flag ? 'text-coral' : money ? 'text-lime' : 'text-mute'}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="break-words">{prettyText(message.text)}</span>
        {(b.amount || b.paypal_id || b.webhook) && (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {b.amount && <Chip tone={b.event === 'voided' ? 'coral' : 'lime'} mono>{usd(asStr(b.amount))}</Chip>}
            {b.paypal_id && <Chip mono>{b.paypal_id}</Chip>}
            {b.webhook && (
              <Chip tone="neutral" mono>
                <span className="size-1.5 rounded-full bg-lime" aria-hidden /> {b.webhook}
              </Chip>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

export function SectionLabel({ children }: { children: string }) {
  return <Label>{children}</Label>
}
