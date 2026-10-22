import { Link } from 'react-router'
import { Check, Clock, PenLine } from 'lucide-react'
import { TERMINAL_STATES } from '@rentabot/shared'
import type { Job } from '../../../api/types'
import { Chip, CopyButton, HashText } from '../../../components/ui'
import { countdown, dateTime, duration, timeAgo, usd } from '../../../lib/format'
import { useNow } from './useNow'

const DEADLINES: [keyof Job['deadlines'], string][] = [
  ['fund_by', 'Fund by'],
  ['deliver_by', 'Deliver by'],
  ['review_until', 'Review until'],
  ['cure_until', 'Cure until'],
  ['appeal_until', 'Appeal until'],
  ['verify_until', 'Checks re-run until'],
]

export function ContractPanel({ job, botName }: { job: Job; botName: string }) {
  const now = useNow()
  const c = job.contract
  const hash = job.contract_hash
  const signed = (role: 'buyer' | 'seller') => job.accepted_by.find((a) => a.role === role)
  const frozen = signed('buyer') && signed('seller') && signed('buyer')?.contract_hash === hash && signed('seller')?.contract_hash === hash
  const deadlines = DEADLINES.filter(([k]) => job.deadlines[k])

  return (
    <section aria-labelledby="contract-h" className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="contract-h" className="font-display text-lg font-extrabold tracking-tight">
          Contract
        </h2>
        <Chip tone={frozen ? 'lime' : job.state === 'NEGOTIATING' ? 'amber' : 'neutral'} mono>
          {frozen ? 'frozen' : job.state === 'NEGOTIATING' ? 'draft' : 'amended'}
          {c ? ` v${c.version}` : ''}
        </Chip>
      </div>

      {c ? (
        <>
          <dl className="space-y-1.5 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-mute">Seller bot</dt>
              <dd className="text-right">
                <Link to={`/bots/${job.seller_bot_id}`} className="text-fog underline decoration-line underline-offset-2 hover:text-hl">
                  {botName}
                </Link>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mute">Up to</dt>
              <dd className="num font-mono text-fog">{usd(c.quote.total_max)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mute">Platform fee</dt>
              <dd className="num font-mono text-fog">{(c.fees.platform_bps / 100).toFixed(0)}% of captured, at least {usd(c.fees.floor)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mute">Smallest settlement</dt>
              <dd className="num font-mono text-fog">{usd(c.fees.min_settlement)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mute">Mediation fee</dt>
              <dd className="num font-mono text-fog">{usd(c.fees.mediation_flat)} flat</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-mute">Turnaround</dt>
              <dd className="text-fog">{duration(c.quote.turnaround)}</dd>
            </div>
          </dl>

          <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
            {c.spec.deliverables.map((d) => {
              const line = c.quote.lines.find((l) => l.deliverable_id === d.id)
              return (
                <li key={d.id} className="flex gap-2 text-[13px] leading-snug">
                  <span className="font-mono text-[11px] text-lime">{d.id}</span>
                  <span className="min-w-0 flex-1 text-soft">
                    <span className="line-clamp-3" title={d.description}>
                      {d.description}
                    </span>
                    {line && (
                      <span className="mt-0.5 block font-mono text-[11.5px] text-mute">
                        {line.model === 'per_unit' ? `${d.quantity} x $${line.unit_price}` : `fixed $${line.unit_price}`} · {d.acceptance.map((a) => a.check).join(', ')}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>

          {(c.amendments ?? []).length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="eyebrow mb-1.5">Amendments agreed in mediation</p>
              <ul className="space-y-1.5">
                {c.amendments.map((am) => (
                  <li key={am.proposal_id} className="text-[13px] leading-snug">
                    <span className="flex flex-wrap items-center gap-2">
                      <Chip tone="amber" mono>
                        {am.kind}
                      </Chip>
                      {am.deliverable_id && <span className="font-mono text-[11px] text-lime">{am.deliverable_id}</span>}
                      <span className="text-soft">
                        {am.kind === 'wait' ? 'no new units' : `${am.units.length} unit${am.units.length === 1 ? '' : 's'}`}, {am.kind === 'wait' ? 'settles' : 'due'} {dateTime(am.deadline)}
                      </span>
                    </span>
                    <span className="mt-0.5 block font-mono text-[11.5px] text-mute">
                      {usd(am.amount_on_success)} held until the checks pass{am.instruction ? ` · ${am.instruction}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-mute">No contract yet.</p>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Contract hash</span>
          {hash && <CopyButton text={hash} label="Copy" />}
        </div>
        <p className="mt-1 break-all font-mono text-[12px] leading-snug text-soft">
          <HashText hash={hash} n={20} />
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3" aria-label="Signatures">
        {(['buyer', 'seller'] as const).map((r) => {
          const s = signed(r)
          const stale = s && s.contract_hash !== hash
          return (
            <span key={r} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] ${s && !stale ? 'border-lime/40 bg-lime/10 text-lime' : 'border-line text-mute'}`} title={s ? dateTime(s.ts) : undefined}>
              {s && !stale ? <Check className="size-3.5" aria-hidden /> : <PenLine className="size-3.5" aria-hidden />}
              <span className="font-semibold capitalize">{r}</span>
              <span className="font-mono text-[11px]">{s ? (stale ? 'signed an older version' : timeAgo(s.ts)) : job.state !== 'NEGOTIATING' && ((c as { amendments?: unknown[] } | undefined)?.amendments?.length ?? 0) > 0 ? 'agreed in mediation' : 'not signed'}</span>
            </span>
          )
        })}
      </div>

      {c && (
        <details className="mt-3 border-t border-line pt-3 text-[13px]">
          <summary className="cursor-pointer text-soft hover:text-fog">Timers in the contract</summary>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            {Object.entries(c.timers).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-mute">{k.replace(/_/g, ' ')}</dt>
                <dd className="text-right font-mono text-soft">{duration(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {deadlines.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3">
          {deadlines.map(([k, label]) => {
            const iso = job.deadlines[k]
            const left = countdown(iso, now)
            return (
              <li key={k} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="flex items-center gap-1.5 text-mute">
                  <Clock className="size-3.5" aria-hidden /> {label}
                </span>
                <span className="text-right font-mono text-[12px]">
                  <span className={left === 'expired' && !TERMINAL_STATES.includes(job.state) ? 'text-coral' : left === 'expired' ? 'text-mute' : 'text-fog'}>{left}</span>
                  <span className="ml-2 text-mute">{dateTime(iso)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
