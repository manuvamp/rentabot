import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { bodyOf, type DeliveryBody } from '../../../api/bodies'
import type { Job, Message } from '../../../api/types'
import { Button, ErrorBox } from '../../../components/ui'

interface Row {
  deliverable_id: string
  unit_refs: string[]
  reason: string
}

/**
 * Buyer's review of a delivery: accept, or reject named units with a reason each (the seller then gets one cure window).
 * Builds the review_delivery payload from the latest delivery's check results instead of asking for raw JSON.
 */
export function ReviewForm({ job, messages, pending, error, submitLabel, onSubmit, onCancel }: { job: Job; messages: Message[]; pending?: boolean; error?: unknown; submitLabel: string; onSubmit: (v: Record<string, unknown>) => void | Promise<void>; onCancel: () => void }) {
  const deliverables = job.contract?.spec.deliverables ?? []
  // Units from the latest delivery, failing ones first so the obvious candidates are on top.
  const units = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.type === 'delivery')
    const checks = last ? (bodyOf<DeliveryBody>(last).checks ?? []) : []
    const byDel = new Map<string, Map<string, boolean>>()
    for (const c of checks) {
      if (!c.unit_ref) continue
      const m = byDel.get(c.deliverable_id) ?? new Map<string, boolean>()
      m.set(c.unit_ref, (m.get(c.unit_ref) ?? true) && c.status === 'pass')
      byDel.set(c.deliverable_id, m)
    }
    return new Map([...byDel].map(([d, m]) => [d, [...m].map(([ref, ok]) => ({ ref, ok })).sort((a, b) => Number(a.ok) - Number(b.ok))]))
  }, [messages])

  const [decision, setDecision] = useState<'accept' | 'reject'>('accept')
  const [rows, setRows] = useState<Row[]>([{ deliverable_id: deliverables[0]?.id ?? 'D1', unit_refs: [], reason: '' }])
  const [problem, setProblem] = useState<string | null>(null)
  const patch = (i: number, p: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (decision === 'accept') return void onSubmit({ job_id: job.id, decision })
    const bad = rows.findIndex((r) => r.reason.trim().length < 5)
    if (bad >= 0) return setProblem(`Say what is wrong in item ${bad + 1} (at least 5 characters).`)
    setProblem(null)
    void onSubmit({ job_id: job.id, decision, rejections: rows.map((r) => ({ deliverable_id: r.deliverable_id, unit_refs: r.unit_refs, reason: r.reason.trim() })) })
  }

  return (
    <form onSubmit={submit} className="space-y-3.5" noValidate>
      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold text-fog">Decision</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['accept', 'reject'] as const).map((d) => (
            <label key={d} className={`cursor-pointer rounded-xl border px-3 py-2.5 text-sm transition-colors ${decision === d ? (d === 'accept' ? 'border-lime bg-lime/10 text-lime' : 'border-coral bg-coral/10 text-coral') : 'border-line text-soft hover:text-fog'}`}>
              <input type="radio" name="decision" value={d} checked={decision === d} onChange={() => setDecision(d)} className="sr-only" />
              <span className="block font-semibold capitalize">{d === 'accept' ? 'Accept' : 'Reject items'}</span>
              <span className="block text-[12px] opacity-80">{d === 'accept' ? 'Pay for what passed, void the rest' : 'Seller gets one cure window'}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {decision === 'reject' && (
        <div className="space-y-3">
          {rows.map((r, i) => {
            const list = units.get(r.deliverable_id) ?? []
            return (
              <div key={i} className="space-y-2 rounded-xl border border-line bg-ink p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-widest text-mute">Item {i + 1}</span>
                  {rows.length > 1 && (
                    <button type="button" aria-label={`Remove item ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))} className="text-mute hover:text-coral">
                      <X className="size-4" />
                    </button>
                  )}
                </div>
                {deliverables.length > 1 && (
                  <select aria-label="Deliverable" className="field" value={r.deliverable_id} onChange={(e) => patch(i, { deliverable_id: e.target.value, unit_refs: [] })}>
                    {deliverables.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.id}
                      </option>
                    ))}
                  </select>
                )}
                {list.length > 0 && (
                  <div>
                    <p className="mb-1 text-[12px] text-mute">Units to reject (none selected = the whole deliverable)</p>
                    <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                      {list.map((u) => {
                        const on = r.unit_refs.includes(u.ref)
                        return (
                          <button
                            key={u.ref}
                            type="button"
                            aria-pressed={on}
                            onClick={() => patch(i, { unit_refs: on ? r.unit_refs.filter((x) => x !== u.ref) : [...r.unit_refs, u.ref] })}
                            className={`rounded-md border px-2 py-0.5 font-mono text-[11.5px] transition-colors ${on ? 'border-coral bg-coral/15 text-coral' : u.ok ? 'border-line text-soft hover:text-fog' : 'border-amber/50 text-amber'}`}
                          >
                            {u.ref}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <label className="block">
                  <span className="mb-1 block text-[12px] text-mute">What is wrong? Be specific, vague rejections count against you.</span>
                  <textarea className="field min-h-[4.5rem]" value={r.reason} onChange={(e) => patch(i, { reason: e.target.value })} placeholder="e.g. The listing page does not show the ORANO tagline." />
                </label>
              </div>
            )
          })}
          <button type="button" onClick={() => setRows((x) => [...x, { deliverable_id: deliverables[0]?.id ?? 'D1', unit_refs: [], reason: '' }])} className="inline-flex items-center gap-1 text-[13px] font-semibold text-soft hover:text-hl">
            <Plus className="size-3.5" aria-hidden /> Add another item
          </button>
        </div>
      )}

      {problem && (
        <p role="alert" className="text-xs font-medium text-coral">
          {problem}
        </p>
      )}
      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" variant={decision === 'reject' ? 'danger' : 'primary'} loading={pending}>
          {decision === 'accept' ? submitLabel : 'Send rejection'}
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
