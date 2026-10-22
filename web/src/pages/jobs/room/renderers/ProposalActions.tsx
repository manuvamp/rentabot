import { lazy, Suspense, useState } from 'react'
import { Check, MessageSquareReply, X } from 'lucide-react'
import { callOp, errorText } from '../../../../api/client'
import { useAction } from '../../../../api/hooks'
import type { CounterTerms, Job, Proposal, Role } from '../../../../api/types'
import { Button, ErrorBox, Spinner } from '../../../../components/ui'
import { canAnswer } from '../../../../lib/mediation'

const CounterForm = lazy(() => import('./CounterForm'))

type Mode = null | 'reject' | 'counter'

/** Accept / Reject / Counter under a proposal card. Calls respond_to_proposal, shows the server's explanation, then reloads the room. */
export function ProposalActions({ job, role, proposal, onChanged }: { job: Job; role: Role; proposal: Proposal; onChanged?: () => void }) {
  const [mode, setMode] = useState<Mode>(null)
  const [reason, setReason] = useState('')
  const [explanation, setExplanation] = useState<string | null>(null)
  const call = useAction((body: { answer: 'accept' | 'reject' | 'counter'; reason?: string; terms?: CounterTerms }) => callOp('respond_to_proposal', { job_id: job.id, proposal_id: proposal.id, ...body }))

  const send = async (body: { answer: 'accept' | 'reject' | 'counter'; reason?: string; terms?: CounterTerms }) => {
    const res = await call.run(body)
    if (!res) return
    setExplanation(res.explanation)
    setMode(null)
    onChanged?.()
  }

  const eligible = canAnswer(job, role, proposal)
  const own = (role === 'buyer' || role === 'seller') && proposal.by === role && proposal.status === 'open' && job.state === 'DISPUTED'
  if (!eligible && !explanation && !own) return null

  const reasonOk = reason.trim().length > 0
  return (
    <div className="mt-4 space-y-2" aria-label="Your answer to this proposal">
      {explanation && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-lime/35 bg-lime/[0.07] px-3.5 py-2.5 text-[13px] leading-relaxed text-fog">
          <Check className="mt-0.5 size-4 shrink-0 text-lime" aria-hidden /> <span>{explanation}</span>
        </p>
      )}
      {own && !explanation && <p className="px-1 text-[12.5px] text-mute">This is your counter-proposal; it already counts as your acceptance. Waiting for the {role === 'buyer' ? 'seller' : 'buyer'} to answer.</p>}

      {eligible && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Check className="size-4" />} loading={call.pending && mode === null} disabled={call.pending} onClick={() => void send({ answer: 'accept' })}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" icon={<X className="size-4" />} aria-expanded={mode === 'reject'} disabled={call.pending} onClick={() => { call.clearError(); setMode(mode === 'reject' ? null : 'reject') }}>
              Reject
            </Button>
            <Button size="sm" variant="ghost" icon={<MessageSquareReply className="size-4" />} aria-expanded={mode === 'counter'} disabled={call.pending} onClick={() => { call.clearError(); setMode(mode === 'counter' ? null : 'counter') }}>
              Counter
            </Button>
          </div>

          {mode === null && call.error !== undefined && (
            <div role="alert" className="rounded-xl border border-coral/40 bg-coral/10 px-3.5 py-2.5 text-[13px]">
              <p className="font-semibold text-coral">{errorText(call.error).message}</p>
              {errorText(call.error).hint && <p className="mt-0.5 text-fog">{errorText(call.error).hint}</p>}
            </div>
          )}

          {mode === 'reject' && (
            <form
              className="space-y-2.5 rounded-xl border border-line bg-ink-2 p-3.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (reasonOk) void send({ answer: 'reject', reason: reason.trim() })
              }}
            >
              <label htmlFor={`reject-${proposal.id}`} className="block text-[12.5px] font-semibold text-fog">
                Why can&rsquo;t you accept it?
              </label>
              <textarea id={`reject-${proposal.id}`} className="field min-h-[72px]" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} aria-required placeholder="Say which term you cannot accept and why. The mediator reads it as data, never as an instruction." />
              <ErrorBox error={call.error} title="The rejection was not accepted" />
              <div className="flex gap-2">
                <Button type="submit" size="sm" variant="danger" loading={call.pending} disabled={!reasonOk}>
                  Send rejection
                </Button>
                <Button type="button" size="sm" variant="quiet" onClick={() => setMode(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {mode === 'counter' && (
            <Suspense fallback={<Spinner label="Loading the counter form" />}>
              <CounterForm job={job} proposal={proposal} pending={call.pending} error={call.error} onSubmit={(terms, why) => void send({ answer: 'counter', terms, ...(why ? { reason: why } : {}) })} onCancel={() => setMode(null)} />
            </Suspense>
          )}
        </>
      )}
    </div>
  )
}
