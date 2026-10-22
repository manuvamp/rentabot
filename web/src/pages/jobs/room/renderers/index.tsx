import type { ReactNode } from 'react'
import { ArtifactView, BlockerView, DeliveryView, ProgressView } from './work'
import { AcceptView, AppealView, ArbiterDecisionView, DeclineView, DisputeView, MediatorAnswerView, MediatorQuestionView, ReviewView, RulingView, SystemLine } from './court'
import { ChatView, JobSpecView, QuoteView, RequirementsView } from './negotiation'
import { Bubble, JsonView, type RenderCtx } from './common'
import { AssessmentNote, ProposalResponseView, ProposalView, SettlementView } from './mediation'

export type { RenderCtx }

export const TYPE_LABEL: Record<string, string> = {
  proposal: 'settlement offer',
  proposal_response: 'response',
  settlement: 'settlement',
  job_spec: 'job spec',
  requirements: 'requirements',
  quote: 'quote',
  counter: 'counter',
  clarify: 'question',
  answer: 'answer',
  inputs: 'inputs',
  accept: 'accept',
  decline: 'decline',
  progress: 'progress',
  blocker: 'blocker',
  unblock: 'unblock',
  artifact: 'artifact',
  evidence: 'evidence',
  delivery: 'delivery',
  review: 'review',
  dispute: 'dispute',
  statement: 'statement',
  mediator_question: 'mediator question',
  mediator_answer: 'mediator answer',
  ruling: 'ruling',
  appeal: 'appeal',
  arbiter_decision: 'arbiter decision',
  system: 'system',
  note: 'note',
}

/** Message types worth showing in the "Money and verdicts only" view. */
export const KEY_TYPES = new Set<string>(['system', 'ruling', 'arbiter_decision', 'appeal', 'dispute', 'review', 'delivery', 'accept', 'proposal', 'proposal_response', 'settlement'])

/** Render the body of one message. Never throws: unknown shapes fall back to JSON. */
export function renderBody(ctx: RenderCtx): ReactNode {
  const p = { ...ctx, ctx }
  const t = ctx.message.type as string
  if (t === 'proposal') return <ProposalView {...p} />
  if (t === 'proposal_response') return <ProposalResponseView {...p} />
  if (t === 'settlement') return <SettlementView {...p} />
  if (t === 'note' && (ctx.message.body as { assessment?: unknown })?.assessment) return <AssessmentNote {...p} />
  switch (ctx.message.type) {
    case 'job_spec':
    case 'counter':
      return ctx.message.body && (ctx.message.body as { spec?: unknown }).spec ? <JobSpecView {...p} /> : <ChatView message={ctx.message} ctx={ctx} />
    case 'requirements':
      return <RequirementsView {...p} />
    case 'quote':
      return <QuoteView {...p} />
    case 'clarify':
    case 'answer':
    case 'inputs':
    case 'note':
    case 'statement':
      return <ChatView message={ctx.message} ctx={ctx} />
    case 'accept':
      return <AcceptView {...p} />
    case 'decline':
      return <DeclineView {...p} />
    case 'progress':
      return <ProgressView {...p} />
    case 'blocker':
    case 'unblock':
      return <BlockerView {...p} />
    case 'artifact':
    case 'evidence':
      return <ArtifactView message={ctx.message} ctx={ctx} />
    case 'delivery':
      return <DeliveryView message={ctx.message} ctx={ctx} />
    case 'review':
      return <ReviewView {...p} />
    case 'dispute':
      return <DisputeView {...p} />
    case 'mediator_question':
      return <MediatorQuestionView message={ctx.message} ctx={ctx} />
    case 'mediator_answer':
      return <MediatorAnswerView message={ctx.message} ctx={ctx} />
    case 'ruling':
      return <RulingView {...p} />
    case 'appeal':
      return <AppealView {...p} />
    case 'arbiter_decision':
      return <ArbiterDecisionView {...p} />
    case 'system':
      return <SystemLine message={ctx.message} />
    default:
      return (
        <Bubble>
          {ctx.message.text && <p className="mb-2">{ctx.message.text}</p>}
          <JsonView value={ctx.message.body} />
        </Bubble>
      )
  }
}

export { SystemLine }
