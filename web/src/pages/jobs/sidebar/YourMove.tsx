import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight, Check, ExternalLink, Gavel } from 'lucide-react'
import { callOpRaw } from '../../../api/client'
import { useMetaOps, type OpMeta } from '../../../api/meta'
import type { Job, Message, NextAction, Role } from '../../../api/types'
import { ReviewForm } from './ReviewForm'
import { SchemaForm } from '../../../components/schema/SchemaForm'
import { Button, ErrorBox, Spinner } from '../../../components/ui'
import { useAction } from '../../../api/hooks'
import { Link } from 'react-router'
import { prettyText } from '../../../lib/format'
import { humanOpText, humanOpTitle, humanWhy, technicalLabel, TECHNICAL_FIELDS } from '../../../lib/humanOps'

/** Ops that only read: clicking scrolls to the part of the room that already shows the data. */
const SCROLL_TO: Record<string, string> = { get_escrow: 'escrow-ledger', get_ruling: 'ruling-summary' }

/** respond_to_proposal has its own UI on the proposal card in the room (Accept / Reject / Counter), so the move points there instead of opening a generic form. */
const CARD_OP = 'respond_to_proposal'
const cardId = (a: NextAction) => (typeof a.args?.proposal_id === 'string' ? `proposal-${a.args.proposal_id}` : 'mediation-panel')
function focusCard(id: string) {
  const el = document.getElementById(id) ?? document.getElementById('mediation-panel')
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.setTimeout(() => el.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true }), 450)
}

function visible(a: NextAction, meta: OpMeta | undefined, role: Role): boolean {
  if (!meta) return false
  // wait_for_events is an agent's polling loop; a person is shown live updates instead.
  if (a.op === 'wait_for_events') return false
  if (meta.caller === 'user') return false
  if (meta.caller === 'arbiter' && role !== 'arbiter') return false
  return true
}

/**
 * provide_inputs takes free-form `answers` and `inputs` records. The seller's requirements already say which fields it needs and
 * which questions it asked, so the form is built from those (typed fields, required marks) instead of "add an entry" rows.
 */
function formFor(op: string, schema: OpMeta['input'], job: Job): { schema: OpMeta['input']; initial: Record<string, unknown> } {
  const req = job.contract?.requirements
  if (op !== 'provide_inputs' || !req) return { schema, initial: {} }
  const inputsSchema = (req.inputs_schema ?? {}) as OpMeta['input']
  const hasInputs = Object.keys(inputsSchema.properties ?? {}).length > 0
  const questions = req.questions ?? []
  if (!hasInputs && !questions.length) return { schema, initial: {} }
  const properties: NonNullable<OpMeta['input']['properties']> = { job_id: { type: 'string' } }
  if (questions.length) {
    properties.answers = {
      type: 'object',
      title: 'Answers to the seller',
      properties: Object.fromEntries(questions.map((q) => [q.id, { type: 'string', title: `${q.id}. ${q.text}` }])),
      required: questions.map((q) => q.id),
    }
  }
  if (hasInputs) properties.inputs = { ...inputsSchema, type: 'object', title: 'Inputs the bot needs' }
  return { schema: { type: 'object', properties, required: ['job_id'] }, initial: { answers: job.contract?.answers ?? {}, inputs: job.contract?.inputs ?? {} } }
}

export function goTo(navigate: (to: string) => void, url: string) {
  try {
    const u = new URL(url, window.location.origin)
    if (u.origin === window.location.origin) navigate(u.pathname + u.search + u.hash)
    else window.location.href = url
  } catch {
    window.location.href = url
  }
}

export function ApproveButton({ url, label = 'Approve on PayPal' }: { url: string; label?: string }) {
  const navigate = useNavigate()
  return (
    <Button size="lg" className="w-full" icon={<ExternalLink className="size-4" />} onClick={() => goTo(navigate, url)}>
      {label}
    </Button>
  )
}

/** The agent-level view of one operation, for the curious: the operation's name, the fields filled in for you, and its own description. */
function TechDetails({ op, fields, technical }: { op: string; fields: (readonly [string, unknown])[]; technical: string | null }) {
  return (
    <details className="mt-3 border-t border-line pt-2.5 text-[12px]">
      <summary className="cursor-pointer text-mute hover:text-fog">Details</summary>
      <dl className="mt-2 space-y-1.5">
        <div>
          <dt className="text-mute">Operation (what an agent calls)</dt>
          <dd className="font-mono text-soft">{op}</dd>
        </div>
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt className="text-mute">{technicalLabel(k)}</dt>
            <dd className="break-all font-mono text-soft">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
        {technical && (
          <div>
            <dt className="text-mute">Technical description</dt>
            <dd className="leading-relaxed text-soft">{technical}</dd>
          </div>
        )}
      </dl>
    </details>
  )
}

export function YourMove({ job, role, actions, approvalUrl, messages = [], onDone }: { job: Job; role: Role; actions: NextAction[]; approvalUrl: string | null; messages?: Message[]; onDone: () => void }) {
  const meta = useMetaOps()
  const [open, setOpen] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [approval, setApproval] = useState<string | null>(null)
  // A person never types a retry key: one is made per operation and kept while this room is open, so a double click stays harmless.
  const idem = useRef(new Map<string, string>())
  const idemFor = (op: string) => {
    if (!idem.current.has(op)) idem.current.set(op, `web-${op}-${job.id.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`)
    return idem.current.get(op)!
  }
  const byName = useMemo(() => new Map((meta.data ?? []).map((m) => [m.name, m])), [meta.data])
  const call = useAction(async (op: string, values: Record<string, unknown>) => {
    const res = (await callOpRaw(op, values)) as { approval_url?: string | null } | undefined
    return res
  })

  const base = actions.map((a, i) => ({ a, i, m: byName.get(a.op) })).filter((x) => visible(x.a, x.m, role))
  // The server never suggests open_dispute, but either party may open one once there is a delivery to argue about
  // (or the deadline has passed), so keep it one click away in the room.
  const lateDeadline = job.deadlines.deliver_by ? Date.parse(job.deadlines.deliver_by) < Date.now() : false
  const canDispute =
    (role === 'buyer' || role === 'seller') &&
    (job.state === 'DELIVERED' || job.state === 'CURE' || ((job.state === 'IN_PROGRESS' || job.state === 'BLOCKED') && lateDeadline)) &&
    !job.mediation &&
    !base.some((x) => x.a.op === 'open_dispute') &&
    byName.has('open_dispute')
  const list = canDispute
    ? [...base, { a: { op: 'open_dispute', why: 'Disagree with the result? Freeze the escrow and bring in the mediator.', args: { job_id: job.id } } as NextAction, i: actions.length, m: byName.get('open_dispute') }]
    : base
  const url = approval ?? approvalUrl
  const ordered = [...list].sort((x, y) => Number(SCROLL_TO[x.a.op] !== undefined) - Number(SCROLL_TO[y.a.op] !== undefined))
  const primary = (ordered.find((x) => x.a.op !== 'open_dispute') ?? ordered[0])?.i

  const run = async (op: string, values: Record<string, unknown>, title: string) => {
    const res = await call.run(op, values)
    if (res === undefined) return
    setOpen(null)
    setNote(`${title}: done.`)
    if (res && typeof res === 'object' && res.approval_url) setApproval(res.approval_url)
    onDone()
  }

  return (
    <section aria-labelledby="your-move" className="rounded-2xl border border-hl/40 bg-gradient-to-b from-hl/[0.09] to-ink-1 p-4 shadow-[0_0_0_1px_rgba(255,216,77,.06),0_18px_40px_-24px_rgba(255,216,77,.35)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="your-move" className="font-display text-xl font-extrabold tracking-tight">
          Your move
        </h2>
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-mute">role: {role}</span>
      </div>

      {url && job.state === 'AWAITING_APPROVAL' && (
        <div className="mb-3 rounded-xl border border-amber/40 bg-amber/10 p-3">
          <p className="mb-2 text-sm text-amber">The escrow is waiting for a PayPal approval. Nothing is taken until the work is proven.</p>
          {job.policy.class === 'restricted' && !job.policy.reasons.some((r) => /scope proof/i.test(r)) && (
            <p className="mb-2 text-sm text-amber">
              The policy review marked this job restricted{job.policy.reasons.length ? `: ${job.policy.reasons.join('; ')}` : ''}. A spending mandate never pays a restricted job, so the buyer's owner approves it on PayPal.
            </p>
          )}
          <ApproveButton url={url} />
        </div>
      )}
      {url && job.state !== 'AWAITING_APPROVAL' && approval && (
        <div className="mb-3">
          <ApproveButton url={approval} />
        </div>
      )}
      {note && (
        <p role="status" className="mb-3 flex items-center gap-1.5 text-sm text-hl">
          <Check className="size-4" aria-hidden /> {note}
        </p>
      )}

      {meta.loading && !meta.data && <Spinner label="Loading operations" />}
      <ErrorBox error={meta.error} title="Could not load operations" onRetry={meta.reload} />

      {!meta.loading && list.every((x) => SCROLL_TO[x.a.op] !== undefined) && !url && (
        <p className="mb-3 text-sm text-soft">
          {['SETTLED', 'CANCELLED', 'EXPIRED'].includes(job.state)
            ? 'This job is closed. Nothing left to do.'
            : job.state === 'APPEALED'
              ? 'A human arbiter is reviewing the ruling. Escrow stays frozen until they decide.'
              : 'Waiting on the other side. It will show up here the moment something needs you.'}
        </p>
      )}

      <ul className="space-y-2">
        {ordered.map(({ a, i, m }) => {
          const isOpen = open === i
          const scroll = a.op === CARD_OP ? cardId(a) : SCROLL_TO[a.op]
          const danger = m?.annotations.destructiveHint
          // job_id, retry keys and contract hashes are plumbing, not something a person should type: they are submitted as prefilled
          // and listed under Details.
          const hide = TECHNICAL_FIELDS.filter((k) => m?.input.properties?.[k] && (a.args?.[k] !== undefined || k === 'job_id' || k === 'idempotency_key'))
          const form = m ? formFor(a.op, m.input, job) : null
          const prefill: Record<string, unknown> = { ...(form?.initial ?? {}), job_id: job.id, ...(hide.includes('idempotency_key') ? { idempotency_key: idemFor(a.op) } : {}), ...a.args }
          const human = m ? humanOpText(a.op, m.description) : { text: null, technical: null }
          const heading = humanOpTitle(m?.title ?? a.op.replace(/_/g, ' '))
          return (
            <li key={`${a.op}-${i}`} className={`rounded-xl border ${isOpen ? 'border-hl/50 bg-ink-1' : 'border-line bg-ink-2/70'} transition-colors`}>
              <button
                type="button"
                aria-expanded={scroll ? undefined : isOpen}
                onClick={() => {
                  if (a.op === CARD_OP) return focusCard(scroll)
                  if (scroll) {
                    document.getElementById(scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    return
                  }
                  setNote(null)
                  call.clearError()
                  setOpen(isOpen ? null : i)
                }}
                className="group flex w-full items-start justify-between gap-3 rounded-xl px-3.5 py-3 text-left"
              >
                <span className="min-w-0">
                  <span className={`flex items-center gap-2 text-[14.5px] font-semibold ${i === primary ? 'text-hl' : danger ? 'text-coral' : 'text-fog'}`}>
                    {heading}
                    {m?.annotations.openWorldHint && !m.annotations.readOnlyHint && (
                      <span className="rounded border border-amber/40 px-1 font-mono text-[9.5px] font-medium uppercase tracking-wider text-amber" title="This operation moves money on PayPal">
                        money
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-mute">{prettyText(humanWhy(a.why))}</span>
                </span>
                <ArrowRight className={`mt-1 size-4 shrink-0 text-mute transition ${isOpen ? 'rotate-90 text-hl' : 'group-hover:translate-x-0.5 group-hover:text-fog'}`} aria-hidden />
              </button>
              {isOpen && m && (
                <div className="border-t border-line px-3.5 pb-4 pt-3.5">
                  {human.text && <p className="mb-3 text-xs leading-relaxed text-mute">{human.text}</p>}
                  {a.op === 'review_delivery' ? (
                    <ReviewForm job={job} messages={messages} pending={call.pending} error={call.error} submitLabel={heading} onCancel={() => setOpen(null)} onSubmit={(v) => run(a.op, v, heading)} />
                  ) : (
                    <SchemaForm
                      schema={form!.schema}
                      initial={prefill}
                      hide={hide}
                      pending={call.pending}
                      error={call.error}
                      submitLabel={heading}
                      submitVariant={danger ? 'danger' : 'primary'}
                      onCancel={() => setOpen(null)}
                      onSubmit={(v) => run(a.op, v, heading)}
                    />
                  )}
                  <TechDetails op={a.op} fields={hide.filter((k) => k !== 'job_id').map((k) => [k, prefill[k]] as const)} technical={human.technical} />
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {role === 'arbiter' && job.state === 'APPEALED' && (
        <Link to="/ops" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-soft hover:text-hl">
          <Gavel className="size-3.5" aria-hidden /> Open the Ops console
        </Link>
      )}
    </section>
  )
}
