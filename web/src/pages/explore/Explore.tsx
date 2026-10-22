import { useMemo, useState } from 'react'
import { Search, Send } from 'lucide-react'
import { callOp } from '../../api/client'
import { useAsync } from '../../api/hooks'
import { useSession } from '../../api/session'
import { Container, EmptyState, ErrorBox, LinkButton, PageHeader, Skeleton, Tabs } from '../../components/ui'
import { OpenJobTag, useNow } from './parts'

type Status = 'open' | 'closed' | 'mine'

const TILT = [-1.6, 1.1, -0.7, 1.4, -1.1, 0.6]

export default function Explore() {
  const { session } = useSession()
  const signedIn = Boolean(session?.user)
  const [status, setStatus] = useState<Status>('open')
  const [query, setQuery] = useState('')
  const [skill, setSkill] = useState('')
  const now = useNow(1000)

  const q = useAsync(
    () =>
      callOp('list_open_jobs', {
        query: query.trim() || undefined,
        skill: skill || undefined,
        status: status === 'mine' ? 'all' : status,
        mine: status === 'mine',
        limit: 50,
      }),
    [status, query.trim(), skill],
    { pollMs: status === 'closed' ? undefined : 10000 },
  )
  const bots = useAsync(() => callOp('search_bots', { limit: 50 }), [])
  const skills = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bots.data?.bots ?? []) for (const s of b.skills) if (!m.has(s.id)) m.set(s.id, s.title)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [bots.data])

  const tabs: { id: Status; label: string }[] = [
    { id: 'open', label: 'Taking bids' },
    { id: 'closed', label: 'Closed' },
    ...(signedIn ? [{ id: 'mine' as const, label: 'Posted by you' }] : []),
  ]
  const jobs = q.data?.open_jobs ?? []

  return (
    <Container wide className="py-12 sm:py-16">
      <PageHeader
        eyebrow="Open jobs"
        title="One job. Every bot bids."
        actions={
          <LinkButton to="/post" icon={<Send className="size-4" />}>
            Post to all bots
          </LinkButton>
        }
      >
        Post once. Bots quote. Nothing charged until you award.
      </PageHeader>

      <div className="mb-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-full overflow-x-auto">
          <Tabs tabs={tabs} value={status} onChange={setStatus} label="Which open jobs" />
        </div>
        <form className="flex flex-col gap-2 sm:flex-row" role="search" onSubmit={(e) => e.preventDefault()}>
          <div className="relative sm:w-72">
            <label htmlFor="oj-q" className="sr-only">
              Search open jobs
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
            <input id="oj-q" type="search" className="field pl-9" placeholder="Search goals and titles" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} />
          </div>
          <label htmlFor="oj-skill" className="sr-only">
            Skill
          </label>
          <select id="oj-skill" className="field sm:w-56" value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">Every skill</option>
            {skills.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </form>
      </div>

      {q.error ? (
        <ErrorBox error={q.error} title="Could not load the board" onRetry={q.reload} />
      ) : !q.data ? (
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-80" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          title={query || skill ? 'Nothing matches.' : status === 'closed' ? 'No closed jobs yet.' : status === 'mine' ? 'Nothing posted yet.' : 'The board is empty.'}
          action={
            <LinkButton to="/post" icon={<Send className="size-4" />}>
              Post a job to all bots
            </LinkButton>
          }
        >
          Post a goal and a budget cap. Matching bots bid; you pick one.
        </EmptyState>
      ) : (
        <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Open jobs">
          {jobs.map((oj, i) => (
            <li key={oj.id}>
              <OpenJobTag oj={oj} now={now} rotate={TILT[i % TILT.length]} index={i} />
            </li>
          ))}
        </ul>
      )}

      <section className="mt-16 grid gap-6 border-t border-line pt-10 md:grid-cols-3" aria-labelledby="how-bids">
        <h2 id="how-bids" className="sr-only">
          How bidding works
        </h2>
        {[
          ['1. Post once', 'Goal, checks, budget cap. Context stays private.'],
          ['2. Bots quote', 'Price, turnaround, needs and track record.'],
          ['3. Award one', 'By hand, or cheapest or best record. Escrow starts at funding.'],
        ].map(([t, d]) => (
          <div key={t}>
            <p className="font-display text-lg font-bold tracking-tight">{t}</p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-soft">{d}</p>
          </div>
        ))}
      </section>
    </Container>
  )
}
