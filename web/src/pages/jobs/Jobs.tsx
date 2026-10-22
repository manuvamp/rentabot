import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Clock, Inbox } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import { openEventStream } from '../../api/stream'
import type { JobSummary } from '../../api/types'
import { Chip, Container, EmptyState, ErrorBox, LinkButton, PageHeader, Reveal, Skeleton, StateBadge } from '../../components/ui'
import { cents, countdown, STATE_LABEL, timeAgo, usd } from '../../lib/format'
import { useNow } from './sidebar/useNow'

const CLOSED = ['SETTLED', 'CANCELLED', 'EXPIRED']
const botLabel = (id: string) => id.replace(/^bot_/, '').replace(/([a-z])([A-Z])/g, '$1 $2')

function Row({ j, mine, botName, now, needs }: { j: JobSummary; mine: boolean; botName: string; now: number; needs: boolean }) {
  const left = j.next_deadline ? countdown(j.next_deadline, now) : ''
  const held = cents(j.held.value)
  return (
    <li>
      <Link
        to={`/jobs/${j.id}`}
        className={`group relative flex flex-col gap-3 rounded-2xl border p-4 pl-5 transition sm:flex-row sm:items-center sm:gap-6 ${needs ? 'border-lime/50 bg-ink-1 hover:border-hl' : 'border-line bg-ink-1/60 hover:border-soft'}`}
      >
        <span aria-hidden className={`absolute inset-y-3 left-0 w-1 rounded-r ${needs ? 'bg-lime' : CLOSED.includes(j.state) ? 'bg-ink-3' : 'bg-line'}`} />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <StateBadge state={j.state} />
            <Chip mono>{j.your_role}</Chip>
            {needs && (
              <span className="inline-flex items-center gap-1 rounded-full bg-hl px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-ink">
                <span className="live-dot size-1.5 rounded-full bg-ink" aria-hidden /> Your move
              </span>
            )}
          </div>
          <h3 className="truncate font-display text-[1.35rem] font-extrabold leading-tight tracking-tight text-fog group-hover:text-white">{j.title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[13px] text-mute">
            <span>{botName}</span>
            <span aria-hidden>·</span>
            <span className="font-mono text-[12px]">{j.id}</span>
            <span aria-hidden>·</span>
            <span>updated {timeAgo(j.updated_at)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-6 sm:text-right">
          <div>
            <p className="eyebrow">Held</p>
            <p className={`num font-mono text-lg ${held ? 'text-amber' : 'text-mute'}`}>{usd(j.held)}</p>
          </div>
          <div className="min-w-[84px]">
            <p className="eyebrow">Next deadline</p>
            <p className={`flex items-center gap-1 font-mono text-sm sm:justify-end ${left === 'expired' ? 'text-coral' : 'text-soft'}`}>
              {left ? (
                <>
                  <Clock className="size-3.5" aria-hidden /> {left}
                </>
              ) : (
                <span className="text-mute">none</span>
              )}
            </p>
          </div>
          <ArrowUpRight className="hidden size-5 text-mute transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-hl sm:block" aria-hidden />
        </div>
      </Link>
      {mine && null}
    </li>
  )
}

function Section({ title, count, children, hint }: { title: string; count: number; children: React.ReactNode; hint?: string }) {
  if (!count) return null
  return (
    <section className="mb-9" aria-label={title}>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="font-display text-2xl font-extrabold tracking-tight">{title}</h2>
        <span className="font-mono text-sm text-mute">{count}</span>
        {hint && <span className="hidden text-sm text-mute sm:inline">{hint}</span>}
      </div>
      <ul className="space-y-3">{children}</ul>
    </section>
  )
}

export default function Jobs() {
  const now = useNow()
  const [role, setRole] = useState<'all' | 'buyer' | 'seller'>('all')
  const [state, setState] = useState<string>('all')

  const all = useAsync(() => callOp('list_jobs', { limit: 100, needs_action: false }), [])
  const need = useAsync(() => callOp('list_jobs', { limit: 100, needs_action: true }), [])
  const bots = useAsync(() => callOp('search_bots', { limit: 50 }), [])
  const reload = useRef<() => void>(() => {})
  reload.current = () => {
    all.reload()
    need.reload()
  }
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const close = openEventStream({}, () => {
      clearTimeout(t)
      t = setTimeout(() => reload.current(), 400)
    })
    const poll = setInterval(() => reload.current(), 15_000)
    return () => {
      close()
      clearTimeout(t)
      clearInterval(poll)
    }
  }, [])

  const names = useMemo(() => new Map((bots.data?.bots ?? []).map((b) => [b.id as string, b.name])), [bots.data])
  const needIds = useMemo(() => new Set((need.data?.jobs ?? []).map((j) => j.id as string)), [need.data])
  const jobs = (all.data?.jobs ?? []).filter((j) => (role === 'all' || j.your_role === role) && (state === 'all' || j.state === state))
  const waiting = jobs.filter((j) => needIds.has(j.id))
  const flight = jobs.filter((j) => !needIds.has(j.id) && !CLOSED.includes(j.state))
  const closed = jobs.filter((j) => !needIds.has(j.id) && CLOSED.includes(j.state))
  const heldTotal = (all.data?.jobs ?? []).reduce((a, j) => a + cents(j.held.value), 0)
  const loading = all.loading && !all.data
  const name = (id: string) => names.get(id) ?? botLabel(id)

  return (
    <Container wide className="py-10">
      <PageHeader
        eyebrow="Your counter"
        title="Jobs"
        actions={
          <LinkButton to="/bots" variant="primary">
            Hire another bot
          </LinkButton>
        }
      >
        Everything you are buying or selling, with the ones that need you first. People use the same operations agents do.
      </PageHeader>

      {!loading && all.data && (
        <div className="mb-8 grid grid-cols-3 gap-3 sm:max-w-2xl">
          {[
            ['Waiting on you', String(needIds.size), needIds.size ? 'text-lime' : 'text-fog'],
            ['In flight', String((all.data.jobs ?? []).filter((j) => !CLOSED.includes(j.state)).length), 'text-fog'],
            ['Held in escrow', usd(heldTotal / 100), 'text-amber'],
          ].map(([l, v, c]) => (
            <div key={l} className="panel px-4 py-3">
              <p className="eyebrow">{l}</p>
              <p className={`num mt-1 font-display text-2xl font-extrabold tracking-tight ${c}`}>{v}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mb-7 flex flex-wrap items-center gap-3" role="group" aria-label="Filters">
        <div className="flex rounded-lg border border-line bg-ink-1 p-0.5" role="radiogroup" aria-label="Role">
          {(['all', 'buyer', 'seller'] as const).map((r) => (
            <button key={r} role="radio" aria-checked={role === r} onClick={() => setRole(r)} className={`rounded-md px-3 py-1.5 text-sm capitalize transition ${role === r ? 'bg-fog text-ink font-semibold' : 'text-soft hover:text-fog'}`}>
              {r === 'all' ? 'All roles' : `As ${r}`}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-mute">
          <span className="visually-hidden sm:not-sr-only">State</span>
          <select className="field !w-auto !py-1.5" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="all">Any state</option>
            {Object.entries(STATE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorBox error={all.error ?? need.error} title="Could not load jobs" onRetry={reload.current} className="mb-6" />

      {loading && (
        <div className="space-y-3" role="status" aria-label="Loading jobs">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {!loading && all.data && (
        <Reveal y={10}>
          <Section title="Waiting on you" count={waiting.length} hint="Do these first.">
            {waiting.map((j) => (
              <Row key={j.id} j={j} mine botName={name(j.seller_bot_id)} now={now} needs />
            ))}
          </Section>
          <Section title="In flight" count={flight.length}>
            {flight.map((j) => (
              <Row key={j.id} j={j} mine botName={name(j.seller_bot_id)} now={now} needs={false} />
            ))}
          </Section>
          <Section title="Closed" count={closed.length}>
            {closed.map((j) => (
              <Row key={j.id} j={j} mine botName={name(j.seller_bot_id)} now={now} needs={false} />
            ))}
          </Section>
          {!jobs.length && (
            <EmptyState
              title={all.data.jobs.length ? 'No jobs match those filters.' : 'No jobs yet.'}
              action={
                <LinkButton to="/bots" icon={<Inbox className="size-4" />}>
                  Browse bots
                </LinkButton>
              }
            >
              {all.data.jobs.length ? 'Clear a filter to see the rest.' : 'Pick a bot, describe the goal, and the Spec Copilot turns it into a contract made of tests.'}
            </EmptyState>
          )}
        </Reveal>
      )}
    </Container>
  )
}
