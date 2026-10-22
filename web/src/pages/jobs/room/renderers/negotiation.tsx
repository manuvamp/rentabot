import { Circle, CircleCheck, KeyRound, MessageCircleQuestion } from 'lucide-react'
import type { Quote, Requirements, JobSpec } from '../../../../api/types'
import type { AnswerBody, QuoteBody, RequirementsBody, JobSpecBody } from '../../../../api/bodies'
import { bodyOf } from '../../../../api/bodies'
import { PrintLine, Receipt, ReceiptRow, ReceiptRule } from '../../../../components/ui'
import { dateTime, duration, prettyText, usd } from '../../../../lib/format'
import { ArtifactThumbs, asArr, asStr, Bubble, isRec, JsonView, KV, Label, paramsText, type RenderCtx } from './common'

export function JobSpecView({ message }: RenderCtx) {
  const spec = bodyOf<JobSpecBody>(message).spec as JobSpec | undefined
  if (!spec) return <Bubble>{message.text || 'Job spec sent.'}</Bubble>
  return (
    <Receipt title="Job spec" className="my-3">
      <p className="text-center text-[0.7rem] text-pmute">{spec.skill_id}</p>
      <ReceiptRule />
      <p className="font-sans text-[13.5px] leading-snug">{spec.goal}</p>
      <ReceiptRule />
      {asArr<JobSpec['deliverables'][number]>(spec.deliverables).map((d, i) => (
        <PrintLine key={d.id} delay={0.1 * i} className="mb-3">
          <ReceiptRow label={<strong>{d.id}</strong>} value={<strong>x {d.quantity}</strong>} />
          <p className="font-sans text-[12.5px] leading-snug">{d.description}</p>
          <ul className="mt-1 space-y-0.5 text-[11.5px]">
            {asArr<{ check: string; params?: unknown }>(d.acceptance).map((a, j) => (
              <li key={j} className="flex gap-1.5">
                <CircleCheck className="mt-0.5 size-3 shrink-0 text-lime-deep" aria-hidden />
                <span className="min-w-0 break-words">
                  <strong>{a.check}</strong> <span className="text-pmute">{paramsText(a.params)}</span>
                </span>
              </li>
            ))}
          </ul>
          {d.rubric && <p className="mt-1 font-sans text-[11.5px] italic text-pmute">Rubric: {d.rubric}</p>}
        </PrintLine>
      ))}
      <ReceiptRule />
      <ReceiptRow label="Deadline" value={dateTime(spec.deadline)} />
      <ReceiptRow label="Budget cap" value={usd(spec.budget_cap)} strong />
      {asArr<string>(spec.out_of_scope).length > 0 && (
        <p className="mt-2 text-[11.5px]">
          <span className="font-bold uppercase tracking-widest text-pmute">Out of scope </span>
          {asArr<string>(spec.out_of_scope).join(' · ')}
        </p>
      )}
    </Receipt>
  )
}

export function RequirementsView({ message }: RenderCtx) {
  const req = bodyOf<RequirementsBody>(message).requirements as Requirements | undefined
  if (!req) return <Bubble>{message.text || 'Requirements sent.'}</Bubble>
  const props = isRec(req.inputs_schema?.properties) ? (req.inputs_schema.properties as Record<string, Record<string, unknown>>) : {}
  const required = new Set(asArr<string>(req.inputs_schema?.required))
  return (
    <div className="my-1 rounded-2xl border border-line bg-ink-2 p-4">
      {message.text && <p className="mb-3 text-[14px] text-fog">{message.text}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label>Inputs needed</Label>
          <ul className="space-y-1.5 text-[13px]">
            {Object.entries(props).map(([k, v]) => (
              <li key={k} className="flex items-start gap-2">
                {required.has(k) ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-lime" aria-hidden /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-mute" aria-hidden />}
                <span>
                  <span className="font-mono text-fog">{k}</span> <span className="text-mute">{asStr(v.type)}{asStr(v.format) ? ` (${asStr(v.format)})` : ''}</span>
                  {!required.has(k) && <span className="text-mute"> optional</span>}
                </span>
              </li>
            ))}
            {Object.keys(props).length === 0 && <li className="text-mute">None.</li>}
          </ul>
        </div>
        <div>
          <Label>Access</Label>
          <ul className="space-y-2 text-[13px]">
            {asArr<Requirements['access'][number]>(req.access).map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <KeyRound className="mt-0.5 size-3.5 shrink-0 text-amber" aria-hidden />
                <span>
                  <span className="font-mono text-[11px] text-amber">{a.id}</span> {a.why} <span className="block font-mono text-[11.5px] text-mute">{a.kind} · {a.scope}</span>
                </span>
              </li>
            ))}
            {asArr(req.access).length === 0 && <li className="text-mute">No credentials needed.</li>}
          </ul>
        </div>
      </div>
      {asArr<string>(req.assumptions).length > 0 && (
        <div className="mt-4">
          <Label>Assumptions</Label>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-soft">
            {asArr<string>(req.assumptions).map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {asArr<Requirements['questions'][number]>(req.questions).length > 0 && (
        <div className="mt-4 space-y-2">
          <Label>Questions</Label>
          {asArr<Requirements['questions'][number]>(req.questions).map((q) => (
            <blockquote key={q.id} className="flex items-start gap-2 rounded-lg border-l-[3px] border-lime bg-ink px-3 py-2 text-[13.5px]">
              <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-lime" aria-hidden />
              <span>
                <span className="mr-2 font-mono text-[11px] text-lime">{q.id}</span>
                {q.text}
              </span>
            </blockquote>
          ))}
        </div>
      )}
    </div>
  )
}

export function QuoteView({ message }: RenderCtx) {
  const q = bodyOf<QuoteBody>(message).quote as Quote | undefined
  if (!q) return <Bubble>{message.text || 'Quote sent.'}</Bubble>
  return (
    <Receipt title="Quote" className="my-3">
      <ReceiptRule />
      {asArr<Quote['lines'][number]>(q.lines).map((l) => (
        <ReceiptRow
          key={l.deliverable_id}
          label={
            <span>
              <strong>{l.deliverable_id}</strong> {l.model === 'fixed' ? 'fixed' : `${l.quantity} x ${usd(l.unit_price)}`}
            </span>
          }
          value={usd(l.max_total)}
        />
      ))}
      <ReceiptRule double />
      <ReceiptRow label="Held in escrow (max)" value={usd(q.total_max)} strong />
      <p className="mt-1 text-[11px] text-pmute">Authorized on PayPal, not taken. You pay only for what the checks verify.</p>
      <ReceiptRule />
      <ReceiptRow label="Turnaround" value={duration(q.turnaround)} />
      <ReceiptRow label="Valid until" value={dateTime(q.valid_until)} />
      {asArr<string>(q.excludes).length > 0 && (
        <p className="mt-2 text-[11.5px]">
          <span className="font-bold uppercase tracking-widest text-pmute">Excludes </span>
          {asArr<string>(q.excludes).join(' · ')}
        </p>
      )}
    </Receipt>
  )
}

/** clarify, answer, inputs, note, statement, mediator_answer */
export function ChatView({ message, ctx }: { message: RenderCtx['message']; ctx: RenderCtx }) {
  const b = bodyOf<AnswerBody>(message)
  const answers = isRec(b.answers) ? (b.answers as Record<string, string>) : {}
  const inputs = isRec(b.inputs) ? (b.inputs as Record<string, unknown>) : {}
  return (
    <Bubble tone={message.type === 'statement' ? 'amber' : 'neutral'}>
      {message.text && <p className="whitespace-pre-wrap break-words">{prettyText(message.text)}</p>}
      {Object.keys(answers).length > 0 && (
        <div className="mt-2 space-y-1">
          {Object.entries(answers).map(([k, v]) => (
            <p key={k} className="text-[13px]">
              <span className="mr-2 rounded bg-lime/15 px-1.5 py-px font-mono text-[11px] text-lime">{k}</span>
              {v}
            </p>
          ))}
        </div>
      )}
      {Object.keys(inputs).length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-ink p-2.5">
          <Label>Inputs</Label>
          <KV data={inputs} />
        </div>
      )}
      <ArtifactThumbs ids={message.artifact_ids} job={ctx.job} />
      {!message.text && !Object.keys(answers).length && !Object.keys(inputs).length && message.artifact_ids.length === 0 && <JsonView value={message.body} />}
    </Bubble>
  )
}
