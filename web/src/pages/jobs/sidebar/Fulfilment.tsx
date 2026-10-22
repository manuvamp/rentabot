import { motion } from 'motion/react'
import type { Job } from '../../../api/types'
import { cents, usd } from '../../../lib/format'

export function FulfilmentPanel({ job }: { job: Job }) {
  if (!job.fulfilment.length) return null
  return (
    <section aria-labelledby="fulfil-h" className="panel p-4">
      <h2 id="fulfil-h" className="mb-3 font-display text-lg font-extrabold tracking-tight">
        Fulfilment
      </h2>
      <div className="space-y-4">
        {job.fulfilment.map((f) => {
          const d = job.contract?.spec.deliverables.find((x) => x.id === f.deliverable_id)
          const line = job.contract?.quote.lines.find((l) => l.deliverable_id === f.deliverable_id)
          const exp = Math.max(f.expected_units, 1)
          const rest = Math.max(f.expected_units - f.passed_units - f.pending_units - f.failed_units, 0)
          const w = (n: number) => `${(n / exp) * 100}%`
          const max = line ? cents(line.max_total) : 0
          const segs = [
            { k: 'verified', n: f.passed_units, c: 'bg-lime' },
            { k: 'pending', n: f.pending_units, c: 'bg-amber' },
            { k: 'failed', n: f.failed_units, c: 'bg-coral' },
            { k: 'not delivered', n: rest, c: 'bg-ink-3' },
          ]
          return (
            <div key={f.deliverable_id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-[13px] text-soft">
                  <span className="mr-1.5 font-mono text-[11px] text-lime">{f.deliverable_id}</span>
                  {d?.description ?? 'Deliverable'}
                </p>
                <p className="num shrink-0 font-mono text-[13px] text-fog">
                  {f.passed_units}/{f.expected_units}
                </p>
              </div>
              <div className="flex h-3 gap-[2px] overflow-hidden rounded bg-ink-3 p-[2px]" role="img" aria-label={`${f.passed_units} of ${f.expected_units} units verified, ${f.failed_units} failed, ${f.pending_units} pending`}>
                {segs.map((s) => (
                  <motion.div key={s.k} className={`${s.c} rounded-[2px]`} initial={false} animate={{ width: w(s.n) }} transition={{ type: 'spring', stiffness: 200, damping: 26 }} />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 font-mono text-[11px] text-mute">
                <span>
                  {f.failed_units > 0 && <span className="text-coral">{f.failed_units} failed </span>}
                  {f.pending_units > 0 && <span className="text-amber">{f.pending_units} pending </span>}
                  {!f.failed_units && !f.pending_units && f.passed_units === f.expected_units && <span className="text-lime">all verified</span>}
                </span>
                <span>
                  earned <span className="text-fog">{usd(f.earned)}</span>
                  {max > 0 && <> of {usd(max / 100)}</>}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
