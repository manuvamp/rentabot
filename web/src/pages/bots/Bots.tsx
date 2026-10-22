import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Check, Columns3, LayoutGrid, Lock, Rows3, Search } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import type { BotSummary, CapabilityClass } from '../../api/types'
import { BotTag, ComingSoonTag, priceLine } from '../../components/BotTag'
import { ClassChip, Container, EmptyState, ErrorBox, LinkButton, ModeBadge, PageHeader, Reveal, Skeleton } from '../../components/ui'
import { COMING_SOON } from '../../lib/fixtures'
import { CLASS_LABEL, duration } from '../../lib/format'
import { modelLabel } from '../../components/Passport'

type View = 'tags' | 'table' | 'compare'
/** Connection filters: a kind of connection, or bots that bring their own accounts. */
type ConnFilter = 'email' | 'browser' | 'data_api' | 'security' | 'own'
const CONN_FILTERS: [ConnFilter, string][] = [
  ['email', 'Email'],
  ['browser', 'Browser'],
  ['data_api', 'Data APIs'],
  ['security', 'Security'],
  ['own', 'Brings its own accounts'],
]
const connMatch = (b: BotSummary, f: ConnFilter) =>
  (b.passport?.connections ?? []).some((c) => (f === 'own' ? c.owner === 'bot' : c.kind === f))
type ModeFilter = 'all' | 'demo' | 'live'

const ROT = [-1.6, 1.2, -0.8, 1.8, -1.2, 0.8]

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100)}%`)

export default function Bots() {
  const [query, setQuery] = useState('')
  const [cls, setCls] = useState<CapabilityClass | 'all'>('all')
  const [mode, setMode] = useState<ModeFilter>('all')
  const [view, setView] = useState<View>('tags')
  const [conns, setConns] = useState<ConnFilter[]>([])
  const q = useDebounced(query, 220)

  // Fetch the whole shelf once (class chips come from the unfiltered list) and filter client side for the class,
  // but send text and mode to the server so the same query works against any backend.
  const res = useAsync(() => callOp('search_bots', { query: q || undefined, mode: mode === 'all' ? undefined : mode, limit: 50 }), [q, mode])
  const all = res.data?.bots ?? []
  const classes = useMemo(() => Array.from(new Set(all.map((b) => b.capability_class))), [all])
  const bots = useMemo(() => all.filter((b) => (cls === 'all' || b.capability_class === cls) && conns.every((f) => connMatch(b, f))), [all, cls, conns])
  // The shelf shows only when something is really coming; an empty list removes the section.
  const showSoon = COMING_SOON.length > 0 && !q && cls === 'all' && mode !== 'live' && !conns.length

  return (
    <Container className="py-12 sm:py-16" wide>
      <PageHeader eyebrow="The rental counter" title="Pick a bot off the shelf.">
        Every bot is priced per verified unit or fixed, and every deliverable is checked by code before money moves.
      </PageHeader>

      <div className="mb-8 flex flex-col gap-4 rounded-2xl border border-line bg-ink-1 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-md">
          <label htmlFor="bot-search" className="visually-hidden">
            Search bots
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
          <input id="bot-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: directories, leads, audit, email…" className="field pl-9" />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div role="group" aria-label="Filter by mode" className="flex gap-1 rounded-lg border border-line p-0.5">
            {(['all', 'demo', 'live'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={`rounded-md px-3 py-1 text-[13px] font-medium capitalize transition-colors ${mode === m ? 'bg-fog text-ink' : 'text-soft hover:text-fog'}`}>
                {m}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Layout" className="flex gap-1 rounded-lg border border-line p-0.5">
            <button onClick={() => setView('tags')} aria-pressed={view === 'tags'} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium ${view === 'tags' ? 'bg-fog text-ink' : 'text-soft hover:text-fog'}`}>
              <LayoutGrid className="size-3.5" aria-hidden /> Tags
            </button>
            <button onClick={() => setView('table')} aria-pressed={view === 'table'} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium ${view === 'table' ? 'bg-fog text-ink' : 'text-soft hover:text-fog'}`}>
              <Rows3 className="size-3.5" aria-hidden /> Table
            </button>
            <button onClick={() => setView('compare')} aria-pressed={view === 'compare'} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium ${view === 'compare' ? 'bg-fog text-ink' : 'text-soft hover:text-fog'}`}>
              <Columns3 className="size-3.5" aria-hidden /> Compare
            </button>
          </div>
        </div>
        <div role="group" aria-label="Filter by capability" className="flex flex-wrap gap-1.5 lg:hidden">
          <ClassButtons classes={classes} value={cls} onChange={setCls} />
        </div>
      </div>
      <div role="group" aria-label="Filter by capability" className="-mt-4 mb-3 hidden flex-wrap gap-1.5 lg:flex">
        <ClassButtons classes={classes} value={cls} onChange={setCls} />
      </div>
      <div role="group" aria-label="Filter by what the bot connects to" className="mb-8 flex flex-wrap items-center gap-1.5 lg:mt-0">
        <span className="mr-1 font-mono text-[11px] uppercase tracking-widest text-mute">Connects to</span>
        {CONN_FILTERS.map(([f, label]) => {
          const on = conns.includes(f)
          return (
            <button key={f} onClick={() => setConns((x) => (on ? x.filter((y) => y !== f) : [...x, f]))} aria-pressed={on} className={`rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ${on ? 'border-lav bg-lav text-ink' : 'border-dashed border-line text-soft hover:border-soft hover:text-fog'}`}>
              {f === 'own' ? '✓ ' : ''}
              {label}
            </button>
          )
        })}
      </div>

      <ErrorBox error={res.error} onRetry={res.reload} title="Could not load the shelf" />

      {res.loading && !res.data ? (
        <div className="grid gap-x-8 gap-y-14 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-80" />
          ))}
        </div>
      ) : bots.length === 0 && !res.error ? (
        <EmptyState title="No bot matches." action={<button className="text-sm font-semibold text-lime underline underline-offset-4" onClick={() => { setQuery(''); setCls('all'); setMode('all'); setConns([]) }}>Clear filters</button>}>
          Try a broader word, or list your own bot for this job.
        </EmptyState>
      ) : view === 'tags' ? (
        <>
          <ul className="grid list-none gap-x-8 gap-y-14 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {bots.map((b, i) => (
              <li key={b.id}>
                <Reveal delay={Math.min(i, 5) * 0.06}>
                  <BotTag bot={b} rotate={ROT[i % ROT.length]} index={i} />
                </Reveal>
              </li>
            ))}
          </ul>
          {showSoon && (
            <section className="mt-20" aria-labelledby="soon">
              <div className="mb-6 flex items-baseline gap-4">
                <h2 id="soon" className="font-display text-2xl font-bold tracking-tight text-soft">
                  Back of the shelf
                </h2>
                <span className="eyebrow">coming soon</span>
              </div>
              <ul className="grid list-none gap-x-8 gap-y-14 opacity-90 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
                {COMING_SOON.map((c, i) => (
                  <li key={c.name}>
                    <ComingSoonTag bot={c} rotate={ROT[(i + 3) % ROT.length]} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : view === 'compare' ? (
        <BotCompare bots={bots} />
      ) : (
        <BotTable bots={bots} />
      )}

      <div className="mt-20 flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-ink-1 p-6 sm:flex-row sm:items-center">
        <div>
          <p className="font-display text-xl font-bold tracking-tight">Run a bot of your own?</p>
          <p className="mt-1 text-sm text-soft">Publish a Bot Card, declare the checks, get paid out on PayPal for every verified unit.</p>
        </div>
        <LinkButton to="/sell" variant="ghost">
          Sell a bot
        </LinkButton>
      </div>
    </Container>
  )
}

function ClassButtons({ classes, value, onChange }: { classes: CapabilityClass[]; value: CapabilityClass | 'all'; onChange: (c: CapabilityClass | 'all') => void }) {
  const items: (CapabilityClass | 'all')[] = ['all', ...classes]
  return (
    <>
      {items.map((c) => (
        <button key={c} onClick={() => onChange(c)} aria-pressed={value === c} className={`rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ${value === c ? 'border-hl bg-hl text-ink' : 'border-line text-soft hover:border-soft hover:text-fog'}`}>
          {c === 'all' ? 'All' : (CLASS_LABEL[c] ?? c)}
        </button>
      ))}
    </>
  )
}

function BotTable({ bots }: { bots: BotSummary[] }) {
  return (
    <>
      <ul className="space-y-3 sm:hidden" aria-label="Bots for hire">
        {bots.map((b) => (
          <li key={b.id}>
            <Link to={`/bots/${b.id}`} className="block rounded-2xl border border-line bg-ink-1 p-4 transition-colors hover:border-soft">
              <div className="flex items-center justify-between gap-3">
                <span className="font-display text-lg font-bold tracking-tight text-fog">{b.name}</span>
                <span className="inline-block shrink-0 rounded-md bg-paper px-1 py-0.5">
                  <ModeBadge mode={b.mode} />
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] text-mute">{b.tagline}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12.5px]">
                <span className="rounded-md bg-hl px-2 py-0.5 font-bold text-ink">{priceLine(b.skills[0])}</span>
                <span className="text-soft">{duration(b.skills[0]?.turnaround)}</span>
                <span className="text-mute">{b.reputation.jobs_completed} {b.reputation.jobs_completed === 1 ? 'job' : 'jobs'}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    <div className="hidden overflow-x-auto rounded-2xl border border-line sm:block">
      <table className="w-full min-w-[820px] border-collapse text-left text-sm">
        <caption className="visually-hidden">Bots for hire</caption>
        <thead className="bg-ink-1 text-[11px] uppercase tracking-widest text-mute">
          <tr>
            {['Bot', 'Class', 'Mode', 'Price', 'Turnaround', 'Jobs', 'On time', 'Disputes'].map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-mono font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => (
            <tr key={b.id} className="border-t border-line transition-colors hover:bg-ink-1">
              <th scope="row" className="px-4 py-3.5 font-medium">
                <Link to={`/bots/${b.id}`} className="text-fog hover:text-hl">
                  {b.name}
                </Link>
                <div className="mt-0.5 max-w-sm truncate text-[12.5px] font-normal text-mute">{b.tagline}</div>
              </th>
              <td className="px-4 py-3.5">
                <ClassChip cls={b.capability_class} />
              </td>
              <td className="px-4 py-3.5">
                <span className="inline-block rounded-md bg-paper px-1 py-0.5">
                  <ModeBadge mode={b.mode} />
                </span>
              </td>
              <td className="px-4 py-3.5 font-mono text-[13px] text-fog">{priceLine(b.skills[0])}</td>
              <td className="px-4 py-3.5 text-soft">{duration(b.skills[0]?.turnaround)}</td>
              <td className="num px-4 py-3.5 font-mono text-soft">{b.reputation.jobs_completed}</td>
              <td className="num px-4 py-3.5 font-mono text-soft">{pct(b.reputation.on_time_rate)}</td>
              <td className="num px-4 py-3.5 font-mono text-soft">{pct(b.reputation.dispute_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

const ACTION_SHORT: Record<string, string> = {
  send_email: 'sends email',
  create_account: 'makes accounts',
  fill_form: 'fills forms',
  post_content: 'posts',
  call_api: 'calls APIs',
  browse: 'reads web',
  write: 'writes',
  analyze: 'checks',
}

/** Side by side: what each bot runs on, what it reaches, whose accounts, what it does and unlocks. */
const DEFAULT_COMPARE = 3

/** Which bots the compare view shows: the reader's picks that are still on the shelf, else the first three. */
function comparedBots(bots: BotSummary[], picked: string[] | null): BotSummary[] {
  const chosen = picked ? bots.filter((b) => picked.includes(b.id)) : []
  return chosen.length ? chosen : bots.slice(0, DEFAULT_COMPARE)
}

function ComparePicker({ bots, shownIds, onPick }: { bots: BotSummary[]; shownIds: string[]; onPick: (ids: string[]) => void }) {
  const toggle = (id: string) => onPick(shownIds.includes(id) ? shownIds.filter((x) => x !== id) : bots.filter((b) => b.id === id || shownIds.includes(b.id)).map((b) => b.id))
  return (
    <div className="mb-4 rounded-2xl border border-line bg-ink-1 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="font-mono text-[11px] uppercase tracking-widest text-mute" id="compare-pick-h">
          Compare <span className="text-fog">{shownIds.length}</span> of {bots.length}
        </p>
        <div className="flex gap-3 text-[13px]">
          <button className="font-semibold text-soft underline underline-offset-4 hover:text-fog" onClick={() => onPick(bots.slice(0, DEFAULT_COMPARE).map((b) => b.id))}>
            First {DEFAULT_COMPARE}
          </button>
          <button className="font-semibold text-soft underline underline-offset-4 hover:text-fog" onClick={() => onPick(bots.map((b) => b.id))}>
            All
          </button>
        </div>
      </div>
      <div role="group" aria-labelledby="compare-pick-h" className="mt-2.5 flex flex-wrap gap-1.5">
        {bots.map((b) => {
          const on = shownIds.includes(b.id)
          return (
            <button key={b.id} onClick={() => toggle(b.id)} aria-pressed={on} className={`inline-flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors ${on ? 'border-hl bg-hl text-ink' : 'border-dashed border-line text-soft hover:border-soft hover:text-fog'}`}>
              {on && <Check className="size-3.5 shrink-0" aria-hidden />}
              <span className="truncate">{b.name}</span>
            </button>
          )
        })}
      </div>
      {shownIds.length < 2 && <p className="mt-2 text-[12.5px] text-amber">Pick at least two bots to compare them side by side.</p>}
    </div>
  )
}

function BotCompare({ bots: shelf }: { bots: BotSummary[] }) {
  const [picked, setPicked] = useState<string[] | null>(null)
  const bots = comparedBots(shelf, picked)
  const head = ['Bot', 'Price', 'Model', 'Open weights', 'Connections', 'Own accounts', 'Real actions', 'Unlocks', 'Verified']
  return (
    <>
    <ComparePicker bots={shelf} shownIds={bots.map((b) => b.id)} onPick={setPicked} />
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[1240px] border-collapse text-left align-top text-[13px]">
        <caption className="visually-hidden">Compare bots: models, connections and actions</caption>
        <thead className="bg-ink-1 text-[11px] uppercase tracking-widest text-mute">
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={`px-4 py-3 font-mono font-medium ${i === 0 ? 'sticky left-0 z-[1] bg-ink-1' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => {
            const p = b.passport
            const conns = p?.connections ?? []
            const own = conns.filter((c) => c.owner === 'bot')
            const actions = Array.from(new Set(b.skills.flatMap((s) => s.brief?.does.map((d) => d.action) ?? [])))
            const verified = conns.length ? conns.every((c) => c.verified) : !!p
            return (
              <tr key={b.id} className="border-t border-line align-top transition-colors hover:bg-ink-1">
                <th scope="row" className="sticky left-0 z-[1] bg-ink px-4 py-3.5 font-medium shadow-[6px_0_8px_-6px_rgba(0,0,0,0.6)]">
                  <Link to={`/bots/${b.id}`} className="text-fog hover:text-hl">
                    {b.name}
                  </Link>
                  <div className="mt-1">
                    <span className="inline-block rounded-md bg-paper px-1 py-0.5">
                      <ModeBadge mode={b.mode} />
                    </span>
                  </div>
                </th>
                <td className="max-w-[14rem] px-4 py-3.5 font-mono text-[12.5px] text-fog">{priceLine(b.skills[0]) || <Dash />}</td>
                <td className="px-4 py-3.5 text-fog">{!p ? <Dash /> : p.models.length ? p.models.map((m) => modelLabel(m.model)).join(' + ') : <span className="text-soft">no AI</span>}</td>
                <td className="px-4 py-3.5 text-soft">{!p ? <Dash /> : p.models.some((m) => m.open_weights) ? 'yes' : 'no'}</td>
                <td className="px-4 py-3.5">
                  {conns.length ? (
                    <ul className="space-y-1">
                      {conns.map((c) => (
                        <li key={c.name} className="flex items-center gap-1 text-soft">
                          {c.owner === 'buyer' && <Lock className="size-3 shrink-0 text-coral" aria-label="uses your account" />}
                          {c.name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Dash />
                  )}
                </td>
                <td className="px-4 py-3.5 text-soft">{own.length ? <span className="text-lime">✓ {own.length}</span> : <Dash />}</td>
                <td className="px-4 py-3.5 text-soft">{actions.length ? actions.map((a) => ACTION_SHORT[a] ?? a).join(', ') : <Dash />}</td>
                <td className="max-w-[16rem] px-4 py-3.5 text-soft">{p?.unlocks.length ? p.unlocks.join('; ') : <Dash />}</td>
                <td className="px-4 py-3.5">{!p ? <Dash /> : verified ? <span className="font-mono text-[11px] font-bold text-lime">✓ VERIFIED</span> : <span className="font-mono text-[11px] text-mute">declared</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    </>
  )
}

const Dash = () => <span className="text-mute">–</span>
