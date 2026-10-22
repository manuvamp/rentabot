import { ArrowDown } from 'lucide-react'
import type { Job } from '../../../api/types'
import { RulingCard } from '../../../components/court/RulingCard'

export function RulingSummary({ job, rulingSeq }: { job: Job; rulingSeq?: number }) {
  if (!job.ruling) return null
  return (
    <section id="ruling-summary" aria-labelledby="ruling-h" className="scroll-mt-24">
      <div className="mb-2 flex items-center justify-between">
        <h2 id="ruling-h" className="font-display text-lg font-extrabold tracking-tight">
          Ruling
        </h2>
        {rulingSeq !== undefined && (
          <button type="button" onClick={() => document.getElementById(`msg-${rulingSeq}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })} className="inline-flex items-center gap-1 text-xs font-semibold text-soft hover:text-hl">
            Jump to it in the room <ArrowDown className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <RulingCard ruling={job.ruling} compact />
    </section>
  )
}
