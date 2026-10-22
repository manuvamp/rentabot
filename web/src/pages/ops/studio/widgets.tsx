// Two custom AG Studio widgets for the platform P&L, built with createWidgets: the escrow waterfall (where every authorized
// dollar went, down to the platform's net; each step cross-filters the jobs) and the fee variance dumbbell (PayPal fee actually
// charged vs. estimated, per job). They read data through widgetApi.getData, so page filters and the other widgets'
// cross-filters apply, and they are described to the agents (ai.description + formatShape) so a user can ask for one in chat.
// They use only React and SVG: no AG Grid or AG Charts Enterprise features.
import { createWidgets } from 'ag-studio-react'
import type { AgWidgetApi, AgWidgetField, AgWidgetParams } from 'ag-studio'
import { useEffect, useMemo, useRef, useState } from 'react'

type Num = Record<string, number>
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const money = (x: number) => (x < 0 ? '−' : '') + usd.format(Math.abs(x))

// ---------------------------------------------------------------------------------------------- helpers

type StateFilter = { field?: { id: string }; model?: { operator: string; value?: unknown; conditions?: unknown[] }; filterWidgetId?: string }
/**
 * The page filters and this widget's own filters, read from Studio's state and turned into query filters. Studio applies these
 * itself when a widget is configured by the form or loaded from state, but a filter an agent tool adds to a custom widget
 * is recorded in the state without reaching the widget's queries, so the widget passes them along explicitly (a repeat of a
 * filter Studio already applied changes nothing).
 */
function stateFilters(params: AgWidgetParams, widgetApi: AgWidgetApi): unknown[] {
  try {
    const state = params.api.getState() as { selectedPageId?: string; pages?: { id: string; filter?: { page?: StateFilter[]; widget?: Record<string, StateFilter[]> } }[] }
    const page = state.pages?.find((p) => p.id === state.selectedPageId) ?? state.pages?.[0]
    const states = [...(page?.filter?.page ?? []), ...(page?.filter?.widget?.[params.widgetId] ?? [])].filter((f) => !f.filterWidgetId)
    const convert = (f: StateFilter): unknown => {
      const field = f.field ? schemaField(widgetApi, f.field.id) : undefined
      if (!field || !f.model || f.model.conditions) return null
      return { field, operator: f.model.operator, value: f.model.value }
    }
    return states.map(convert).filter(Boolean)
  } catch {
    return []
  }
}

function schemaField(api: AgWidgetApi, id: string): AgWidgetField | undefined {
  for (const t of api.getSchema()) for (const f of t.fields) if (String(f.fieldId) === id) return f
  return undefined
}
/** The column as a summed measure, the way a data mapping entry would give it. */
const summed = (f: AgWidgetField): AgWidgetField => ({ ...f, type: 'implicitMeasure', aggregation: 'sum' }) as AgWidgetField

/**
 * Studio refreshes custom widgets when their own configuration changes, but not when an agent tool adds a widget filter to
 * one (the state changes, the widget is not re-rendered). The page forwards Studio's stateUpdated event here and each widget
 * re-reads its data when it fires.
 */
const stateBus = new EventTarget()
export const notifyStudioState = () => stateBus.dispatchEvent(new Event('state'))
function useStateTick() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    // The event fires as the state changes, before the filters it carries reach the data engine: read again just after.
    const on = () => {
      clearTimeout(timer)
      timer = setTimeout(() => setTick((t) => t + 1), 120)
    }
    stateBus.addEventListener('state', on)
    return () => {
      clearTimeout(timer)
      stateBus.removeEventListener('state', on)
    }
  }, [])
  return tick
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

// ----------------------------------------------------------------------------------- escrow waterfall

/** A range cross filter needs both bounds; an open end is a bound too large to matter. */
const BIG = 1e9
const WATERFALL_FIELDS = ['authorized', 'voided', 'refunded', 'held_now', 'captured', 'seller_payout', 'refund_fees_kept', 'commission', 'mediation_fees', 'paypal_fees', 'platform_net'] as const

interface Step {
  id: string
  label: string
  /** total: a bar from zero; delta: a floating bar from the running total. */
  kind: 'total' | 'delta'
  value: number
  color: string
  /** The cross-filter a click applies to the jobs: field and range. */
  filter?: { field: string; from?: number; to?: number }
}

/** The steps a set of totals makes, in order. Each total bar is the running level after the deltas before it. */
export function waterfallSteps(t: Num): Step[] {
  const kept = t.authorized - t.voided - t.refunded - t.held_now
  const afterPayout = kept - t.seller_payout
  const gross = t.commission + t.mediation_fees + t.refund_fees_kept
  const other = gross - (afterPayout + t.refund_fees_kept)
  const steps: Step[] = [
    { id: 'authorized', label: 'Authorized', kind: 'total', value: t.authorized, color: 'var(--st-c5)' },
    { id: 'voided', label: 'Voided', kind: 'delta', value: -t.voided, color: 'var(--st-bad)', filter: { field: 'voided', from: 0.01, to: BIG } },
    { id: 'refunded', label: 'Refunded', kind: 'delta', value: -t.refunded, color: 'var(--st-c2)', filter: { field: 'refunded', from: 0.01, to: BIG } },
    { id: 'held', label: 'Held now', kind: 'delta', value: -t.held_now, color: 'var(--st-c9)', filter: { field: 'held_now', from: 0.01, to: BIG } },
    { id: 'kept', label: 'Captured', kind: 'total', value: kept, color: 'var(--st-c6)', filter: { field: 'captured', from: 0.01, to: BIG } },
    { id: 'payout', label: 'Seller payout', kind: 'delta', value: -t.seller_payout, color: 'var(--st-c4)', filter: { field: 'seller_payout', from: 0.01, to: BIG } },
    { id: 'kept_fees', label: 'Refund fee kept', kind: 'delta', value: t.refund_fees_kept, color: 'var(--st-c1)', filter: { field: 'refund_fees_kept', from: 0.01, to: BIG } },
  ]
  if (Math.abs(other) >= 0.005) steps.push({ id: 'other', label: 'In flight', kind: 'delta', value: other, color: 'var(--st-c10)' })
  steps.push(
    { id: 'gross', label: 'Commission + fees', kind: 'total', value: gross, color: 'var(--st-c1)', filter: { field: 'commission', from: 0.01, to: BIG } },
    { id: 'paypal', label: 'PayPal fees', kind: 'delta', value: -t.paypal_fees, color: 'var(--st-c3)', filter: { field: 'paypal_fees', from: 0.01, to: BIG } },
    { id: 'net', label: 'Platform net', kind: 'total', value: t.platform_net, color: t.platform_net >= 0 ? 'var(--st-accent)' : 'var(--st-bad)', filter: { field: 'platform_net', from: -BIG, to: -0.0001 } },
  )
  return steps
}

interface Bar {
  step: Step
  top: number
  bottom: number
  /** Running level after this step. */
  end: number
}
function layout(steps: Step[]): Bar[] {
  let level = 0
  return steps.map((step) => {
    if (step.kind === 'total') {
      level = step.value
      return { step, top: Math.max(0, step.value), bottom: Math.min(0, step.value), end: level }
    }
    const from = level
    level += step.value
    return { step, top: Math.max(from, level), bottom: Math.min(from, level), end: level }
  })
}

interface WaterfallData {
  all: Num
  filtered: Num | null
}

function EscrowWaterfall(params: AgWidgetParams) {
  const { widgetApi } = params
  const [data, setData] = useState<WaterfallData | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [ref, size] = useSize<HTMLDivElement>()
  const tick = useStateTick()

  useEffect(() => {
    let alive = true
    const fields = WATERFALL_FIELDS.map((id) => {
      const f = schemaField(widgetApi, `jobs.${id}`)
      return f ? ([id, summed(f)] as const) : null
    }).filter((x): x is readonly [(typeof WATERFALL_FIELDS)[number], AgWidgetField] => !!x)
    if (!fields.length) return
    widgetApi.setDisplayState('loading', { prominent: false })
    widgetApi
      .getData({ fields: fields.map(([, f]) => f), filter: stateFilters(params, widgetApi) } as never, { crossFilter: 'highlight' })
      .then((res) => {
        if (!alive) return
        const read = (rows: Record<string, unknown>[] | undefined): Num | null => {
          const row = rows?.[0]
          if (!row) return null
          const out: Num = Object.fromEntries(WATERFALL_FIELDS.map((id) => [id, 0]))
          for (const [id, f] of fields) out[id] = Number(row[f.key] ?? 0) || 0
          return out
        }
        const all = read(res.results.rows)
        const filtered = read(res.crossFilter?.rows)
        if (!all || all.authorized + all.paypal_fees === 0) {
          setData(null)
          widgetApi.setDisplayState('noData')
          return
        }
        setData({ all, filtered })
        const sel = widgetApi.getCrossFilterSelections()?.find((s) => s.type === 'range')
        setSelected(sel && sel.type === 'range' ? (stepForSelection(String(sel.field.fieldId), sel.from, sel.to) ?? null) : null)
        widgetApi.setDisplayState('displayed')
      })
      .catch(() => alive && widgetApi.setDisplayState('noData'))
    return () => {
      alive = false
    }
  }, [params, widgetApi, tick])

  const solid = useMemo(() => layout(waterfallSteps(data?.filtered ?? data?.all ?? zero())), [data])
  const ghost = useMemo(() => (data?.filtered ? layout(waterfallSteps(data.all)) : null), [data])

  const choose = (step: Step) => {
    const existing = widgetApi.getCrossFilterSelections()?.find((s) => s.type === 'range')
    const same = !!existing && existing.type === 'range' && stepForSelection(String(existing.field.fieldId), existing.from, existing.to) === step.id
    widgetApi.resetCrossFilter()
    if (same || !step.filter) return
    const field = schemaField(widgetApi, `jobs.${step.filter.field}`)
    if (!field) return
    widgetApi.toggleCrossFilter({ type: 'range', field, ...(step.filter.from !== undefined ? { from: step.filter.from } : {}), ...(step.filter.to !== undefined ? { to: step.filter.to } : {}), group: 0 })
  }

  // geometry
  const padT = 26
  const padX = 6
  const W = Math.max(size.w, 240)
  const H = Math.max(size.h, 160)
  // Narrow widget (the chat panel is open, or a small tile): rotate the labels and shorten the values so nothing collides.
  const narrow = (W - padX * 2) / Math.max(solid.length, 1) < 62
  const padB = narrow ? 70 : 44
  const innerH = H - padT - padB
  const all = [...solid, ...(ghost ?? [])]
  const max = Math.max(1, ...all.map((b) => b.top))
  const min = Math.min(0, ...all.map((b) => b.bottom))
  const y = (v: number) => padT + (1 - (v - min) / (max - min || 1)) * innerH
  const band = (W - padX * 2) / Math.max(solid.length, 1)
  const barW = Math.min(46, band * 0.62)
  const filteredOn = !!data?.filtered
  const net = (data?.filtered ?? data?.all)?.platform_net ?? 0

  return (
    <div className="rab-w" role="figure" aria-label="Escrow waterfall: authorized to platform net">
      <div className="rab-w-head">
        <span className="rab-w-title">Escrow waterfall</span>
        <span className="rab-w-sub">{filteredOn ? 'filtered · dashed = all jobs' : 'where every authorized dollar went'}</span>
      </div>
      <div className="rab-w-body" ref={ref}>
        {data && size.w > 0 && (
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="list">
            <line x1={padX} x2={W - padX} y1={y(0)} y2={y(0)} stroke="var(--st-line)" strokeDasharray="4 4" />
            {solid.map((b, i) => {
              const cx = padX + band * i + band / 2
              const g = ghost?.[i]
              const hTop = y(b.top)
              const hBottom = y(b.bottom)
              const height = Math.max(2, hBottom - hTop)
              const dimmed = selected !== null && selected !== b.step.id
              const connector = i < solid.length - 1 ? y(b.end) : null
              return (
                <g
                  key={b.step.id}
                  className="rab-wf-step"
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${b.step.label}: ${money(b.step.value)}${b.step.filter ? '. Click to filter the jobs.' : ''}`}
                  aria-pressed={selected === b.step.id}
                  onClick={() => choose(b.step)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose(b.step))}
                  opacity={dimmed ? 0.4 : 1}
                >
                  <rect className="rab-wf-hit" x={cx - band / 2} y={padT - 18} width={band} height={H - padT - 6 + 18} fill="transparent" rx={6} />
                  {g && <rect className="rab-wf-ghost" x={cx - barW / 2} y={y(g.top)} width={barW} height={Math.max(2, y(g.bottom) - y(g.top))} rx={3} />}
                  <rect className="rab-wf-bar" style={{ animationDelay: `${i * 45}ms` }} x={cx - barW / 2} y={hTop} width={barW} height={height} rx={3} fill={b.step.color} />
                  {connector !== null && <line x1={cx + barW / 2} x2={cx + band - barW / 2} y1={connector} y2={connector} stroke="var(--st-mute)" strokeWidth={1} strokeDasharray="2 3" />}
                  <text className="rab-wf-value" x={cx} y={hTop - 6} textAnchor="middle" style={narrow ? { fontSize: 9.5 } : undefined}>
                    {b.step.kind === 'delta' && b.step.value > 0 ? '+' : ''}
                    {narrow ? compact(b.step.value) : Math.abs(b.step.value) >= 1000 ? usd0.format(b.step.value) : money(b.step.value)}
                  </text>
                  {narrow ? (
                    <text className="rab-wf-label" x={cx + 4} y={H - padB + 14} textAnchor="end" transform={`rotate(-38 ${cx + 4} ${H - padB + 14})`}>
                      {b.step.label}
                    </text>
                  ) : (
                    <text className="rab-wf-label" x={cx} y={H - padB + 16} textAnchor="middle">
                      {wrap(b.step.label, Math.max(8, Math.floor(band / 6.4))).map((l, k) => (
                        <tspan key={k} x={cx} dy={k === 0 ? 0 : 12}>
                          {l}
                        </tspan>
                      ))}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {data && <span className="rab-w-stamp" style={{ color: net >= 0 ? 'var(--st-accent)' : 'var(--st-bad)', borderColor: net >= 0 ? 'var(--st-accent)' : 'var(--st-bad)' }}>{net >= 0 ? 'net positive' : 'net negative'}</span>}
      </div>
    </div>
  )
}

/** $1.4k, -$458, $0: short enough for a narrow bar. */
const compact = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1)}k` : Math.round(Math.abs(v))}`
const zero = (): Num => Object.fromEntries(WATERFALL_FIELDS.map((id) => [id, 0]))
function stepForSelection(fieldId: string, from: unknown, to: unknown): string | undefined {
  const rule = waterfallSteps(zero()).find((s) => s.filter && `jobs.${s.filter.field}` === fieldId && (s.filter.from ?? null) === (from ?? null) && (s.filter.to ?? null) === (to ?? null))
  return rule?.id
}
function wrap(text: string, width: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  for (const w of words) {
    const last = lines.at(-1)
    if (last !== undefined && (last + ' ' + w).length <= width) lines[lines.length - 1] = last + ' ' + w
    else lines.push(w)
  }
  return lines.slice(0, 3)
}

// ------------------------------------------------------------------------------------ fee variance

interface FeeRow {
  id: string
  title: string
  bot: string
  actual: number
  est: number
}
const FEE_ROWS = 12

function FeeVariance(params: AgWidgetParams) {
  const { widgetApi } = params
  const [rows, setRows] = useState<{ top: FeeRow[]; jobs: number; over: number; total: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [ref, size] = useSize<HTMLDivElement>()
  const tick = useStateTick()

  useEffect(() => {
    let alive = true
    const ids = schemaField(widgetApi, 'jobs.job_id')
    const title = schemaField(widgetApi, 'jobs.title')
    const bot = schemaField(widgetApi, 'jobs.bot')
    const actual = schemaField(widgetApi, 'jobs.paypal_fees')
    const est = schemaField(widgetApi, 'jobs.paypal_fees_est')
    if (!ids || !title || !bot || !actual || !est) return
    const fa = summed(actual)
    const fe = summed(est)
    widgetApi.setDisplayState('loading', { prominent: false })
    widgetApi
      .getData({ fields: [ids, title, bot, fa, fe], filter: stateFilters(params, widgetApi), limit: { offset: 0, count: 2000 } } as never, { crossFilter: 'highlight' })
      .then((res) => {
        if (!alive) return
        // Highlight mode returns the unfiltered rows and, when something is selected elsewhere, the filtered ones: show the filtered ones.
        const all: FeeRow[] = (res.crossFilter?.rows ?? res.results.rows)
          .map((r) => ({ id: String(r[ids.key]), title: String(r[title.key] ?? ''), bot: String(r[bot.key] ?? ''), actual: Number(r[fa.key] ?? 0), est: Number(r[fe.key] ?? 0) }))
          .filter((r) => r.actual > 0 || r.est > 0)
        if (!all.length) {
          setRows(null)
          widgetApi.setDisplayState('noData')
          return
        }
        const top = [...all].sort((a, b) => Math.abs(b.actual - b.est) - Math.abs(a.actual - a.est) || b.actual - a.actual).slice(0, FEE_ROWS).sort((a, b) => b.actual - b.est - (a.actual - a.est))
        setRows({ top, jobs: all.length, over: all.filter((r) => r.actual - r.est > 0.004).length, total: all.reduce((s, r) => s + r.actual - r.est, 0) })
        const sel = widgetApi.getCrossFilterSelections()?.find((s) => s.type === 'value')
        setSelected(sel && sel.type === 'value' ? String(sel.values[0] ?? '') || null : null)
        widgetApi.setDisplayState('displayed')
      })
      .catch(() => alive && widgetApi.setDisplayState('noData'))
    return () => {
      alive = false
    }
  }, [params, widgetApi, tick])

  const choose = (r: FeeRow) => {
    const field = schemaField(widgetApi, 'jobs.job_id')
    if (!field) return
    const was = selected === r.id
    widgetApi.resetCrossFilter()
    if (!was) widgetApi.toggleCrossFilter({ type: 'value', field, value: r.id, group: 0 })
  }

  const W = Math.max(size.w, 260)
  const H = Math.max(size.h, 160)
  const labelW = Math.min(150, W * 0.36)
  const rightW = 56
  const padT = 22
  const rowH = rows ? Math.min(30, (H - padT - 6) / rows.top.length) : 24
  const maxV = rows ? Math.max(0.01, ...rows.top.flatMap((r) => [r.actual, r.est])) : 1
  const x = (v: number) => labelW + 8 + (v / maxV) * (W - labelW - rightW - 24)

  return (
    <div className="rab-w" role="figure" aria-label="PayPal fee variance per job: actual against estimated">
      <div className="rab-w-head">
        <span className="rab-w-title">Fee variance</span>
        <span className="rab-w-sub">{rows ? `${rows.over} of ${rows.jobs} jobs cost more than estimated · ${rows.total >= 0 ? '+' : '−'}${usd.format(Math.abs(rows.total))}` : 'PayPal fee: actual vs estimate'}</span>
      </div>
      <div className="rab-w-body" ref={ref}>
        {rows && size.w > 0 && (
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="list">
            <text className="rab-wf-label" x={x(maxV)} y={12} textAnchor="end">
              {usd.format(maxV)}
            </text>
            <g transform="translate(4, 8)">
              <circle cx={0} cy={0} r={3.4} fill="none" stroke="var(--st-mute)" strokeWidth={1.4} />
              <text className="rab-wf-label" x={7} y={3}>
                estimate
              </text>
              <circle cx={78} cy={0} r={3.4} fill="var(--st-text)" />
              <text className="rab-wf-label" x={85} y={3}>
                actual
              </text>
            </g>
            {rows.top.map((r, i) => {
              const cy = padT + rowH * i + rowH / 2
              const d = r.actual - r.est
              const color = d > 0.004 ? 'var(--st-bad)' : d < -0.004 ? 'var(--st-good)' : 'var(--st-mute)'
              const dim = selected !== null && selected !== r.id
              return (
                <g
                  key={r.id}
                  className="rab-fv-row"
                  role="listitem"
                  tabIndex={0}
                  opacity={dim ? 0.35 : 1}
                  aria-label={`${r.title}: PayPal fee ${money(r.actual)} against ${money(r.est)} estimated`}
                  aria-pressed={selected === r.id}
                  onClick={() => choose(r)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose(r))}
                >
                  <rect x={0} y={cy - rowH / 2} width={W} height={rowH} fill="transparent" />
                  <text className="rab-wf-label" x={0} y={cy + 3.5} style={{ fill: 'var(--st-text)' }}>
                    {clip(r.title, Math.floor(labelW / 6.2))}
                  </text>
                  <line x1={x(0)} x2={x(maxV)} y1={cy} y2={cy} stroke="var(--st-line-soft)" strokeDasharray="1 4" />
                  <line className="rab-fv-line" x1={x(r.est)} x2={x(r.actual)} y1={cy} y2={cy} stroke={color} strokeWidth={3} strokeLinecap="round" />
                  <circle cx={x(r.est)} cy={cy} r={4} fill="var(--st-surface)" stroke="var(--st-mute)" strokeWidth={1.5} />
                  <circle cx={x(r.actual)} cy={cy} r={4.6} fill={color} />
                  <text className="rab-wf-value" x={W - 2} y={cy + 4} textAnchor="end" style={{ fill: color }}>
                    {d >= 0 ? '+' : '−'}
                    {usd.format(Math.abs(d))}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)

// ----------------------------------------------------------------------------------- registration

type Def = { id: string; widgets: { id: string; formatShape?: unknown }[] }
/** createWidgets config: both widgets in a "Rent-A-Bot" menu group, ahead of the built-in groups. */
export function buildWidgets() {
  return (widgetConfig: { widgets: Def['widgets']; menu: unknown[] }) => {
    // The format shape (title, subtitle, caption, appearance, cross filter) is the value widget's: it gives agents the
    // same format schema to set as for any other widget.
    const valueDef = (widgetConfig.widgets as unknown as { id: string; formatShape?: unknown }[]).find((w) => w.id === 'value')
    const common = {
      icon: { url: '/favicon.svg' },
      form: (p: { createDefaults: (o: unknown) => unknown }) => p.createDefaults({ dataMappingItems: [], supportsCrossHighlight: true }),
      formatShape: valueDef?.formatShape,
      featureConfig: { crossFilter: { supportsHighlight: true } },
      minSize: { width: 280, height: 200 },
    }
    return (createWidgets as (p: unknown) => unknown)({
      additionalTypes: [
        {
          ...common,
          id: 'escrow-waterfall',
          label: 'Escrow waterfall',
          comp: EscrowWaterfall,
          defaultSize: { width: 760, height: 460 },
          ai: {
            label: 'Escrow waterfall',
            description:
              'Custom Rent-A-Bot widget: a waterfall of where every authorized escrow dollar went (authorized, voided, refunded, held, captured, seller payout, commission and fees, PayPal fees, platform net). ' +
              'It reads the jobs table by itself and needs no field mapping. Page filters (a date range, a bot, a week) and cross filters from other widgets change what it sums; clicking a step cross-filters the jobs that contributed to it.',
            usage: 'Add it with add_widget (type escrow-waterfall), position it, then restrict what it shows with a page filter such as jobs.date between two dates. Only title, subtitle and caption need configuring.',
          },
        },
        {
          ...common,
          id: 'fee-variance',
          label: 'Fee variance',
          comp: FeeVariance,
          defaultSize: { width: 560, height: 460 },
          ai: {
            label: 'Fee variance',
            description:
              'Custom Rent-A-Bot widget: a dumbbell per job comparing the PayPal fee actually charged to the estimate, red where PayPal charged more and green where it charged less, biggest gaps first. ' +
              'It reads the jobs table by itself and needs no field mapping; page filters and cross filters apply. Clicking a job cross-filters the page to it.',
            usage: 'Add it with add_widget (type fee-variance) and position it; narrow it to a period with a page filter on jobs.date.',
          },
        },
      ],
      menu: [{ label: 'Rent-A-Bot', widgetIds: ['escrow-waterfall', 'fee-variance'] }, ...(widgetConfig.menu as unknown[])],
    })
  }
}
