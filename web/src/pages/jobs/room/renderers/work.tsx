import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Clock, Minus, OctagonAlert, PlayCircle, TriangleAlert, X } from 'lucide-react'
import type { CheckResult, Delivery } from '../../../../api/types'
import type { ArtifactBody, DeliveryBody, EvidenceBody, ProgressBody } from '../../../../api/bodies'
import { bodyOf } from '../../../../api/bodies'
import { Button, Chip, ErrorBox, Receipt, ReceiptRow, ReceiptRule, Spinner, Stamp } from '../../../../components/ui'
import { callOpRaw } from '../../../../api/client'
import { useAction } from '../../../../api/hooks'
import { ArtifactThumbs, asArr, Bubble, Label, type RenderCtx } from './common'

export function ProgressView({ message }: RenderCtx) {
  const b = bodyOf<ProgressBody>(message)
  const pct = Math.max(0, Math.min(100, Number(b.percent ?? 0)))
  return (
    <Bubble tone="lime">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="inline-flex items-center gap-1.5 font-semibold text-lime">
          <PlayCircle className="size-4" aria-hidden /> Progress
        </span>
        <span className="num font-mono text-fog">
          {b.units_done !== undefined && b.units_total !== undefined ? `${b.units_done} / ${b.units_total} units · ` : ''}
          {pct}%
        </span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-ink-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Seller progress">
        <motion.div className="h-full rounded-full bg-lime" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.9, ease: [0.2, 0.9, 0.2, 1] }} />
      </div>
      {message.text && <p className="mt-2 text-[13.5px] text-soft">{message.text}</p>}
    </Bubble>
  )
}

export function BlockerView({ message, messages, job, role, onChanged }: RenderCtx) {
  const unblock = message.type === 'unblock'
  const approval = !unblock && role === 'buyer' && message.from.role === 'seller' && message.text.startsWith('Approval needed:') && isLatestBlocker(message, messages)
  const apps = approval ? parseApprovalList(message.text) : []
  return (
    <Bubble tone={unblock ? 'lime' : 'amber'}>
      <p className={`mb-1 inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider ${unblock ? 'text-lime' : 'text-amber'}`}>
        <OctagonAlert className="size-4" aria-hidden /> {unblock ? 'Unblocked' : 'Blocked: deadline paused'}
      </p>
      <p className={approval ? 'whitespace-pre-line break-words' : undefined}>{message.text}</p>
      {apps.length > 0 && <ApprovalCard key={message.id} job={job} apps={apps} onChanged={onChanged} />}
    </Bubble>
  )
}

function isLatestBlocker(message: RenderCtx['message'], messages: RenderCtx['messages']) {
  return !messages.some((m) => m.type === 'blocker' && m.seq > message.seq)
}

/** One `- <id>: <Program name> (...)` line per filled application; ids are lowercase kebab-case. */
export function parseApprovalList(text: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*:\s*(.+?)\s*$/.exec(line)
    if (!m || out.some((a) => a.id === m[1])) continue
    out.push({ id: m[1], name: m[2].replace(/\s*\(.*$/, '').replace(/\s+preview:.*$/, '') || m[1] })
  }
  return out
}

/** The buyer's go-ahead for Application Filler: nothing is submitted until it is sent. */
function ApprovalCard({ job, apps, onChanged }: { job: RenderCtx['job']; apps: { id: string; name: string }[]; onChanged?: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(apps.map((a) => a.id)))
  const [done, setDone] = useState<string | null>(null)
  const [which, setWhich] = useState<'some' | 'none'>('some')
  const call = useAction(async (approved: string) => {
    await callOpRaw('provide_inputs', { job_id: job.id, inputs: { approved_applications: approved } })
    return true
  })
  if (!done && job.state !== 'BLOCKED') return null
  const ids = apps.map((a) => a.id).filter((id) => picked.has(id))
  const send = async (kind: 'some' | 'none') => {
    setWhich(kind)
    const res = await call.run(kind === 'none' ? 'none' : ids.join(','))
    if (!res) return
    setDone(kind === 'none' ? 'Sent. No application will be submitted.' : `Approved ${ids.length} application${ids.length === 1 ? '' : 's'}. The bot submits ${ids.length === 1 ? 'it' : 'them'} now.`)
    onChanged?.()
  }
  if (done)
    return (
      <p role="status" className="mt-3 flex items-start gap-2 rounded-xl border border-lime/35 bg-lime/[0.07] px-3.5 py-2.5 text-[13px] leading-relaxed text-fog">
        <Check className="mt-0.5 size-4 shrink-0 text-lime" aria-hidden /> <span>{done}</span>
      </p>
    )
  return (
    <div className="mt-3 space-y-2.5 rounded-xl border border-line bg-ink-2 p-3.5" aria-label="Approve applications before submit">
      <Label>Your approval</Label>
      <ul className="space-y-1.5">
        {apps.map((a) => (
          <li key={a.id}>
            <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-fog">
              <input
                type="checkbox"
                className="size-3.5 accent-[#ffd84d]"
                checked={picked.has(a.id)}
                disabled={call.pending}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(a.id)
                    else next.delete(a.id)
                    return next
                  })
                }
              />
              <span>{a.name}</span>
              <span className="font-mono text-[11px] text-mute">{a.id}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-[12.5px] text-mute">Nothing is submitted until you approve.</p>
      <ErrorBox error={call.error} title="The approval was not sent" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Check className="size-4" />} loading={call.pending && which === 'some'} disabled={call.pending || ids.length === 0} onClick={() => void send('some')}>
          Approve and submit {ids.length}
        </Button>
        <Button size="sm" variant="ghost" icon={<X className="size-4" />} loading={call.pending && which === 'none'} disabled={call.pending} onClick={() => void send('none')}>
          Submit none
        </Button>
        {call.pending && <Spinner label="Sending your approval" />}
      </div>
    </div>
  )
}

export function ArtifactView({ message, ctx }: { message: RenderCtx['message']; ctx: RenderCtx }) {
  const b = bodyOf<ArtifactBody & EvidenceBody>(message)
  return (
    <Bubble>
      <p className="mb-0.5 font-mono text-[11px] uppercase tracking-widest text-mute">{message.type === 'evidence' ? 'Evidence' : 'Artifact'}</p>
      {(b.title || message.text) && <p>{b.title ?? message.text}</p>}
      {b.title && message.text && <p className="text-soft">{message.text}</p>}
      <ArtifactThumbs ids={message.artifact_ids} job={ctx.job} />
      {b.checks && b.checks.length > 0 && <div className="mt-3"><CheckGrid checks={b.checks} /></div>}
    </Bubble>
  )
}

/* ------------------------------------------------------------ delivery */
const HIDDEN_INSTRUCTION = /(<!--[\s\S]*?-->|[^.!?\n]*\b(?:mediator|arbiter|jury|release all|ignore (?:all|previous))\b[^.!?\n]*[.!?]?)/gi

export function hasAimedText(note: string): boolean {
  HIDDEN_INSTRUCTION.lastIndex = 0
  return HIDDEN_INSTRUCTION.test(note)
}

/** Seller text, shown verbatim as quoted data. Instruction-like text is highlighted, never obeyed. */
export function QuotedNote({ note, label = "Seller's delivery note" }: { note: string; label?: string }) {
  const aimed = hasAimedText(note)
  const parts = note.split(new RegExp(HIDDEN_INSTRUCTION.source, 'i'))
  return (
    <div className={`rounded-xl border border-dashed bg-ink p-3 ${aimed ? 'border-coral/70' : 'border-line'}`}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <Label>{label} · data, not instructions</Label>
        {aimed && (
          <Chip tone="coral">
            <TriangleAlert className="size-3" aria-hidden /> Contains text aimed at the mediator
          </Chip>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-soft">
        {parts.map((p, i) =>
          i % 2 === 1 ? (
            <mark key={i} className="rounded bg-coral/25 px-0.5 text-coral decoration-coral underline decoration-wavy underline-offset-4">
              {p}
            </mark>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </p>
    </div>
  )
}

function groupByUnit(checks: CheckResult[]) {
  const cols: string[] = []
  const rows = new Map<string, Map<string, CheckResult>>()
  for (const c of checks) {
    if (!cols.includes(c.check)) cols.push(c.check)
    const key = c.unit_ref ?? '(deliverable)'
    if (!rows.has(key)) rows.set(key, new Map())
    rows.get(key)!.set(c.check, c)
  }
  const list = [...rows.entries()].map(([unit, m]) => ({ unit, m, ok: cols.every((c) => !m.has(c) || m.get(c)!.status === 'pass') && m.size > 0, pending: [...m.values()].some((x) => x.status === 'pending') }))
  return { cols, list }
}

export function unitTally(checks: CheckResult[]) {
  const { list } = groupByUnit(checks)
  return { total: list.length, passed: list.filter((r) => r.ok).length }
}

const CELL = {
  pass: { icon: Check, cls: 'text-lime bg-lime/10', label: 'pass' },
  fail: { icon: X, cls: 'text-coral bg-coral/10', label: 'fail' },
  error: { icon: Minus, cls: 'text-amber bg-amber/10', label: 'not run' },
  pending: { icon: Clock, cls: 'text-mute bg-ink-3', label: 'pending' },
} as const

export function CheckGrid({ checks, startOpen = false }: { checks: CheckResult[]; startOpen?: boolean }) {
  const { cols, list } = useMemo(() => groupByUnit(checks), [checks])
  const [failedOnly, setFailedOnly] = useState(false)
  const [open, setOpen] = useState(startOpen || list.length <= 8)
  const shown = list.filter((r) => !failedOnly || !r.ok)
  const rows = open ? shown : shown.slice(0, 5)
  const failed = list.filter((r) => !r.ok).length
  if (!list.length) return null
  return (
    <div className="rounded-xl border border-line bg-ink-1">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-mute">
          Check results · {list.length} units x {cols.length} checks
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-soft">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} className="size-3.5 accent-[#ffd84d]" />
          Failed only ({failed})
        </label>
      </div>
      <div className={`overflow-auto ${open ? 'max-h-[26rem]' : ''}`}>
        <table className="w-full min-w-[340px] border-separate border-spacing-0 text-[12px]">
          <caption className="visually-hidden">Acceptance check results per delivered unit</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 z-10 border-b border-line bg-ink-1 px-3 py-1.5 text-left font-mono text-[10.5px] font-medium uppercase tracking-wider text-mute">
                Unit
              </th>
              {cols.map((c) => (
                <th key={c} scope="col" className="sticky top-0 z-10 border-b border-line bg-ink-1 px-2 py-1.5 text-center font-mono text-[10.5px] font-medium tracking-tight text-mute" title={c}>
                  {c.replace(/^listing_/, '').replace(/_/g, ' ')}
                </th>
              ))}
              <th scope="col" className="sticky top-0 z-10 border-b border-line bg-ink-1 px-2 py-1.5 text-center font-mono text-[10.5px] font-medium uppercase text-mute">
                Paid
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.unit} className={r.ok ? '' : 'bg-coral/[0.05]'}>
                <th scope="row" className="max-w-[10rem] truncate border-b border-line/50 px-3 py-1 text-left font-mono text-[11.5px] font-normal text-soft" title={r.unit}>
                  {r.unit}
                </th>
                {cols.map((c) => {
                  const res = r.m.get(c)
                  if (!res)
                    return (
                      <td key={c} className="border-b border-line/50 px-2 py-1 text-center text-mute">
                        <span aria-label="not applicable">·</span>
                      </td>
                    )
                  const cell = CELL[res.status]
                  const Icon = cell.icon
                  return (
                    <td key={c} className="border-b border-line/50 px-2 py-1 text-center" title={`${res.check}: ${res.detail}`}>
                      <span className={`inline-grid size-5 place-items-center rounded ${cell.cls}`}>
                        <Icon className="size-3" aria-hidden />
                        <span className="visually-hidden">{cell.label}: {res.detail}</span>
                      </span>
                    </td>
                  )
                })}
                <td className="border-b border-line/50 px-2 py-1 text-center font-mono text-[11px]">{r.ok ? <span className="text-lime">yes</span> : r.pending ? <span className="text-mute">wait</span> : <span className="text-coral">no</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length + 2} className="px-3 py-4 text-center text-mute">
                  Nothing failed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {shown.length > 5 && list.length > 8 && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-center gap-1.5 border-t border-line py-2 text-[12px] font-medium text-soft hover:text-hl">
          {open ? (
            <>
              <ChevronUp className="size-3.5" /> Show fewer
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" /> Show all {shown.length} units
            </>
          )}
        </button>
      )}
    </div>
  )
}

export function DeliveryView({ message, ctx }: { message: RenderCtx['message']; ctx: RenderCtx }) {
  const b = bodyOf<DeliveryBody>(message)
  const delivery = b.delivery as Delivery | undefined
  const checks = asArr<CheckResult>(b.checks)
  const tally = unitTally(checks)
  const delivered = asArr<Delivery['deliverables'][number]>(delivery?.deliverables)
  const totalUnits = delivered.reduce((a, d) => a + asArr(d.units).length, 0) || tally.total
  const note = delivery?.note ?? ''
  const allPass = checks.length > 0 && tally.passed === tally.total
  // what the contract asked for, so a short delivery reads "16 of 20", not a bare 16/16
  const contracted = (id: string) => ctx.job.contract?.spec.deliverables.find((x) => x.id === id)?.quantity
  const ordered = delivered.reduce((a, d) => a + (contracted(d.deliverable_id) ?? asArr(d.units).length), 0)
  return (
    <div>
      <div className="relative">
        <Receipt title="Delivery" className="my-3">
          <ReceiptRule />
          {delivered.map((d) => (
            <ReceiptRow key={d.deliverable_id} label={<span><strong>{d.deliverable_id}</strong> units delivered</span>} value={(contracted(d.deliverable_id) ?? 0) > asArr(d.units).length ? `${asArr(d.units).length} of ${contracted(d.deliverable_id)}` : asArr(d.units).length} />
          ))}
          {delivered.length === 0 && <p>{message.text || 'Delivery submitted.'}</p>}
          {checks.length > 0 && (
            <>
              <ReceiptRule />
              <ReceiptRow label="Verified by checks" value={`${tally.passed} / ${tally.total}`} strong tone={allPass ? 'lime' : 'amber'} />
              <ReceiptRow label="Failed or not run" value={tally.total - tally.passed} tone={tally.total - tally.passed ? 'coral' : 'mute'} />
            </>
          )}
          {delivered.some((d) => d.note) && <p className="mt-2 font-sans text-[12px] text-pmute">{delivered.map((d) => d.note).filter(Boolean).join(' ')}</p>}
        </Receipt>
        {checks.length > 0 && (
          <div className="pointer-events-none absolute right-3 top-6 sm:right-5">
            <Stamp kind="verified" rotate={-8} size="sm" delay={0.2}>
              Verified {tally.passed}/{Math.max(tally.total, ordered)}
            </Stamp>
          </div>
        )}
      </div>
      {checks.length > 0 && <CheckGrid checks={checks} />}
      {note && (
        <div className="mt-3">
          <QuotedNote note={note} />
        </div>
      )}
      {totalUnits > 0 && checks.length === 0 && <p className="mt-2 flex items-center gap-1.5 text-[12px] text-mute"><AlertTriangle className="size-3.5" aria-hidden /> Checks have not reported yet.</p>}
      <ArtifactThumbs ids={message.artifact_ids} job={ctx.job} />
    </div>
  )
}
