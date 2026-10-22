// The default report: two pages, "Money" (where the escrow dollars go, what the platform keeps) and "Quality" (do bots deliver,
// do disputes settle). Layout is Studio's 24-track grid; field ids refer to data.ts ('jobs.platform_net', 'calendar::week').
import type { AgReportState } from 'ag-studio'

export const PAGES = [
  { id: 'money', title: 'Money' },
  { id: 'quality', title: 'Quality' },
] as const

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan })
const title = (text: string, subtitle?: string) => ({ title: { enabled: true, text }, ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}) })
const sum = (id: string) => ({ id, aggregation: 'sum' as const })
const countd = (id: string) => ({ id, aggregation: 'countd' as const })
const avg = (id: string) => ({ id, aggregation: 'avg' as const })

const DISPLAY = "var(--st-display)"
const kpi = (text: string, value: { id: string; aggregation?: 'sum' | 'countd' | 'avg' }, sparklineX?: string) => ({
  type: 'value' as const,
  dataMapping: { value: [value], ...(sparklineX ? { sparklineX: [{ id: sparklineX }] } : {}) },
  format: {
    ...title(text),
    style: { typography: { fontFamily: DISPLAY, fontSize: 34, fontWeight: 'bold' as const, fontStyle: 'normal' as const }, ...(sparklineX ? { sparkline: { type: 'line' as const, areaFill: true, lineWidth: 2 } } : {}) },
  },
})
const legend = { style: { theme: { common: { legend: { enabled: true } } } } }

const money = {
  id: 'money',
  widgets: {
    'kpi-net': kpi('Platform net', sum('jobs.platform_net'), 'calendar::week'),
    'kpi-take': kpi('Take rate after fees', { id: 'takeRate' }, 'calendar::week'),
    'kpi-held': kpi('Held in escrow now', sum('jobs.held_now')),
    'kpi-agree': kpi('Disputes settled by agreement', { id: 'agreementRate' }),
    waterfall: { type: 'escrow-waterfall', dataMapping: {}, format: { crossFilter: 'highlight' } },
    'fee-variance': { type: 'fee-variance', dataMapping: {}, format: { crossFilter: 'highlight' } },
    'event-kind': {
      type: 'button-filter',
      dataMapping: { value: [{ id: 'events.kind' }] },
      format: { ...title('Escrow events', 'filter the time series'), style: { selection: { type: 'multiple' }, dimensions: { height: 28, minWidth: 64 } } },
    },
    'net-by-week': {
      type: 'column-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'calendar::week' }], valueKey: [sum('jobs.platform_net')] },
      format: title('Platform net by week', 'commission + fees − PayPal fees'),
    },
    'events-over-time': {
      type: 'line-chart',
      dataMapping: { categoryKey: [{ id: 'calendar::week' }], valueKey: [sum('events.amount')], legendKey: [{ id: 'events.kind' }] },
      format: { ...title('Escrow events over time', 'USD per week by event'), ...legend },
    },
    ledger: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'jobs.date' },
          { id: 'jobs.job_id' },
          { id: 'jobs.title' },
          { id: 'jobs.bot' },
          { id: 'jobs.state' },
          { id: 'jobs.settled_by' },
          sum('jobs.captured'),
          sum('jobs.commission'),
          sum('jobs.mediation_fees'),
          sum('jobs.paypal_fees'),
          sum('jobs.fee_variance'),
          sum('jobs.platform_net'),
        ],
      },
      sort: [{ field: { id: 'jobs.date' }, direction: 'desc' }],
      format: title('Job ledger', 'one row per job, newest first'),
    },
  },
  widgetLayout: {
    'kpi-net': at(0, 0, 6, 7),
    'kpi-take': at(6, 0, 6, 7),
    'kpi-held': at(12, 0, 6, 7),
    'kpi-agree': at(18, 0, 6, 7),
    waterfall: at(0, 7, 15, 24),
    'fee-variance': at(15, 7, 9, 24),
    'event-kind': at(0, 31, 24, 5),
    'net-by-week': at(0, 36, 12, 17),
    'events-over-time': at(12, 36, 12, 17),
    ledger: at(0, 53, 24, 22),
  },
}

const quality = {
  id: 'quality',
  widgets: {
    'kpi-checks': kpi('Check pass rate', { id: 'checkPassRate' }),
    'kpi-units': kpi('Units verified', sum('jobs.units_passed'), 'calendar::week'),
    'kpi-disputes': kpi('Disputes opened', sum('jobs.dispute_count'), 'calendar::week'),
    'kpi-arbiter': kpi('Arbiter rulings', sum('jobs.arbiter_count'), 'calendar::week'),
    funnel: {
      type: 'funnel-chart',
      dataMapping: { categoryKey: [{ id: 'funnel.stage' }], valueKey: [countd('funnel.job_id')] },
      sort: [{ field: { id: 'funnel.stage' }, direction: 'asc' }],
      format: title('Dispute funnel', 'how far each dispute got'),
    },
    scorecard: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'bots.name' },
          sum('bots.jobs'),
          sum('bots.units_expected'),
          sum('bots.units_passed'),
          { id: 'botPassRate' },
          sum('bots.disputes'),
          sum('bots.arbiter_rulings'),
          sum('bots.platform_net'),
        ],
      },
      sort: [{ field: sum('bots.platform_net'), direction: 'desc' }],
      format: title('Bot scorecard', 'what each bot delivered and what it cost in disputes'),
    },
    'check-results': {
      type: 'column-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'checks.check' }], valueKey: [sum('checks.total')], legendKey: [{ id: 'checks.status' }] },
      format: { ...title('Check results by type', 'pass, fail, pending'), ...legend },
    },
    'failed-by-bot': {
      type: 'column-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'checks.bot' }], valueKey: [sum('checks.failed')], legendKey: [{ id: 'checks.check' }] },
      format: { ...title('Failed checks by bot', 'stacked by check type'), ...legend },
    },
    outcomes: {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'disputes.outcome' }], valueKey: [countd('disputes.dispute_id')] },
      format: { ...title('How disputes ended'), style: { custom: { pieDataLabel: { enabled: true }, totalLabel: { enabled: true } } } },
    },
    'proposal-kinds': {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'proposals.kind' }], valueKey: [countd('proposals.proposal_id')], legendKey: [{ id: 'proposals.status' }] },
      format: { ...title('Mediator proposals', 'by kind and answer'), ...legend },
    },
    'time-to-close': {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'disputes.outcome' }], valueKey: [avg('disputes.minutes_to_close')] },
      format: title('Minutes to close', 'average, by outcome'),
    },
  },
  widgetLayout: {
    'kpi-checks': at(0, 0, 6, 7),
    'kpi-units': at(6, 0, 6, 7),
    'kpi-disputes': at(12, 0, 6, 7),
    'kpi-arbiter': at(18, 0, 6, 7),
    funnel: at(0, 7, 8, 22),
    scorecard: at(8, 7, 16, 22),
    'check-results': at(0, 29, 12, 18),
    'failed-by-bot': at(12, 29, 12, 18),
    outcomes: at(0, 47, 8, 16),
    'proposal-kinds': at(8, 47, 8, 16),
    'time-to-close': at(16, 47, 8, 16),
  },
}

/** Studio's saved state has no page names; PAGES above is the host's own list. */
export const initialReport = {
  selectedPageId: 'money',
  pages: [money, quality],
  panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true } },
} as unknown as AgReportState
