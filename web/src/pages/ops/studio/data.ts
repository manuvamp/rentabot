// The dashboard's data model for AG Studio: seven tables from get_platform_analytics, how they relate (one star around
// jobs), a shared calendar, and the measures (ratios) the widgets and the agent use. Built once per load of the data.
import type { AgDataSourcesDefinition, AgExpressionFieldDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from 'ag-studio'
import type { OpOutput } from '../../../api/types'

export type AnalyticsTables = OpOutput<'get_platform_analytics'>['tables']
export type Analytics = OpOutput<'get_platform_analytics'>
export type Row = Record<string, string | number | boolean | null>

const CALENDAR_ID = 'calendar'
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

// [id, name, format, hidden?]
type Spec = [id: string, name: string, format: AgFormat, hide?: boolean]
const fields = (specs: Spec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({
    id,
    name,
    format,
    ...(format === 'currencyFormat' ? { formatOptions: { format: usd } } : {}),
    ...(hide ? { hide } : {}),
  }))

const manyToOne = (id: string, source: string, target: string): AgRelationDefinition => {
  const [sourceTable, sourceField] = source.split('.') as [string, string]
  const [targetTable, targetField] = target.split('.') as [string, string]
  return { id, source: { tableId: sourceTable, fieldId: sourceField }, target: { tableId: targetTable, fieldId: targetField }, type: 'many-to-one' }
}
const onCalendar = (tableId: string, fieldId: string, truncate?: 'day'): AgRelationDefinition => ({
  id: `${tableId}-${fieldId}-calendar`,
  source: { tableId, fieldId },
  target: { calendarId: CALENDAR_ID },
  ...(truncate ? { truncate } : {}),
})
const sumOf = (id: string) => ({ id, aggregation: 'sum' as const })
const ratio = (id: string, name: string, description: string, numerator: string, denominator: string): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: 'percentageFormat',
  isMeasure: true,
  expression: { operator: 'divide', inputs: [sumOf(numerator), sumOf(denominator)] },
})

const DESCRIPTION =
  'Rent-A-Bot is a marketplace where AI agents hire specialist bots. Money sits in PayPal escrow: it is authorized first, then only what the checks prove is captured; the rest is voided (never charged). ' +
  'The platform earns a commission on the seller gross (15%, never below $3.00 per job, no capture under the $5.00 minimum), plus mediation fees, plus the PayPal fee kept from refunds in capture-and-hold mode, and it pays PayPal capture and payout fees. ' +
  'Platform net = commission + mediation fees + refund fees kept − PayPal capture fee − PayPal payout fee. All money is USD. ' +
  'Rows with Simulated = true are simulated history for the demo; the rest are real jobs on this server. Dates are UTC.'

export function buildStudioData(t: AnalyticsTables): AgDataSourcesDefinition {
  const dates = [...t.jobs.map((r) => r.date), ...t.events.map((r) => r.date)].filter((d): d is string => typeof d === 'string').sort()
  const today = new Date().toISOString().slice(0, 10)
  const from = dates[0] ?? today
  const to = [dates.at(-1) ?? today, today].sort().at(-1)!

  return {
    description: DESCRIPTION,
    sources: [
      {
        id: 'jobs',
        description:
          'One row per funded job: the escrow waterfall (authorized, voided, refunded, held, captured), what the platform earned (commission, mediation fees, refund fees kept), the PayPal fees actually charged vs. estimated, ' +
          'the seller payout and the platform net. Date is the day the job settled (or was created, if still open). below_minimum_void: the passing units earned under $5.00, so nothing was captured and the money was voided. ' +
          'settled_by: agreement (both parties accepted a mediator proposal), arbiter (a human decided after an appeal), ruling (the AI jury ruled, no appeal), checks (no dispute), none (not settled).',
        data: t.jobs,
        fields: fields([
          ['job_id', 'Job', 'textFormat'],
          ['title', 'Title', 'textFormat'],
          ['bot_id', 'Bot ID', 'textFormat', true],
          ['bot', 'Bot', 'textFormat'],
          ['buyer', 'Buyer agent', 'textFormat'],
          ['skill', 'Skill', 'textFormat'],
          ['state', 'State', 'textFormat'],
          ['simulated', 'Simulated', 'booleanFormat'],
          ['date', 'Date', 'dateFormat'],
          ['created_on', 'Created', 'dateFormat'],
          ['authorized', 'Authorized', 'currencyFormat'],
          ['captured', 'Captured', 'currencyFormat'],
          ['voided', 'Voided', 'currencyFormat'],
          ['refunded', 'Refunded', 'currencyFormat'],
          ['held_now', 'Held now', 'currencyFormat'],
          ['commission', 'Commission', 'currencyFormat'],
          ['mediation_fees', 'Mediation fees', 'currencyFormat'],
          ['refund_fees_kept', 'Refund fees kept', 'currencyFormat'],
          ['paypal_capture_fee', 'PayPal capture fee', 'currencyFormat'],
          ['paypal_payout_fee', 'PayPal payout fee', 'currencyFormat'],
          ['paypal_fees', 'PayPal fees', 'currencyFormat'],
          ['paypal_fees_est', 'PayPal fees (estimated)', 'currencyFormat'],
          ['fee_variance', 'Fee variance', 'currencyFormat'],
          ['seller_payout', 'Seller payout', 'currencyFormat'],
          ['platform_net', 'Platform net', 'currencyFormat'],
          ['loss_making', 'Loss-making', 'booleanFormat'],
          ['disputed', 'Disputed', 'booleanFormat'],
          ['dispute_count', 'Disputes', 'integerFormat'],
          ['agreement_count', 'Settled by agreement', 'integerFormat'],
          ['arbiter_count', 'Settled by arbiter', 'integerFormat'],
          ['below_minimum_void', 'Voided below $5 minimum', 'booleanFormat'],
          ['earned_not_captured', 'Earned but not captured', 'currencyFormat'],
          ['settled_by', 'Settled by', 'textFormat'],
          ['units_expected', 'Units expected', 'integerFormat'],
          ['units_passed', 'Units verified', 'integerFormat'],
        ]),
      },
      {
        id: 'events',
        name: 'Escrow events',
        description: 'The escrow event stream: authorized, captured, voided, refunded, paid out, dispute opened and resolved, with the amount in USD.',
        data: t.events,
        fields: fields([
          ['event_id', 'Event ID', 'textFormat', true],
          ['job_id', 'Job ID', 'textFormat', true],
          ['bot', 'Bot', 'textFormat'],
          ['ts', 'Event time', 'dateTimeFormat'],
          ['date', 'Event date', 'dateFormat', true],
          ['kind', 'Event', 'textFormat'],
          ['amount', 'Amount', 'currencyFormat'],
          ['simulated', 'Simulated', 'booleanFormat'],
        ]),
      },
      {
        id: 'disputes',
        description: 'One row per dispute: rounds of mediation, proposals made, outcome (agreement, arbiter, ruling, open), minutes to close.',
        data: t.disputes,
        fields: fields([
          ['dispute_id', 'Dispute ID', 'textFormat', true],
          ['job_id', 'Job ID', 'textFormat', true],
          ['bot', 'Bot', 'textFormat'],
          ['opened_at', 'Opened', 'dateTimeFormat'],
          ['date', 'Opened date', 'dateFormat', true],
          ['opened_by', 'Opened by', 'textFormat'],
          ['rounds', 'Rounds', 'integerFormat'],
          ['proposals', 'Proposals', 'integerFormat'],
          ['outcome', 'Outcome', 'textFormat'],
          ['minutes_to_close', 'Minutes to close', 'integerFormat'],
          ['integrity_flags', 'Integrity flags', 'integerFormat'],
          ['simulated', 'Simulated', 'booleanFormat'],
        ]),
      },
      {
        id: 'proposals',
        description: 'One row per mediation proposal: round, kind (split, redo, substitute, wait, cancel), who proposed it, whether it was accepted, the release amount, and the dispute outcome.',
        data: t.proposals,
        fields: fields([
          ['proposal_id', 'Proposal ID', 'textFormat', true],
          ['job_id', 'Job ID', 'textFormat', true],
          ['round', 'Round', 'integerFormat'],
          ['kind', 'Proposal kind', 'textFormat'],
          ['by', 'Proposed by', 'textFormat'],
          ['status', 'Proposal status', 'textFormat'],
          ['release_now', 'Release now', 'currencyFormat'],
          ['outcome', 'Dispute outcome', 'textFormat'],
          ['simulated', 'Simulated', 'booleanFormat'],
        ]),
      },
      {
        id: 'funnel',
        name: 'Dispute funnel',
        description: 'The stages each dispute reached: opened, mediator proposed, countered or re-proposed, agreed, ruling. Count rows per stage for a funnel.',
        data: t.funnel,
        fields: fields([
          ['funnel_id', 'Funnel ID', 'textFormat', true],
          ['job_id', 'Job ID', 'textFormat', true],
          ['stage_no', 'Stage number', 'integerFormat', true],
          ['stage', 'Stage', 'textFormat'],
          ['simulated', 'Simulated', 'booleanFormat'],
        ]),
      },
      {
        id: 'bots',
        description: 'One row per listed bot: jobs, units verified out of units expected (its pass rate), disputes, arbiter rulings, captured and platform net.',
        data: t.bots,
        fields: fields([
          ['bot_id', 'Bot ID', 'textFormat', true],
          ['name', 'Bot', 'textFormat'],
          ['capability_class', 'Capability', 'textFormat'],
          ['jobs', 'Jobs', 'integerFormat'],
          ['settled', 'Settled', 'integerFormat'],
          ['units_expected', 'Units expected', 'integerFormat'],
          ['units_passed', 'Units verified', 'integerFormat'],
          ['disputes', 'Disputes', 'integerFormat'],
          ['arbiter_rulings', 'Arbiter rulings', 'integerFormat'],
          ['captured', 'Captured', 'currencyFormat'],
          ['platform_net', 'Platform net', 'currencyFormat'],
        ]),
      },
      {
        id: 'checks',
        name: 'Check results',
        description:
          'Acceptance check results per unit (latest attempt): check type (url_live, page_mentions, artifact_attached, email_delivered, ...), status, and passed / failed / total counters to sum. ' +
          'For simulated jobs these are a sample of up to three units per check.',
        data: t.checks,
        fields: fields([
          ['check_id', 'Check ID', 'textFormat', true],
          ['job_id', 'Job ID', 'textFormat', true],
          ['bot_id', 'Bot ID', 'textFormat', true],
          ['bot', 'Bot', 'textFormat'],
          ['check', 'Check', 'textFormat'],
          ['status', 'Check status', 'textFormat'],
          ['date', 'Check date', 'dateFormat', true],
          ['total', 'Checks', 'integerFormat'],
          ['passed', 'Passed', 'integerFormat'],
          ['failed', 'Failed', 'integerFormat'],
          ['simulated', 'Simulated', 'booleanFormat'],
        ]),
      },
    ],
    relationships: [
      manyToOne('event-job', 'events.job_id', 'jobs.job_id'),
      manyToOne('dispute-job', 'disputes.job_id', 'jobs.job_id'),
      manyToOne('proposal-job', 'proposals.job_id', 'jobs.job_id'),
      manyToOne('funnel-job', 'funnel.job_id', 'jobs.job_id'),
      manyToOne('check-job', 'checks.job_id', 'jobs.job_id'),
      manyToOne('job-bot', 'jobs.bot_id', 'bots.bot_id'),
      onCalendar('jobs', 'date'),
      onCalendar('events', 'ts', 'day'),
      onCalendar('disputes', 'opened_at', 'day'),
    ],
    calendars: [
      {
        id: CALENDAR_ID,
        label: 'Calendar',
        range: { from: { type: 'date', value: from }, to: { type: 'date', value: to } },
        fragments: ['year', 'quarter', 'month', 'week', 'day', 'dayOfWeek'],
      },
    ],
    expressions: [
      ratio('takeRate', 'Take rate after fees', 'Platform net / captured: what the platform keeps of every captured dollar after PayPal fees.', 'jobs.platform_net', 'jobs.captured'),
      ratio('agreementRate', 'Disputes settled by agreement', 'Disputes that ended with both parties accepting a mediator proposal, out of all disputes.', 'jobs.agreement_count', 'jobs.dispute_count'),
      ratio('feeVarianceRate', 'Fee variance rate', 'PayPal fees actually charged vs. estimated, as a share of the estimate.', 'jobs.fee_variance', 'jobs.paypal_fees_est'),
      ratio('botPassRate', 'Pass rate', 'Units verified / units expected for a bot.', 'bots.units_passed', 'bots.units_expected'),
      ratio('jobPassRate', 'Unit pass rate', 'Units verified / units expected across jobs.', 'jobs.units_passed', 'jobs.units_expected'),
      ratio('checkPassRate', 'Check pass rate', 'Passed / total acceptance checks.', 'checks.passed', 'checks.total'),
    ],
  }
}
