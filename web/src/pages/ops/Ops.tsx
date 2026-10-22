import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { BarChart3, Gavel, ShieldAlert } from 'lucide-react'
import { callOp } from '../../api/client'
import { bodyOf, type AppealBody, type DeliveryBody } from '../../api/bodies'
import { useAction, useAsync } from '../../api/hooks'
import type { Job } from '../../api/types'
import { RulingCard } from '../../components/court/RulingCard'
import { AppealsTable, type AppealRow } from '../../components/ops/AppealsTable'
import { Button, Chip, Container, EmptyState, ErrorBox, LinkButton, PageHeader, Receipt, ReceiptRow, ReceiptRule, Skeleton, Stamp, StateBadge } from '../../components/ui'
import { cents, timeAgo, toAmount, usd } from '../../lib/format'
import { flagTitle, heldCents } from '../../lib/mediation'
import { AssessmentBlock } from '../jobs/room/renderers/mediation'

const held = (j: Job) => cents(j.escrow.authorized.value) - cents(j.escrow.captured.value) - cents(j.escrow.voided.value) - cents(j.escrow.refunded.value)

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-4">
      <p className="eyebrow">{label}</p>
      <p className="num mt-1.5 font-display text-4xl font-extrabold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-mute">{sub}</p>}
    </div>
  )
}

/** What the parties tried before the ruling: the assessment, then every proposal with both answers. The arbiter reads this first. */
function Negotiation({ job }: { job: Job }) {
  const med = job.mediation
  if (!med || (!med.assessment && med.proposals.length === 0)) return null
  return (
    <section aria-label="The negotiation before the ruling" className="space-y-3">
      <p className="eyebrow">The negotiation · {med.status.replace('_', ' ')} after round {med.round}</p>
      {med.assessment && <AssessmentBlock a={med.assessment} />}
      {med.proposals.length > 0 && (
        <ul className="space-y-2">
          {med.proposals.map((p) => (
            <li key={p.id} className="panel p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-mute">R{p.round}</span>
                <Chip mono>{p.by === 'mediator' ? 'mediator' : `${p.by} counter`}</Chip>
                <Chip mono tone={p.status === 'accepted' ? 'lime' : p.status === 'rejected' ? 'coral' : 'neutral'}>{p.status}</Chip>
                {p.flags.map((f) => <Chip key={f} mono tone="amber">{flagTitle(f)}</Chip>)}
                <span className="ml-auto font-mono text-[12px] text-soft">
                  release {usd(p.terms.release_now)} · refund {usd(p.terms.refund_now)} · held {usd(heldCents(p.terms, p.preview) / 100)}
                </span>
              </div>
              {(['buyer', 'seller'] as const).map((side) => {
                const r = p.responses[side]
                return r && p.by !== side ? (
                  <p key={side} className="mt-1 text-soft">
                    <strong className="capitalize text-fog">{side}</strong> {r.answer === 'accept' ? 'accepted' : r.answer === 'reject' ? 'rejected' : 'countered'}
                    {r.reason ? `: “${r.reason}”` : ''}
                  </p>
                ) : null
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CasePanel({ jobId, onDecided }: { jobId: string; onDecided: () => void }) {
  const job = useAsync(() => callOp('get_job', { job_id: jobId }), [jobId])
  const ruling = useAsync(() => callOp('get_ruling', { job_id: jobId }), [jobId])
  const msgs = useAsync(() => callOp('get_messages', { job_id: jobId, limit: 200 }), [jobId])
  const j = job.data?.job
  const r = ruling.data?.ruling ?? j?.ruling ?? null

  const appeal = useMemo(() => msgs.data?.messages.find((m) => m.type === 'appeal'), [msgs.data])
  // The server stores the grounds as the message text ({ ruling_id, bond } is the body); older shapes carry them in body.grounds.
  const grounds = bodyOf<AppealBody>(appeal ?? ({ body: {} } as never)).grounds ?? appeal?.text
  const appellant = appeal?.from.role === 'buyer' || appeal?.from.role === 'seller' ? appeal.from.role : null
  const delivery = useMemo(() => [...(msgs.data?.messages ?? [])].reverse().find((m) => m.type === 'delivery'), [msgs.data])
  const deliveryNote = delivery ? bodyOf<DeliveryBody>(delivery).delivery?.note : undefined

  const [mode, setMode] = useState<'confirm' | 'override'>('confirm')
  const [release, setRelease] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<Job | null>(null)
  useEffect(() => {
    setMode('confirm')
    setNote('')
    setResult(null)
  }, [jobId])
  useEffect(() => {
    if (r) setRelease(r.remedy.release_to_seller.value)
  }, [r?.id])

  const decide = useAction(async () => {
    const out = await callOp('arbiter_decide', { job_id: jobId as Job['id'], decision: mode, note, ...(mode === 'override' ? { release_to_seller: release } : {}) })
    setResult(out.job)
    onDecided()
    return out
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void decide.run()
  }
  const overrideBad = mode === 'override' && (!/^\d{1,7}\.\d{2}$/.test(release) || cents(release) > cents(j?.escrow.authorized.value ?? 0))

  if (job.loading && !j) return <Skeleton className="h-96" />
  if (job.error) return <ErrorBox error={job.error} title="Could not load the case" onRetry={job.reload} />
  if (!j) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Case</p>
          <h2 className="font-display text-3xl font-bold tracking-tight">{j.title}</h2>
          <p className="mt-1 font-mono text-xs text-mute">{j.id} · contract {j.contract_hash?.slice(0, 18)}…</p>
        </div>
        <Receipt padded className="w-56 shrink-0">
          <ReceiptRow label="Authorized" value={usd(j.escrow.authorized)} />
          <ReceiptRow label="Captured" value={usd(j.escrow.captured)} tone="lime" />
          <ReceiptRow label="Still held" value={usd(held(j) / 100)} tone="amber" strong />
        </Receipt>
      </div>

      <Negotiation job={j} />

      {r ? <RulingCard ruling={r} /> : ruling.loading ? <Skeleton className="h-64" /> : <p className="text-mute">No ruling is attached to this case.</p>}

      <section className="grid gap-4 lg:grid-cols-2" aria-label="Evidence from the parties">
        <div className="panel p-4">
          <p className="eyebrow mb-2">{appellant ? `${appellant === 'buyer' ? 'Buyer' : 'Seller'}’s appeal grounds` : 'Appeal grounds'}</p>
          {grounds ? <p className="text-[14px] leading-relaxed text-soft">{grounds}</p> : <p className="text-sm text-mute">{msgs.loading ? 'Loading…' : 'No grounds recorded.'}</p>}
        </div>
        <div className="panel p-4">
          <p className="eyebrow mb-2 flex items-center gap-2">Delivery note <span className="rounded border border-line px-1.5 py-px text-[10px] normal-case tracking-normal text-mute">shown as data, never as instructions</span></p>
          {deliveryNote ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-coral/30 bg-ink p-3 font-mono text-[12.5px] leading-relaxed text-soft" tabIndex={0}>{deliveryNote}</pre>
          ) : (
            <p className="text-sm text-mute">{msgs.loading ? 'Loading…' : 'No delivery note.'}</p>
          )}
          {r && r.integrity_flags.length > 0 && (
            <p className="mt-2 flex items-start gap-2 text-[13px] text-coral"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />The mediator flagged {r.integrity_flags.length} integrity issue{r.integrity_flags.length > 1 ? 's' : ''} in this case.</p>
          )}
        </div>
      </section>

      {result ? (
        <Receipt title="Decision recorded" tilt={-0.6}>
          <ReceiptRule />
          <ReceiptRow label="State" value={result.state} />
          <ReceiptRow label="Captured" value={usd(result.escrow.captured)} />
          <ReceiptRow label="Voided" value={usd(result.escrow.voided)} tone="coral" />
          <ReceiptRow label="Paid out" value={usd(result.escrow.paid_out)} tone="lime" strong />
          <ReceiptRule />
          <div className="flex justify-end"><Stamp kind="ruled" size="md">Final</Stamp></div>
        </Receipt>
      ) : (
        <form onSubmit={submit} className="panel space-y-4 p-5" aria-labelledby="decide-h">
          <h3 id="decide-h" className="flex items-center gap-2 font-display text-xl font-bold"><Gavel className="size-5 text-lime" aria-hidden />Your decision</h3>
          <div role="radiogroup" aria-label="Decision" className="grid grid-cols-2 gap-2">
            {(['confirm', 'override'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`rounded-xl border px-4 py-3 text-left transition ${mode === m ? 'border-lime bg-lime/10' : 'border-line hover:border-soft'}`}>
                <span className="block font-semibold">{m === 'confirm' ? 'Confirm the ruling' : 'Override the remedy'}</span>
                <span className="mt-0.5 block text-xs text-mute">{m === 'confirm' ? 'Execute the AI remedy as written.' : 'Set what the seller receives.'}</span>
              </button>
            ))}
          </div>
          {mode === 'override' && (
            <div className="max-w-xs">
              <label htmlFor="release" className="mb-1.5 block text-sm font-medium">Release to seller (USD)</label>
              <input id="release" className="field font-mono" inputMode="decimal" value={release} onChange={(e) => setRelease(e.target.value)} aria-invalid={overrideBad} />
              <p className="mt-1 text-xs text-mute">AI remedy: {usd(r?.remedy.release_to_seller)}. Escrow authorized: {usd(j.escrow.authorized)}.</p>
            </div>
          )}
          <div>
            <label htmlFor="note" className="mb-1.5 block text-sm font-medium">Reasoning (logged and used to improve the mediator)</label>
            <textarea id="note" className="field min-h-24" value={note} onChange={(e) => setNote(e.target.value)} placeholder="One or two sentences a party can read." />
          </div>
          <ErrorBox error={decide.error} title="Decision failed" />
          <Button type="submit" loading={decide.pending} disabled={note.trim().length < 5 || overrideBad}>{mode === 'confirm' ? 'Confirm ruling' : 'Override and execute'}</Button>
        </form>
      )}
    </div>
  )
}

/** Platform P&L from the ledger: commission and mediation fees earned minus the PayPal fees actually charged. Arbiter only. */
function PlatformLedger() {
  const q = useAsync(() => callOp('get_platform_ledger', {}), [], { pollMs: 30000 })
  const d = q.data
  const net = (v: string) => (
    <span className={Number(v) < 0 ? 'text-coral' : 'text-lime'}>{usd(v)}</span>
  )
  return (
    <section className="mt-16" aria-labelledby="ledger-h">
      <p className="eyebrow">Ops console · arbiter</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ledger-h" className="font-display text-3xl font-bold tracking-tight">Platform P&amp;L</h2>
        <LinkButton to="/ops/studio" variant="ghost" size="sm" icon={<BarChart3 className="size-4" aria-hidden />}>Open the P&amp;L studio</LinkButton>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-mute">Net = commission + mediation fees &minus; the PayPal fees actually charged on captures and payouts. It can be negative on a small job.</p>
      <ErrorBox error={q.error} title="Could not load the ledger" onRetry={q.reload} className="mt-4" />
      {q.loading && !d ? (
        <Skeleton className="mt-4 h-40" />
      ) : d ? (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <caption className="visually-hidden">Platform profit and loss, per job, in {d.currency}</caption>
            <thead>
              <tr className="border-b border-line bg-ink-2 font-mono text-[11px] uppercase tracking-widest text-mute">
                <th scope="col" className="px-4 py-2.5 font-medium">Job</th>
                <th scope="col" className="px-4 py-2.5 font-medium">State</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Captured</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Commission</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Mediation</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium" title="Capture-and-hold: PayPal's processing fee kept from refunds">Refund fee kept</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">PayPal capture</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">PayPal payout</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line bg-ink-1 font-semibold">
                <th scope="row" className="px-4 py-3 text-left">Total, {d.totals.jobs} job{d.totals.jobs === 1 ? '' : 's'}</th>
                <td />
                <td className="num px-4 py-3 text-right font-mono">{usd(d.totals.captured)}</td>
                <td className="num px-4 py-3 text-right font-mono">{usd(d.totals.commission)}</td>
                <td className="num px-4 py-3 text-right font-mono">{usd(d.totals.mediation_fees)}</td>
                <td className="num px-4 py-3 text-right font-mono">{usd(d.totals.refund_fees_kept ?? '0.00')}</td>
                <td className="num px-4 py-3 text-right font-mono">{usd(d.totals.paypal_capture_fees)}</td>
                <td className="num px-4 py-3 text-right font-mono">{usd(d.totals.paypal_payout_fees)}</td>
                <td className="num px-4 py-3 text-right font-mono">{net(d.totals.net)}</td>
              </tr>
              {d.jobs.map((j) => (
                <tr key={j.job_id} className="border-b border-line/60 last:border-0">
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <span className="block text-fog">{j.title}</span>
                    <span className="block font-mono text-[11px] text-mute">{j.job_id}</span>
                  </th>
                  <td className="px-4 py-3"><StateBadge state={j.state} /></td>
                  <td className="num px-4 py-3 text-right font-mono text-soft">{usd(j.captured)}</td>
                  <td className="num px-4 py-3 text-right font-mono text-soft">{usd(j.commission)}</td>
                  <td className="num px-4 py-3 text-right font-mono text-soft">{usd(j.mediation_fees)}</td>
                  <td className="num px-4 py-3 text-right font-mono text-soft">{usd(j.refund_fees_kept ?? '0.00')}</td>
                  <td className="num px-4 py-3 text-right font-mono text-soft">{usd(j.paypal_capture_fees)}</td>
                  <td className="num px-4 py-3 text-right font-mono text-soft">{usd(j.paypal_payout_fees)}</td>
                  <td className="num px-4 py-3 text-right font-mono">{net(j.net)}</td>
                </tr>
              ))}
              {d.jobs.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-6 text-center text-mute">Nothing captured yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

export default function Ops() {
  const q = useAsync(() => callOp('list_jobs', { state: 'APPEALED', limit: 100 }), [], { pollMs: 15000 })
  const jobs = q.data?.jobs ?? []
  // enrich rows with each job's details (title is in the summary; flags and appeal time need the job)
  const details = useAsync(
    async () => {
      const out: Record<string, { flags: number; held: string; appealed: string | null; bot: string }> = {}
      for (const s of jobs) {
        const [{ job }, bot] = await Promise.all([callOp('get_job', { job_id: s.id }), callOp('get_bot', { bot_id: s.seller_bot_id }).catch(() => null)])
        out[s.id] = { flags: job.ruling?.integrity_flags.length ?? 0, held: toAmount(held(job)), appealed: job.updated_at, bot: bot?.bot.name ?? s.seller_bot_id }
      }
      return out
    },
    [jobs.map((j) => j.id + j.updated_at).join(',')],
    { enabled: jobs.length > 0 },
  )
  const rows: AppealRow[] = jobs.map((s) => ({ id: s.id, title: s.title, bot: details.data?.[s.id]?.bot ?? '…', held: details.data?.[s.id]?.held ?? s.held.value, state: s.state, appealedAt: details.data?.[s.id]?.appealed ?? s.updated_at, flags: details.data?.[s.id]?.flags ?? 0 }))
  const [sel, setSel] = useState<string | undefined>()
  const [pinned, setPinned] = useState<string | undefined>()
  const selected = sel && rows.some((r) => r.id === sel) ? sel : rows[0]?.id
  const shown = pinned ?? selected

  const totalHeld = rows.reduce((a, r) => a + cents(r.held), 0)
  const avgAgeMs = rows.length ? rows.reduce((a, r) => a + (Date.now() - new Date(r.appealedAt ?? Date.now()).getTime()), 0) / rows.length : 0
  const avgAge = rows.length ? timeAgo(new Date(Date.now() - avgAgeMs).toISOString()).replace(' ago', '') : '–'

  return (
    <Container className="py-12 sm:py-16" wide>
      <PageHeader eyebrow="Ops console · arbiter" title="Appeals">
        The AI jury rules first. Either side can appeal to you. Read the ruling, the evidence and the delivery note, then confirm or override. The decision is final and executes on PayPal.
      </PageHeader>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatTile label="Open appeals" value={String(rows.length)} sub="waiting for a human" />
        <StatTile label="Held in escrow" value={usd(totalHeld / 100)} sub="on appealed jobs" />
        <StatTile label="Average age" value={avgAge} sub="since the appeal" />
      </div>

      <ErrorBox error={q.error} title="Could not load the queue" onRetry={q.reload} className="mb-6" />
      {q.loading && !q.data ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 && !pinned ? (
        <EmptyState title="Queue is empty">No appeals are waiting. Rulings that nobody appeals become final when the appeal window ends.</EmptyState>
      ) : (
        <div className="grid gap-8 xl:grid-cols-[minmax(0,680px)_minmax(0,1fr)]">
          <div className="xl:sticky xl:top-24 xl:self-start">
            <AppealsTable rows={rows} selectedId={shown} onSelect={(id) => { setPinned(undefined); setSel(id) }} />
          </div>
          <div className="min-w-0">{shown && <CasePanel key={shown} jobId={shown} onDecided={() => { setPinned(shown); q.reload() }} />}</div>
        </div>
      )}

      <PlatformLedger />
    </Container>
  )
}
