import { Clock, Handshake } from 'lucide-react'
import type { Job, Proposal, Role } from '../../../api/types'
import { Chip } from '../../../components/ui'
import { countdown, dateTime, usd } from '../../../lib/format'
import { canAnswer, MEDIATION_STATUS_TEXT, ROUNDS } from '../../../lib/mediation'
import { useNow } from './useNow'

const TONE = { investigating: 'amber', proposing: 'amber', negotiating: 'amber', agreed: 'lime', no_agreement: 'coral' } as const

function brief(p: Proposal): string {
  const mine = (['buyer', 'seller'] as const)
    .filter((s) => p.by !== s)
    .map((s) => {
      const a = p.responses[s]?.answer
      return `${s} ${a === 'accept' ? 'accepted' : a === 'reject' ? 'rejected' : a === 'counter' ? 'countered' : p.status === 'open' ? 'waiting' : 'no answer'}`
    })
  return `${p.by === 'mediator' ? 'Mediator' : `${p.by} counter`} · ${p.status} · ${mine.join(', ')}`
}

/** Where the negotiation stands: status, round and its clock, the fair range, and every proposal with its answers. Shown from the dispute onward. */
export function MediationPanel({ job, role }: { job: Job; role: Role }) {
  const now = useNow(15_000)
  const med = job.mediation
  if (!med) return null
  const a = med.assessment
  const live = med.status === 'investigating' || med.status === 'proposing' || med.status === 'negotiating'
  const left = med.deadline && live ? countdown(med.deadline, now) : ''
  const toAnswer = med.proposals.filter((p) => canAnswer(job, role, p))
  const go = (id: string) => document.getElementById(`proposal-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return (
    <section id="mediation-panel" aria-labelledby="mediation-h" className="panel scroll-mt-24 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="mediation-h" className="flex items-center gap-2 font-display text-lg font-extrabold tracking-tight">
          <Handshake className="size-4 text-lime" aria-hidden /> Mediation
        </h2>
        <Chip tone={TONE[med.status]} mono>
          {med.status.replace('_', ' ')}
        </Chip>
      </div>
      <p className="text-[13px] leading-snug text-soft">{MEDIATION_STATUS_TEXT[med.status]}</p>

      <dl className="mt-3 space-y-1.5 text-[13px]">
        {med.round > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="text-mute">Round</dt>
            <dd className="num font-mono text-fog">
              {med.round} of {ROUNDS}
            </dd>
          </div>
        )}
        {left && (
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-mute">
              <Clock className="size-3.5" aria-hidden /> {med.status === 'negotiating' ? 'Round ends' : 'Next step by'}
            </dt>
            <dd className="text-right font-mono text-[12px]" title={dateTime(med.deadline)}>
              <span className={left === 'expired' ? 'text-coral' : 'text-fog'}>{left === 'expired' ? 'time is up' : `in ${left}`}</span>
              <span className="ml-2 text-mute">{dateTime(med.deadline)}</span>
            </dd>
          </div>
        )}
        {a && (
          <div className="flex justify-between gap-3">
            <dt className="text-mute">Fair range</dt>
            <dd className="num font-mono text-fog">
              {usd(a.fair_range[0])} to {usd(a.fair_range[1])}
            </dd>
          </div>
        )}
      </dl>

      {toAnswer.length > 0 && (
        <button type="button" onClick={() => go(toAnswer[0].id)} className="mt-3 w-full rounded-lg border border-lime/40 bg-lime/10 px-3 py-2 text-left text-[13px] font-semibold text-lime hover:bg-lime/15">
          {toAnswer.length} proposal{toAnswer.length === 1 ? '' : 's'} waiting for your answer
        </button>
      )}

      {med.proposals.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3">
          {med.proposals.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => go(p.id)} className="group flex w-full items-baseline justify-between gap-2 rounded-md px-1 py-1 text-left text-[12.5px] hover:bg-ink-2">
                <span className="min-w-0 text-soft group-hover:text-fog">
                  <span className="font-mono text-mute">R{p.round}</span> {brief(p)}
                </span>
                <span className="num shrink-0 font-mono text-fog">{usd(p.terms.release_now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
