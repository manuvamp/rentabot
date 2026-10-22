import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { CounterTerms } from '@rentabot/shared'
import type { CounterTerms as CounterTermsT, Job, Proposal, Redo } from '../../../../api/types'
import { Button, ErrorBox } from '../../../../components/ui'
import { cents, toAmount, usd } from '../../../../lib/format'
import { splitList, toAmountString, toLocalInput, uncapturedCents } from '../../../../lib/mediation'

// Loaded lazily (React.lazy in ProposalActions) so the zod schemas stay out of the main bundle until someone counters.

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-semibold text-fog">
        {label}
      </label>
      {children}
      {help && <p className="mt-1 text-[11.5px] leading-snug text-mute">{help}</p>}
    </div>
  )
}

interface Draft {
  /** Only the fields the user changed. */
  terms: CounterTermsT
  errors: string[]
  /** What the server will fill in, in plain words. */
  derived: string[]
  sum: { release: number; refund: number; held: number; ok: boolean }
}

export default function CounterForm({ job, proposal, pending, error, onSubmit, onCancel }: { job: Job; proposal: Proposal; pending: boolean; error: unknown; onSubmit: (terms: CounterTermsT, reason: string) => void; onCancel: () => void }) {
  const t = proposal.terms
  const U = uncapturedCents(job)
  const [release, setRelease] = useState(t.release_now)
  const [refund, setRefund] = useState(t.refund_now)
  const [dropRedo, setDropRedo] = useState(false)
  const [rDeadline, setRDeadline] = useState(toLocalInput(t.redo?.deadline))
  const [rAmount, setRAmount] = useState(t.redo?.amount_on_success ?? '')
  const [rUnits, setRUnits] = useState(t.redo?.units.join('\n') ?? '')
  const [rInstr, setRInstr] = useState(t.redo?.instruction ?? '')
  const [wait, setWait] = useState(toLocalInput(t.wait_until))
  const [cancel, setCancel] = useState(t.cancel)
  const [note, setNote] = useState(t.note)
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)

  const draft = useMemo<Draft>(() => {
    const errors: string[] = []
    const derived: string[] = []
    const terms: CounterTermsT = {}
    const amount = (label: string, v: string) => {
      const a = toAmountString(v)
      if (a === null) errors.push(`${label}: enter an amount like 12.50.`)
      return a
    }
    const relA = amount('Release now', release)
    const refA = amount('Refund now', refund)
    const hasRedo = Boolean(t.redo) && !dropRedo && !cancel
    const waiting = !hasRedo && !cancel && Boolean(wait)

    if (cancel !== t.cancel) terms.cancel = cancel
    if (!cancel) {
      if (relA !== null && relA !== t.release_now) terms.release_now = relA
      if (refA !== null && refA !== t.refund_now) terms.refund_now = refA
    }
    if (t.redo && dropRedo && !cancel) terms.redo = null
    let redoAmt = 0
    if (t.redo && hasRedo) {
      const r: Partial<Redo> = {}
      if (rDeadline !== toLocalInput(t.redo.deadline)) {
        const d = new Date(rDeadline)
        if (!rDeadline || Number.isNaN(d.getTime())) errors.push('Redo deadline: pick a date and time.')
        else r.deadline = d.toISOString()
      }
      const a = amount('Amount held for the redo', rAmount)
      redoAmt = cents(a ?? t.redo.amount_on_success)
      if (a !== null && a !== t.redo.amount_on_success) r.amount_on_success = a
      const units = splitList(rUnits)
      if (!units.length) errors.push('Redo units: name at least one unit.')
      else if (units.join('\n') !== t.redo.units.join('\n')) r.units = units
      if (rInstr.trim() !== t.redo.instruction) r.instruction = rInstr.trim()
      if (Object.keys(r).length) terms.redo = r
    }
    if (!hasRedo && !cancel && wait !== toLocalInput(t.wait_until)) {
      const d = new Date(wait)
      if (wait && Number.isNaN(d.getTime())) errors.push('Hold until: pick a date and time.')
      else terms.wait_until = wait ? d.toISOString() : null
    }
    if (note.trim() !== t.note) terms.note = note.trim()

    // the money rule: release + refund + held = what is still uncaptured. Amounts you leave untouched are derived by the server.
    let rel = cents(relA ?? t.release_now)
    let ref = cents(refA ?? t.refund_now)
    let held = redoAmt
    const sentRel = terms.release_now !== undefined
    const sentRef = terms.refund_now !== undefined
    if (cancel) {
      rel = 0
      ref = U
      held = 0
      derived.push(`Cancel returns the whole uncaptured ${usd(U / 100)} to the buyer.`)
    } else if (sentRel && sentRef) {
      if (waiting) held = U - rel - ref
      if (rel + ref + held !== U) errors.push(`Release ${usd(rel / 100)} + refund ${usd(ref / 100)} + held ${usd(held / 100)} is ${usd((rel + ref + held) / 100)}, but ${usd(U / 100)} is uncaptured. Change one amount back and the server fills it in.`)
    } else if (sentRel) {
      ref = waiting ? 0 : U - rel - held
      if (waiting) held = U - rel - ref
      derived.push(`Refund now will be filled in as ${usd(Math.max(ref, 0) / 100)}.`)
    } else if (sentRef) {
      rel = waiting ? 0 : U - ref - held
      if (waiting) held = U - rel - ref
      derived.push(`Release now will be filled in as ${usd(Math.max(rel, 0) / 100)}.`)
    } else {
      ref = waiting ? 0 : U - rel - held
      if (waiting) held = U - rel - ref
      if (ref !== cents(t.refund_now) && !waiting) derived.push(`Release stays ${usd(rel / 100)}; refund now will be filled in as ${usd(Math.max(ref, 0) / 100)}.`)
    }
    if (!cancel && (rel < 0 || ref < 0 || held < 0)) errors.push(`These amounts do not fit in the ${usd(U / 100)} that is still uncaptured.`)
    if (waiting) derived.push('Whatever is left stays held until that time, then the checks settle it.')

    const parsed = CounterTerms.safeParse(terms)
    if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${i.path.join('.') || 'terms'}: ${i.message}`)
    return { terms: parsed.success ? parsed.data : terms, errors: [...new Set(errors)], derived, sum: { release: rel, refund: ref, held, ok: rel + ref + held === U } }
  }, [release, refund, dropRedo, rDeadline, rAmount, rUnits, rInstr, wait, cancel, note, t, U])

  const nothing = Object.keys(draft.terms).length === 0
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (nothing || draft.errors.length) return
    onSubmit(draft.terms, reason.trim())
  }

  const hasRedo = Boolean(t.redo) && !dropRedo && !cancel
  const showWait = !hasRedo && !cancel
  const id = `counter-${proposal.id}`
  return (
    <form onSubmit={submit} noValidate className="space-y-3.5 rounded-xl border border-line bg-ink-2 p-3.5" aria-label="Counter-proposal">
      <p className="text-[12.5px] leading-snug text-soft">
        Change only what you disagree with; everything else is copied from this proposal and amounts you leave alone are filled in so they add up. The result becomes a proposal the other side can accept directly.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-rel`} label="Release now (to the seller)">
          <input id={`${id}-rel`} className="field font-mono" inputMode="decimal" value={release} disabled={cancel} onChange={(e) => setRelease(e.target.value)} />
        </Field>
        <Field id={`${id}-ref`} label="Refund now (void, to the buyer)">
          <input id={`${id}-ref`} className="field font-mono" inputMode="decimal" value={refund} disabled={cancel} onChange={(e) => setRefund(e.target.value)} />
        </Field>
      </div>

      {t.redo && !cancel && (
        <fieldset className="rounded-xl border border-line p-3">
          <legend className="px-1.5 text-[13px] font-semibold text-fog">Redo</legend>
          <label className="mb-2 flex cursor-pointer items-center gap-2 text-[13px] text-fog">
            <input type="checkbox" className="size-4 accent-[var(--color-hl)]" checked={dropRedo} onChange={(e) => setDropRedo(e.target.checked)} />
            Drop the redo (no further work; the held amount goes to release or refund)
          </label>
          {hasRedo && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={`${id}-dl`} label="Deadline" help="At most 14 days from now.">
                  <input id={`${id}-dl`} type="datetime-local" className="field" value={rDeadline} onChange={(e) => setRDeadline(e.target.value)} />
                </Field>
                <Field id={`${id}-amt`} label="Held until the checks pass" help="Captured automatically if the acceptance checks pass on the redo units, voided otherwise.">
                  <input id={`${id}-amt`} className="field font-mono" inputMode="decimal" value={rAmount} onChange={(e) => setRAmount(e.target.value)} />
                </Field>
              </div>
              <Field id={`${id}-units`} label="Units" help="Comma or one per line.">
                <textarea id={`${id}-units`} className="field min-h-[72px] font-mono text-[13px]" rows={3} value={rUnits} onChange={(e) => setRUnits(e.target.value)} />
              </Field>
              <Field id={`${id}-instr`} label="Instruction">
                <textarea id={`${id}-instr`} className="field min-h-[56px]" rows={2} maxLength={600} value={rInstr} onChange={(e) => setRInstr(e.target.value)} />
              </Field>
            </div>
          )}
        </fieldset>
      )}

      {showWait && (
        <Field id={`${id}-wait`} label="Hold the rest until (optional)" help="Leave empty to settle now. Otherwise the remainder stays held until then and the checks decide. At most 14 days from now.">
          <input id={`${id}-wait`} type="datetime-local" className="field max-w-xs" value={wait} onChange={(e) => setWait(e.target.value)} />
        </Field>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fog">
        <input type="checkbox" className="size-4 accent-[var(--color-hl)]" checked={cancel} onChange={(e) => setCancel(e.target.checked)} />
        Cancel the job: everything uncaptured goes back to the buyer
      </label>

      <Field id={`${id}-note`} label="Note on the terms (optional)">
        <textarea id={`${id}-note`} className="field min-h-[56px]" rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field id={`${id}-reason`} label="Why (optional)" help="The mediator reads this as data, never as an instruction.">
        <textarea id={`${id}-reason`} className="field min-h-[56px]" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>

      <div className={`rounded-lg border px-3 py-2 font-mono text-[12.5px] ${draft.sum.ok ? 'border-lime/40 bg-lime/10 text-lime' : 'border-coral/40 bg-coral/10 text-coral'}`} role="status" aria-label="Money rule">
        release {usd(draft.sum.release / 100)} + refund {usd(draft.sum.refund / 100)} + held {usd(draft.sum.held / 100)} = {usd((draft.sum.release + draft.sum.refund + draft.sum.held) / 100)} <span className="text-soft">of {usd(U / 100)} uncaptured</span>
      </div>
      {draft.derived.length > 0 && (
        <ul className="space-y-0.5 text-[12.5px] text-soft">
          {draft.derived.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {(tried || draft.errors.length > 0) && draft.errors.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-[12.5px] font-medium text-coral">
          {draft.errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {tried && nothing && (
        <p role="alert" className="text-[12.5px] font-medium text-coral">
          Change at least one term to counter.
        </p>
      )}
      <ErrorBox error={error} title="The counter was not accepted" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={pending}>
          Send counter
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <span className="font-mono text-[11px] text-mute">
          {Object.keys(draft.terms).length} change{Object.keys(draft.terms).length === 1 ? '' : 's'} · uncaptured ${toAmount(U)}
        </span>
      </div>
    </form>
  )
}
